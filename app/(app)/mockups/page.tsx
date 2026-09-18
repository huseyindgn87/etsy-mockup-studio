"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { blobToRaster, dataUrlToBlob, rasterToDataUrl } from "@/lib/mockup/client";
import { compose } from "@/lib/mockup/compose";
import { quadList } from "@/lib/mockup/geometry";
import type { Calibration, Overlay, Quad, Raster } from "@/lib/mockup/types";
import { normalizeBlendMode } from "@/lib/mockup/validate";
import { buildInventoryPayload, validateOfferings } from "@/lib/etsy/variation-offerings";
import { MAX_DRAFT_PSDS } from "@/lib/drafts/constants";
import { publishBlockedBySchedule, scheduleBlocker } from "@/lib/scheduling/publish-guard";
import type { ScheduledListingSummary, ScheduleTimeInput } from "@/lib/scheduling/types";
import ScheduleDialog from "../schedule/ScheduleDialog";
import {
  EDITOR_SECTIONS,
  EditorSectionCard,
  SECTION_SCROLL_OFFSET_VAR,
  compareSections,
  isEditorSection,
  type EditorSection,
} from "./editor-sections";
import { useSectionNav } from "./useSectionNav";
import {
  discardRenderSet,
  prepareScheduleImages,
  uploadScheduleImages,
  type ScheduleImageSource,
} from "./schedule-renders";
import {
  jobKey,
  moveItem,
  publishImageOrder,
  reconcileImageOrder,
  slotIdFor,
  withAltText,
  type ImageSlotRef,
} from "@/app/components/listing-media/photo-order";
import type { EtsyListingMedia } from "@/app/components/listing-media/existing-media";
import { checkPickedVideo } from "@/app/components/listing-media/video-file";
import type { DraftPhotosData, DraftSource } from "@/lib/drafts/types";
import { draftVideoSlots, editorVideoSlots, type RestoredDraftVideoSlot } from "@/lib/drafts/videos";
import { draftSnapshotKey } from "@/lib/drafts/snapshot";
import { useUnsavedChangesGuard } from "@/app/components/unsaved-changes/useUnsavedChangesGuard";
import { howItsMadeError } from "@/lib/etsy/listing-classification";
import { personalizationQuestionsError } from "@/lib/etsy/listing-personalization";
import { MAX_LISTING_IMAGES, checkImageFileBasics } from "@/lib/etsy/listing-image-limits";
import { MAX_LISTING_VIDEOS } from "@/lib/etsy/video-limits";
import { isEmptyPatch } from "@/lib/etsy/bulk-edit";
import { editorSyncPatch } from "@/lib/etsy/editor-sync";
import { describeUnsynced, mediaChanges, mediaStateFromEtsy, mediaStateFromGrid } from "@/lib/etsy/listing-changes";
import { syncListingPatch, writeWithTimeout } from "@/lib/etsy/sync-request";
import { describeJob } from "@/lib/jobs/describe";
import ListingForm, {
  EMPTY_LISTING_FORM,
  type ListingFormValue,
} from "./ListingForm";
import { VARIATION_SUB_TABS } from "./VariationsSection";
import {
  ListingMediaEditor,
  type ListingVideoItem,
  type PhotoSlot,
} from "@/app/components/listing-media/ListingMedia";
import EtsyMark from "@/app/components/EtsyMark";
import { useToast } from "@/app/components/toast/ToastProvider";
import ListingPreviewModal, { type PreviewMediaItem } from "./ListingPreviewModal";
import MockupCanvas from "./MockupCanvas";
import TemplatePicker from "./TemplatePicker";
import {
  TEMPLATE_HEIGHT_HEADER,
  TEMPLATE_WIDTH_HEADER,
  templateRefOf,
  type TemplateListItem,
  type TemplateRef,
} from "@/lib/mockup/template-types";

/** Longest edge of the browser-side preview rasters (the server renders full-res). */
const PREVIEW_MAX = 1400;

interface OverlayMeta {
  file: File;
  raster: Raster; // decoded at the mockup's previewScale
  x: number; // PSD-native px
  y: number;
  blend: string;
  alpha: number;
  clip: boolean;
  name: string;
}

interface MockupItem {
  id: string;
  name: string;
  file: File; // composite PNG, native res, for the batch upload
  psdW: number;
  psdH: number;
  /** sha256 of the source PSD's bytes — the calibration DB key. */
  contentHash: string;
  previewScale: number;
  mockRaster: Raster; // scaled by previewScale
  overlays: OverlayMeta[];
  areaNames: string[];
  calibration: Calibration;
  /** Whether `calibration` came back from a saved DB row (vs. freshly suggested). */
  hasSavedCalibration: boolean;
  include: boolean;
  tone: string | null;
  /**
   * The raw uploaded .psd, kept only so "Save draft" can upload it to R2 in
   * the background — absent for a mockup restored from a draft (its PSD is
   * already stored there; see the draft-upload effect in MockupsPageInner).
   */
  psdFile?: File;
  /** Set for a template: `file` is only its watermarked preview, and renders name the template instead. */
  template?: TemplateRef;
}

/**
 * Builds a `MockupItem` from a PSD parse result — the shape both a fresh
 * upload (`POST /api/mockups/psd`) and a restored draft (`GET /api/drafts/[id]`,
 * which re-runs the same parse server-side) come back as. Shared so restore
 * doesn't drift from the live-upload path.
 */
async function buildMockupItem(params: {
  id: string;
  name: string;
  contentHash: string;
  psdW: number;
  psdH: number;
  composite: string; // data URL
  overlaysIn: { image: string; x: number; y: number; blend: string; alpha: number; clip: boolean; name: string }[];
  areaNames: string[];
  calibration: Calibration;
  hasSavedCalibration: boolean;
  include: boolean;
  tone: string | null;
  psdFile?: File;
}): Promise<MockupItem> {
  const scale = Math.min(1, PREVIEW_MAX / Math.max(params.psdW, params.psdH));
  const compositeBlob = dataUrlToBlob(params.composite);
  const compositeFile = new File([compositeBlob], `${params.name}.png`, { type: "image/png" });
  const mockRaster = await blobToRaster(compositeBlob, { scale });
  const overlays: OverlayMeta[] = await Promise.all(
    params.overlaysIn.map(async (ov) => {
      const blob = dataUrlToBlob(ov.image);
      return {
        file: new File([blob], `${ov.name || "overlay"}.png`, { type: "image/png" }),
        raster: await blobToRaster(blob, { scale }),
        x: ov.x,
        y: ov.y,
        blend: ov.blend,
        alpha: ov.alpha,
        clip: ov.clip,
        name: ov.name,
      };
    }),
  );
  return {
    id: params.id,
    name: params.name,
    file: compositeFile,
    psdW: params.psdW,
    psdH: params.psdH,
    contentHash: params.contentHash,
    previewScale: scale,
    mockRaster,
    overlays,
    areaNames: params.areaNames,
    calibration: params.calibration,
    hasSavedCalibration: params.hasSavedCalibration,
    include: params.include,
    tone: params.tone,
    psdFile: params.psdFile,
  };
}

/** A mockup's overlays, positioned/scaled for compositing at `mockRaster`'s resolution. */
function overlaysForMockup(m: MockupItem): Overlay[] {
  const k = m.previewScale;
  return m.overlays.map((o) => ({
    data: o.raster.data,
    x: Math.round(o.x * k),
    y: Math.round(o.y * k),
    w: o.raster.width,
    h: o.raster.height,
    blend: normalizeBlendMode(o.blend),
    alpha: o.alpha,
    clip: o.clip,
    name: o.name,
  }));
}

interface DesignItem {
  id: string;
  name: string;
  file: File;
  raster: Raster;
  url: string;
}

/**
 * The listing an edit session targets — chosen on the Listings page (its row
 * actions), never in the editor itself. Carried over via URL query params so
 * the editor needs no refetch just to show the title/thumbnail.
 */
interface TargetListing {
  listingId: number;
  title: string;
  thumbnailUrl: string | null;
}

/** Reads the "copy to"/"add to" target straight off the editor URL's `listingId`/`title`/`thumbnailUrl`. */
function targetListingFromParams(params: ReturnType<typeof useSearchParams>): TargetListing | null {
  const listingId = Number.parseInt(params.get("listingId") ?? "", 10);
  if (!Number.isInteger(listingId) || listingId <= 0) return null;
  return {
    listingId,
    title: params.get("title") || `Listing #${listingId}`,
    thumbnailUrl: params.get("thumbnailUrl"),
  };
}

/** Reads the publish mode off the editor URL's `mode` param — "copy"/"existing" need a real
 * target listing, falling back to a blank "new" draft (matching "Create listing") without one. */
function publishModeFromParams(params: ReturnType<typeof useSearchParams>): PublishMode {
  const mode = params.get("mode");
  if (mode !== "copy" && mode !== "existing") return "new";
  return targetListingFromParams(params) ? mode : "new";
}

/** A user-uploaded photo, added straight into the photo grid alongside rendered mockups. */
interface OwnImage {
  id: string;
  file: File;
  url: string;
}


/** The joined value ids a field's `appliesTo`-scoped subset of one combination — matches `ListingForm`'s own key. */
function comboKeyFor(appliesTo: number[], valueIds: number[]): string {
  return appliesTo.map((i) => valueIds[i]).join(":");
}

/**
 * The listing's price, or its range across variation combinations, for the
 * preview modal — "$X.XX" for a single price, "$X.XX+" (Etsy's own
 * convention) once price varies by variation and combos land on more than
 * one value.
 */
function formatPreviewPrice(form: ListingFormValue): string {
  const basePrice = Number.parseFloat(form.price);
  const priceToggle = form.variationToggles.price;
  const variesByPrice = priceToggle.enabled && priceToggle.appliesTo.length > 0 && form.variations.length > 0;

  if (!variesByPrice) {
    return Number.isFinite(basePrice) && basePrice > 0 ? `$${basePrice.toFixed(2)}` : "$0.00";
  }

  let combos: number[][] = [[]];
  for (const dim of form.variations) {
    const next: number[][] = [];
    for (const c of combos) for (const id of dim.valueIds) next.push([...c, id]);
    combos = next;
  }

  const prices = combos.map((valueIds) => {
    const cellKey = comboKeyFor(priceToggle.appliesTo, valueIds);
    const cell = Number.parseFloat(form.variationRows.price[cellKey] ?? "");
    return Number.isFinite(cell) && cell > 0 ? cell : basePrice;
  }).filter((p): p is number => Number.isFinite(p) && p > 0);

  if (prices.length === 0) return "$0.00";
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? `$${min.toFixed(2)}` : `$${min.toFixed(2)}+`;
}

type PublishMode = "existing" | "copy" | "new";

interface PublishResult {
  mode: PublishMode;
  listingId: number;
  createdDraft: boolean;
  uploaded: { name: string; rank: number }[];
  failed: { name: string; error: string }[];
  skipped: number;
  /** An existing listing's photo/video grid was saved onto it (not just appended to). */
  edited: boolean;
}

const SLIDERS = [
  { key: "shade", label: "Fabric shading", min: 0, max: 130 },
  { key: "disp", label: "Wrinkle", min: 0, max: 40 },
  { key: "dispR", label: "Wrinkle smoothing", min: 2, max: 48 },
  { key: "zoom", label: "Print size", min: 40, max: 120 },
  { key: "rot", label: "Rotation", min: -180, max: 180 },
] as const;
type SliderKey = (typeof SLIDERS)[number]["key"];

const uid = () => Math.random().toString(36).slice(2, 10);
const stripExt = (s: string) => s.replace(/\.[^.]+$/, "");


async function errorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (res.status === 401) return "Not connected to Etsy — reconnect from the home page.";
  return body?.error || `Request failed (${res.status})`;
}

/**
 * `useSearchParams()` requires a Suspense boundary in the App Router — the
 * listing (and mode) this editor targets is chosen entirely on the Listings
 * page and carried over as query params, never re-chosen in here.
 */
export default function MockupsPage() {
  return (
    <Suspense fallback={null}>
      <MockupsPageInner />
    </Suspense>
  );
}

function MockupsPageInner() {
  const [mockups, setMockups] = useState<MockupItem[]>([]);
  const [designs, setDesigns] = useState<DesignItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeArea, setActiveArea] = useState(0);
  const [previewDesignId, setPreviewDesignId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  // The target listing and mode are chosen once, on the Listings page (its
  // row actions, or "Create listing" for a blank draft) — read from the URL
  // a single time (mount-only useState initializers, not a live useMemo off
  // `searchParams`, so autosave later appending `draftId` to the URL can't
  // re-derive and reset these). They're state, not a frozen snapshot, only
  // because restoring a saved copy/existing draft (below) needs to override
  // them from the draft's own persisted `source` — the URL alone has nothing
  // to derive them from once resumed via a plain `?draftId=` link.
  const searchParams = useSearchParams();
  const [targetListing, setTargetListing] = useState<TargetListing | null>(() =>
    targetListingFromParams(searchParams),
  );
  const [publishMode, setPublishMode] = useState<PublishMode>(() =>
    publishModeFromParams(searchParams),
  );
  const publishId = targetListing?.listingId ?? null;
  const [listingForm, setListingForm] = useState<ListingFormValue>(EMPTY_LISTING_FORM);
  const [cornerMode, setCornerMode] = useState<"free" | "ratio">("free");
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [shopName, setShopName] = useState<string | null>(null);
  const [currencyCode, setCurrencyCode] = useState<string | null>(null);
  /** Bumped when a refused Publish should open the Variations section's first error. */
  const [variationErrorJump, setVariationErrorJump] = useState(0);
  const [videos, setVideos] = useState<(ListingVideoItem | null)[]>(() => Array(MAX_LISTING_VIDEOS).fill(null));
  const [videoErrors, setVideoErrors] = useState<(string | null)[]>(() =>
    Array(MAX_LISTING_VIDEOS).fill(null),
  );

  const selectVideo = useCallback(async (slot: number, file: File | null) => {
    setVideoErrors((prev) => prev.map((e, i) => (i === slot ? null : e)));
    if (!file) {
      setVideos((prev) => prev.map((v, i) => (i === slot ? null : v)));
      return;
    }
    const videoError = await checkPickedVideo(file);
    if (videoError) {
      setVideoErrors((prev) => prev.map((e, i) => (i === slot ? videoError : e)));
      return;
    }
    setVideos((prev) => prev.map((v, i) => (i === slot ? { kind: "file", id: uid(), file } : v)));
  }, []);

  // ---- photo grid: rendered mockups + user-uploaded photos, one Etsy image slot each ----
  const [ownImages, setOwnImages] = useState<OwnImage[]>([]);
  const [imageOrder, setImageOrder] = useState<ImageSlotRef[]>([]);
  /** Rendered combos the user removed from the grid — kept out of `imageOrder`, persisted with the draft. */
  const [removedJobKeys, setRemovedJobKeys] = useState<string[]>([]);
  const [altTextBySlot, setAltTextBySlot] = useState<Record<string, string>>({});
  const [jobThumbs, setJobThumbs] = useState<Record<string, string>>({});
  /** "existing" mode: the target listing's photos and videos as Etsy has them now — shown as tiles, saved only on Publish. */
  const [etsyMedia, setEtsyMedia] = useState<EtsyListingMedia | null>(null);
  const [etsyMediaError, setEtsyMediaError] = useState<string | null>(null);
  /** Photos already on the listing that the user removed from the grid — persisted with the draft. */
  const [removedEtsyImageIds, setRemovedEtsyImageIds] = useState<number[]>([]);

  // ---- "Save draft" — see the effects below photoSlots, and lib/drafts/* ----
  const router = useRouter();
  // Snapshotted once: saveDraftNow adds `draftId` to the URL itself once it
  // creates one, and that must never be mistaken for "the user navigated to a
  // different saved draft" and re-trigger a restore mid-save (it would fetch
  // the still-blank row and clobber whatever the user just typed).
  const [initialDraftId] = useState(() => searchParams.get("draftId"));
  // Snapshotted once at mount, same idiom as `initialDraftId` above — a
  // "copy" source is chosen on the Listings page and never re-chosen here,
  // so this must stay stable even once autosave adds `draftId` to the URL
  // (which would otherwise change `searchParams`/`targetListing` identity
  // and re-trigger the prefill effect on every save).
  const [copySourceListingId, setCopySourceListingId] = useState(() =>
    searchParams.get("mode") === "copy" && !searchParams.get("draftId")
      ? (Number.parseInt(searchParams.get("listingId") ?? "", 10) || null)
      : null,
  );
  /** The existing listing whose saved fields are being loaded into the form — autosave and the unsaved-changes count wait for it. */
  const [hydrateListingId, setHydrateListingId] = useState<number | null>(() =>
    publishModeFromParams(searchParams) === "existing" && !searchParams.get("draftId")
      ? (targetListingFromParams(searchParams)?.listingId ?? null)
      : null,
  );
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftStatus, setDraftStatus] = useState<"idle" | "restoring" | "saving" | "saved" | "error">(
    initialDraftId ? "restoring" : "idle",
  );
  const headerRef = useRef<HTMLElement>(null);
  const {
    active: activeSection,
    goTo: goToSection,
    scrollOffset,
    setRestoreTarget,
  } = useSectionNav({ ready: draftStatus !== "restoring" && hydrateListingId == null, headerRef });
  /** Set by a save refused for missing/invalid fields — marks those sections in the sidebar until fixed. */
  const [showSectionErrors, setShowSectionErrors] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  /** `${kind}:${itemId}` for every binary file already confirmed uploaded to R2 — drives both what autosave persists and what the upload effect still needs to send. */
  const [uploadedAssetKeys, setUploadedAssetKeys] = useState<Set<string>>(new Set());
  const inFlightUploads = useRef<Set<string>>(new Set());
  /** Set once a restored draft has supplied the video slots, so the listing's own Etsy videos don't replace them. */
  const videosFromDraft = useRef(false);

  // ---- unsaved changes: `editRevision` counts user edits; `committed` is the
  // whole editor state (the draft snapshot) as last loaded, explicitly saved,
  // or written to Etsy. Any difference from it after a user edit is unsaved. ----
  const [editRevision, setEditRevision] = useState(0);
  const [committed, setCommitted] = useState<{
    revision: number;
    snapshot: string | null;
    kind: "load" | "saved" | "published";
  }>({ revision: 0, snapshot: null, kind: "load" });
  /** Wraps a user-edit handler so calling it counts as an edit. */
  const edit =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      setEditRevision((n) => n + 1);
      return fn(...args);
    };
  const gridNoticeShown = useRef(false);
  /** `edit` for the photo/video grid; the first grid edit on an existing listing says when it reaches Etsy. */
  const editGrid =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      if (publishMode === "existing" && !gridNoticeShown.current) {
        gridNoticeShown.current = true;
        toast.show({
          id: "existing-grid-notice",
          kind: "info",
          message: `The listing's photos and videos become exactly what the grid shows, in that order, when you press Save to Etsy (anything past the ${MAX_LISTING_IMAGES}-image limit is skipped). Nothing on Etsy changes before that.`,
        });
      }
      return edit(fn)(...args);
    };

  const addOwnImages = useCallback((files: File[]): string[] => {
    setError(null);
    const added: OwnImage[] = [];
    for (const file of files) {
      const basicsError = checkImageFileBasics(file);
      if (basicsError) {
        setError(`${file.name}: ${basicsError}`);
        continue;
      }
      added.push({ id: uid(), file, url: URL.createObjectURL(file) });
    }
    if (added.length) setOwnImages((prev) => [...prev, ...added]);
    return added.map((o) => o.id);
  }, []);

  const removeOwnImage = useCallback((id: string) => {
    setOwnImages((prev) => {
      const found = prev.find((o) => o.id === id);
      if (found) URL.revokeObjectURL(found.url);
      return prev.filter((o) => o.id !== id);
    });
    setImageOrder((prev) => prev.filter((r) => !(r.kind === "own" && r.id === id)));
    setAltTextBySlot((prev) => {
      const next = { ...prev };
      delete next[`own:${id}`];
      return next;
    });
  }, []);

  function removeImageSlot(slotId: string) {
    const ref = imageOrder.find((r) => slotIdFor(r) === slotId);
    if (!ref) return;
    if (ref.kind === "own") {
      removeOwnImage(ref.id);
      return;
    }
    if (ref.kind === "job") {
      setRemovedJobKeys((prev) => (prev.includes(ref.key) ? prev : [...prev, ref.key]));
    } else {
      setRemovedEtsyImageIds((prev) => (prev.includes(ref.imageId) ? prev : [...prev, ref.imageId]));
    }
    setImageOrder((prev) => prev.filter((r) => slotIdFor(r) !== slotId));
    setAltTextBySlot((prev) => {
      const next = { ...prev };
      delete next[slotId];
      return next;
    });
  }

  function setAltText(slotId: string, text: string) {
    setAltTextBySlot((prev) => withAltText(prev, slotId, text));
  }

  function moveImageSlot(from: number, to: number) {
    setImageOrder((prev) => moveItem(prev, from, to));
  }

  function moveVideoSlot(from: number, to: number) {
    setVideos((prev) => moveItem(prev, from, to));
    setVideoErrors((prev) => moveItem(prev, from, to));
  }

  // ---- "existing" mode: the listing's current photos and videos, as tiles ----
  // Read-only (GET) — what the grid starts from. Nothing is written to the
  // listing until Save to Etsy sends the whole grid.
  useEffect(() => {
    if (publishMode !== "existing" || publishId == null) return;
    const controller = new AbortController();
    fetch(`/api/etsy/listings/bulk?ids=${publishId}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorFrom(res));
        return (await res.json()) as { listings: EtsyListingMedia[] };
      })
      .then((body) => {
        if (controller.signal.aborted) return;
        const listing = body.listings[0];
        if (!listing) throw new Error("This listing could not be loaded — refresh the shop and try again.");
        setEtsyMediaError(null);
        setEtsyMedia({ images: listing.images, videos: listing.videos });
        setVideos((prev) => {
          if (videosFromDraft.current || prev.some((v) => v)) return prev;
          const next: (ListingVideoItem | null)[] = listing.videos
            .slice(0, MAX_LISTING_VIDEOS)
            .map((v) => ({ kind: "etsy", videoId: v.videoId, videoUrl: v.videoUrl, thumbnailUrl: v.thumbnailUrl }));
          while (next.length < MAX_LISTING_VIDEOS) next.push(null);
          return next;
        });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setEtsyMediaError(
          `Couldn't load this listing's current photos, so nothing can be saved to it yet: ${
            err instanceof Error ? err.message : "request failed"
          }`,
        );
      });
    return () => controller.abort();
  }, [publishMode, publishId]);

  // Each Etsy photo's own alt text, unless a restored draft already holds an edit of it.
  useEffect(() => {
    if (!etsyMedia || draftStatus === "restoring") return;
    // Seeding derived state once both sources have settled.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAltTextBySlot((prev) => {
      let next = prev;
      for (const img of etsyMedia.images) {
        const slotId = `etsy:${img.imageId}`;
        if (!(slotId in next)) next = { ...next, [slotId]: img.altText };
      }
      return next;
    });
  }, [etsyMedia, draftStatus]);

  const psdInput = useRef<HTMLInputElement>(null);
  const designInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/etsy/shop")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { shopName?: string; currencyCode?: string | null } | null) => {
        setShopName(body?.shopName ?? null);
        setCurrencyCode(body?.currencyCode ?? null);
      })
      .catch(() => {
        /* not connected / no shop — header falls back to a placeholder */
      });
  }, []);

  const active = mockups.find((m) => m.id === activeId) ?? null;
  const previewDesign =
    designs.find((d) => d.id === previewDesignId) ?? designs[0] ?? null;

  const previewOverlays = useMemo<Overlay[]>(
    () => (active ? overlaysForMockup(active) : []),
    [active],
  );

  const addPsds = useCallback(async (files: File[]) => {
    const psds = files.filter((f) => /\.psd$/i.test(f.name));
    if (!psds.length) return;
    if (mockups.length >= MAX_DRAFT_PSDS) {
      setError(`A draft can hold at most ${MAX_DRAFT_PSDS} PSDs.`);
      return;
    }
    setError(null);
    const added: MockupItem[] = [];
    for (let i = 0; i < psds.length && mockups.length + added.length < MAX_DRAFT_PSDS; i++) {
      setBusy(`Reading PSD (${i + 1}/${psds.length})`);
      const file = psds[i];
      try {
        const fd = new FormData();
        fd.set("psd", file);
        const res = await fetch("/api/mockups/psd", { method: "POST", body: fd });
        if (!res.ok) throw new Error(await errorFrom(res));
        const body = (await res.json()) as {
          psd: { width: number; height: number };
          contentHash: string;
          composite: string;
          areaNames: string[];
          overlays: {
            image: string;
            x: number;
            y: number;
            blend: string;
            alpha: number;
            clip: boolean;
            name: string;
          }[];
          tone: { tone: string | null };
          suggestedCalibration: Calibration;
          savedCalibration: Calibration | null;
        };

        added.push(
          await buildMockupItem({
            id: uid(),
            name: stripExt(file.name),
            contentHash: body.contentHash,
            psdW: body.psd.width,
            psdH: body.psd.height,
            composite: body.composite,
            overlaysIn: body.overlays,
            areaNames: body.areaNames ?? [],
            calibration: body.savedCalibration ?? body.suggestedCalibration,
            hasSavedCalibration: !!body.savedCalibration,
            include: true,
            tone: body.tone?.tone ?? null,
            psdFile: file,
          }),
        );
      } catch (err) {
        setError(`${file.name}: ${err instanceof Error ? err.message : "could not be read"}`);
      }
    }
    if (added.length) {
      setMockups((prev) => [...prev, ...added]);
      setActiveId((cur) => cur ?? added[0].id);
    }
    setBusy(null);
  }, [mockups.length]);

  /**
   * Adds a curated library or user-uploaded template (see `TemplatePicker`) as
   * a mockup — same `MockupItem` shape a parsed PSD builds, just with no
   * overlays and a calibration seeded from the template's own saved quad.
   * `contentHash` is `template:{filename}` (filenames are globally unique
   * across both library and user templates) so "Save calibration" persists
   * per-session tweaks the same way a PSD's does, without touching the
   * template's own saved quad.
   */
  const addFromTemplate = useCallback(
    async (template: TemplateListItem) => {
      if (mockups.length >= MAX_DRAFT_PSDS) {
        setError(`A draft can hold at most ${MAX_DRAFT_PSDS} PSDs.`);
        return;
      }
      setError(null);
      setShowTemplatePicker(false);
      setBusy("Loading template…");
      try {
        const ref = templateRefOf(template);
        if (!ref) throw new Error("This template can't be used yet.");
        const res = await fetch(template.imageUrl);
        if (!res.ok) throw new Error("Could not load the template image.");
        const blob = await res.blob();
        const file = new File([blob], `${template.name || "template"}.jpg`, { type: blob.type || "image/jpeg" });
        const previewRaster = await blobToRaster(blob);
        const previewScale = Math.min(1, PREVIEW_MAX / Math.max(previewRaster.width, previewRaster.height));
        const mockRaster = previewScale === 1 ? previewRaster : await blobToRaster(blob, { scale: previewScale });
        const nativeW = Number(res.headers.get(TEMPLATE_WIDTH_HEADER)) || previewRaster.width;
        const nativeH = Number(res.headers.get(TEMPLATE_HEIGHT_HEADER)) || previewRaster.height;
        const scale = mockRaster.width / nativeW;
        const calibration: Calibration = {
          qs: [template.quad],
          q: template.quad,
          ai: 0,
          shade: 15,
          disp: 10,
          dispR: 12,
          zoom: 100,
          rot: 0,
          b1: 0,
          b2: 0,
          w1: 255,
          w2: 255,
        };
        const item: MockupItem = {
          id: uid(),
          name: template.name || stripExt(file.name),
          file,
          psdW: nativeW,
          psdH: nativeH,
          contentHash: `template:${template.filename}`,
          previewScale: scale,
          mockRaster,
          overlays: [],
          areaNames: [],
          calibration,
          hasSavedCalibration: template.calibrated,
          include: true,
          tone: null,
          template: ref,
        };
        setMockups((prev) => [...prev, item]);
        setActiveId(item.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not add the template.");
      } finally {
        setBusy(null);
      }
    },
    [mockups.length],
  );

  const addDesigns = useCallback(async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    const added: DesignItem[] = [];
    for (let i = 0; i < imgs.length; i++) {
      setBusy(`Reading design (${i + 1}/${imgs.length})`);
      const file = imgs[i];
      try {
        added.push({
          id: uid(),
          name: stripExt(file.name),
          file,
          raster: await blobToRaster(file, { maxSide: 1600 }),
          url: URL.createObjectURL(file),
        });
      } catch {
        setError(`${file.name}: image could not be read`);
      }
    }
    if (added.length) {
      setDesigns((prev) => [...prev, ...added]);
      setPreviewDesignId((cur) => cur ?? added[0].id);
    }
    setBusy(null);
  }, []);

  /** Reorders the mockup list — this drives both the display order and the render/upload job order. */
  const moveMockup = useCallback((from: number, to: number) => {
    setMockups((prev) => {
      if (to < 0 || to >= prev.length || from === to) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }, []);

  const deleteMockup = useCallback(
    (id: string) => {
      setMockups((prev) => prev.filter((m) => m.id !== id));
      setActiveId((cur) => {
        if (cur !== id) return cur;
        const remaining = mockups.filter((m) => m.id !== id);
        return remaining[0]?.id ?? null;
      });
      setActiveArea(0);
    },
    [mockups],
  );

  const patchCalibration = useCallback(
    (id: string, fn: (c: Calibration) => Calibration) => {
      setMockups((prev) =>
        prev.map((m) => (m.id === id ? { ...m, calibration: fn(m.calibration) } : m)),
      );
    },
    [],
  );

  const onAreaChange = useCallback(
    (area: number, quad: Quad) => {
      if (!activeId) return;
      patchCalibration(activeId, (c) => {
        const qs = quadList(c).map((q) => q.map((p) => [...p]) as Quad);
        qs[area] = quad;
        return { ...c, qs, q: qs[0] };
      });
    },
    [activeId, patchCalibration],
  );

  const onSlider = useCallback(
    (key: SliderKey, value: number) => {
      if (!activeId) return;
      patchCalibration(activeId, (c) => ({ ...c, [key]: value }));
    },
    [activeId, patchCalibration],
  );

  const [calibrationNote, setCalibrationNote] = useState<string | null>(null);
  const saveActiveCalibration = useCallback(async () => {
    if (!active) return;
    setCalibrationNote("Saving…");
    try {
      const res = await fetch("/api/mockups/calibrations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contentHash: active.contentHash,
          calibration: active.calibration,
        }),
      });
      if (!res.ok) throw new Error(await errorFrom(res));
      setMockups((prev) =>
        prev.map((m) => (m.id === active.id ? { ...m, hasSavedCalibration: true } : m)),
      );
      setCalibrationNote("Saved ✓");
    } catch (err) {
      setCalibrationNote(err instanceof Error ? err.message : "Could not be saved.");
    }
  }, [active]);

  const included = useMemo(() => mockups.filter((m) => m.include), [mockups]);
  const jobCount = included.length * designs.length;

  /** Every rendered mockup×design combo, in the app's default (mockup-major) order. */
  const currentJobRefs = useMemo<{ kind: "job"; key: string }[]>(
    () =>
      included.flatMap((m) => designs.map((d) => ({ kind: "job" as const, key: jobKey(m.id, d.id) }))),
    [included, designs],
  );

  // Keeps `imageOrder` (the photo grid's slot order, and the eventual Etsy
  // upload/rank order) in sync as mockups/designs/own-images are added or
  // removed: refs that are still valid keep their position (so a manual drag
  // reorder survives), newly-appeared jobs/own images are appended at the
  // end, and refs pointing at something removed are dropped. A rendered combo
  // removed from the grid stays out until its mockup or design is re-added.
  useEffect(() => {
    // Reconciling derived state against two other state values (not a DOM/
    // external-system sync) — an intentional synchronous update.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setImageOrder((prev) =>
      reconcileImageOrder(
        prev,
        currentJobRefs.map((r) => r.key),
        ownImages.map((o) => o.id),
        new Set(removedJobKeys),
        etsyMedia ? etsyMedia.images.map((img) => img.imageId) : null,
        new Set(removedEtsyImageIds),
      ),
    );
  }, [currentJobRefs, ownImages, removedJobKeys, etsyMedia, removedEtsyImageIds]);

  // Thumbnails for the photo grid: a small composite per mockup×design combo,
  // using the same `compose()` core as the live editor preview and the server
  // render. Debounced since a slider drag can touch every combo sharing that
  // mockup, and there can be up to `MAX_LISTING_IMAGES` of them.
  const THUMB_MAX_SIDE = 480;
  useEffect(() => {
    if (included.length === 0 || designs.length === 0) {
      // Clearing stale thumbnails synchronously — an intentional reset.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setJobThumbs({});
      return;
    }
    const t = setTimeout(() => {
      const next: Record<string, string> = {};
      for (const m of included) {
        const overlays = overlaysForMockup(m);
        const s = Math.min(1, THUMB_MAX_SIDE / Math.max(m.mockRaster.width, m.mockRaster.height));
        const w = Math.max(1, Math.round(m.mockRaster.width * s));
        const h = Math.max(1, Math.round(m.mockRaster.height * s));
        for (const d of designs) {
          const out = compose(
            { mock: m.mockRaster, design: d.raster, perArea: null, calibration: m.calibration, overlays },
            w,
            h,
          );
          next[jobKey(m.id, d.id)] = rasterToDataUrl(out);
        }
      }
      setJobThumbs(next);
    }, 150);
    return () => clearTimeout(t);
  }, [included, designs]);

  const photoSlots = useMemo<PhotoSlot[]>(
    () =>
      imageOrder.map((ref) => {
        const slotId = slotIdFor(ref);
        if (ref.kind === "job") {
          const [mockupId, designId] = ref.key.split("::");
          const m = included.find((x) => x.id === mockupId);
          const d = designs.find((x) => x.id === designId);
          return {
            slotId,
            ref,
            thumbnailUrl: jobThumbs[ref.key] ?? null,
            label: m && d ? `${d.name} × ${m.name}` : "Rendering…",
          };
        }
        if (ref.kind === "etsy") {
          const img = etsyMedia?.images.find((i) => i.imageId === ref.imageId);
          return { slotId, ref, thumbnailUrl: img?.url ?? null, label: `Etsy photo ${img?.rank ?? ""}`.trim() };
        }
        const own = ownImages.find((o) => o.id === ref.id);
        return { slotId, ref, thumbnailUrl: own?.url ?? null, label: own?.file.name ?? "Photo" };
      }),
    [imageOrder, jobThumbs, included, designs, ownImages, etsyMedia],
  );
  const publishCount = Math.min(photoSlots.length, MAX_LISTING_IMAGES);
  const photoSlotIds = useMemo(() => photoSlots.map((s) => s.slotId), [photoSlots]);

  // Photos + videos, in the same rail order the preview modal shows them —
  // only built while the modal is open, so opening it is what creates the
  // (otherwise-unrevoked) video object URLs, not every render.
  const previewMedia = useMemo<PreviewMediaItem[]>(() => {
    if (!showPreview) return [];
    const photos: PreviewMediaItem[] = photoSlots.map((s) => ({
      id: s.slotId,
      kind: "photo",
      url: s.thumbnailUrl,
      label: s.label,
    }));
    const vids: PreviewMediaItem[] = videos
      .map((v, i): PreviewMediaItem | null =>
        v
          ? {
              id: `video:${i}`,
              kind: "video",
              url: v.kind === "file" ? URL.createObjectURL(v.file) : v.videoUrl,
              label: `Video ${i + 1}`,
            }
          : null,
      )
      .filter((x): x is PreviewMediaItem => x != null);
    return [...photos, ...vids];
  }, [showPreview, photoSlots, videos]);

  // ---- restore a saved draft named in the URL (?draftId=...), once ----
  useEffect(() => {
    if (!initialDraftId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/drafts/${initialDraftId}`);
        if (!res.ok) throw new Error(await errorFrom(res));
        const body = (await res.json()) as {
          id: string;
          formData: ListingFormValue;
          source: DraftSource | null;
          activeTab: string;
          imageOrder: ImageSlotRef[];
          removedJobKeys?: string[];
          removedEtsyImageIds?: number[];
          altTextBySlot: Record<string, string>;
          videos?: RestoredDraftVideoSlot[] | null;
          mockups: {
            id: string;
            name: string;
            contentHash: string;
            include: boolean;
            calibration: Calibration;
            psd: { width: number; height: number };
            composite: string;
            overlays: {
              image: string;
              x: number;
              y: number;
              blend: string;
              alpha: number;
              clip: boolean;
              name: string;
            }[];
            areaNames: string[];
            tone: string | null;
          }[];
          designs: { id: string; name: string; url: string }[];
          ownImages: { id: string; name: string; url: string }[];
        };
        if (cancelled) return;

        const restoredMockups = await Promise.all(
          body.mockups.map((m) =>
            buildMockupItem({
              id: m.id,
              name: m.name,
              contentHash: m.contentHash,
              psdW: m.psd.width,
              psdH: m.psd.height,
              composite: m.composite,
              overlaysIn: m.overlays,
              areaNames: m.areaNames,
              calibration: m.calibration,
              hasSavedCalibration: true,
              include: m.include,
              tone: m.tone,
            }),
          ),
        );
        const restoredDesigns: DesignItem[] = [];
        for (const d of body.designs) {
          const r = await fetch(d.url);
          if (!r.ok) continue;
          const blob = await r.blob();
          const file = new File([blob], d.name, { type: blob.type || "image/png" });
          restoredDesigns.push({
            id: d.id,
            name: d.name,
            file,
            raster: await blobToRaster(file, { maxSide: 1600 }),
            url: URL.createObjectURL(file),
          });
        }
        const restoredOwn: OwnImage[] = [];
        for (const o of body.ownImages) {
          const r = await fetch(o.url);
          if (!r.ok) continue;
          const blob = await r.blob();
          const file = new File([blob], o.name, { type: blob.type || "image/jpeg" });
          restoredOwn.push({ id: o.id, file, url: URL.createObjectURL(file) });
        }
        const restoredVideos = body.videos
          ? await editorVideoSlots(body.videos, async (url, name) => {
              const r = await fetch(url);
              if (!r.ok) return null;
              const blob = await r.blob();
              return new File([blob], name, { type: blob.type || "video/mp4" });
            })
          : null;
        if (cancelled) return;

        setListingForm({ ...EMPTY_LISTING_FORM, ...body.formData });
        // Restores the copy/edit identity the draft was saved with — makes
        // this resumed session behave exactly like the original copy/existing
        // flow (category/shipping borrowed from the source at publish time,
        // same validation skips, same "Copy of ..."/"Adding to ..." header)
        // instead of silently degrading to a from-scratch "new" draft just
        // because the URL itself only carries `?draftId=`.
        if (body.source) {
          setPublishMode(body.source.mode);
          setTargetListing({
            listingId: body.source.listingId,
            title: body.formData?.title || `Listing #${body.source.listingId}`,
            thumbnailUrl: null,
          });
        }
        setRestoreTarget(isEditorSection(body.activeTab) ? body.activeTab : null);
        setAltTextBySlot(body.altTextBySlot ?? {});
        setImageOrder(body.imageOrder ?? []);
        setRemovedJobKeys(body.removedJobKeys ?? []);
        setRemovedEtsyImageIds(body.removedEtsyImageIds ?? []);
        // A copy made from the listings page's bulk Copy is saved before it
        // was ever opened — fill it from its source listing the first time.
        if (
          body.source?.mode === "copy" &&
          !body.formData?.title &&
          body.mockups.length === 0 &&
          body.designs.length === 0 &&
          body.ownImages.length === 0
        ) {
          setCopySourceListingId(body.source.listingId);
        }
        if (body.source?.mode === "existing" && !body.formData?.title) {
          setHydrateListingId(body.source.listingId);
        }
        setMockups(restoredMockups);
        setDesigns(restoredDesigns);
        setOwnImages(restoredOwn);
        if (restoredVideos) {
          videosFromDraft.current = true;
          setVideos(restoredVideos);
          setVideoErrors(Array(MAX_LISTING_VIDEOS).fill(null));
        }
        setActiveId(restoredMockups[0]?.id ?? null);
        setPreviewDesignId(restoredDesigns[0]?.id ?? null);

        const keys = new Set<string>();
        for (const m of restoredMockups) keys.add(`psd:${m.id}`);
        for (const d of restoredDesigns) keys.add(`design:${d.id}`);
        for (const o of restoredOwn) keys.add(`own:${o.id}`);
        for (const v of restoredVideos ?? []) if (v?.kind === "file" && v.id) keys.add(`video:${v.id}`);
        setUploadedAssetKeys(keys);

        setDraftId(body.id);
        setDraftStatus("saved");
      } catch (err) {
        if (cancelled) return;
        setDraftStatus("error");
        setDraftError(err instanceof Error ? err.message : "Could not load the saved draft.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs once for the draftId given in the URL at mount — a draft is never
    // re-chosen mid-session. May call setPublishMode/setTargetListing once,
    // above, to restore a saved copy/existing identity; neither is otherwise
    // touched again after mount.
  }, [initialDraftId, setRestoreTarget]);

  // ---- "existing" mode: the listing's saved fields, from the listings cache, once ----
  useEffect(() => {
    if (hydrateListingId == null) return;
    const controller = new AbortController();
    fetch(`/api/etsy/listings/${hydrateListingId}/editor`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorFrom(res));
        return (await res.json()) as { form: ListingFormValue; warning: string | null };
      })
      .then((body) => {
        if (controller.signal.aborted) return;
        setListingForm({ ...EMPTY_LISTING_FORM, ...body.form });
        if (body.warning) setError(body.warning);
        setHydrateListingId(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(`Couldn't load this listing's details: ${err instanceof Error ? err.message : "request failed"}`);
        setHydrateListingId(null);
      });
    return () => controller.abort();
  }, [hydrateListingId]);

  // ---- "copy" mode: prefill title/description/tags/price/section/photos
  // from the source listing, once. GET-only (`getListingCopySource`) — the
  // source listing is only ever read, never written back to. Skipped when
  // restoring an already-saved copy draft (its own saved form/photos win).
  useEffect(() => {
    if (copySourceListingId == null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/etsy/listings/${copySourceListingId}/copy-source`);
        if (!res.ok) throw new Error(await errorFrom(res));
        const src = (await res.json()) as {
          title: string;
          description: string;
          tags: string[];
          price: number | null;
          shopSectionId: number | null;
          images: { dataUrl: string; fileName: string; altText?: string }[];
        };
        if (cancelled) return;

        setListingForm((prev) => ({
          ...prev,
          title: src.title || prev.title,
          description: src.description,
          tags: src.tags,
          price: src.price != null ? src.price.toFixed(2) : prev.price,
          shopSectionId: src.shopSectionId,
        }));

        const files: File[] = [];
        const altTexts: string[] = [];
        for (const img of src.images) {
          const r = await fetch(img.dataUrl);
          const blob = await r.blob();
          files.push(new File([blob], img.fileName, { type: blob.type || "image/jpeg" }));
          altTexts.push(img.altText ?? "");
        }
        if (!cancelled && files.length > 0) {
          const ids = addOwnImages(files);
          if (ids.length === files.length) {
            setAltTextBySlot((prev) => {
              let next = prev;
              ids.forEach((id, i) => {
                if (altTexts[i]) next = withAltText(next, `own:${id}`, altTexts[i]);
              });
              return next;
            });
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load the listing to copy.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [copySourceListingId, addOwnImages]);

  // ---- background upload: every mockup/design/own-image not yet in R2 ----
  const [retryTick, setRetryTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setRetryTick((n) => n + 1), 8000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!draftId || draftStatus === "restoring") return;
    async function uploadOne(kind: "psd" | "design" | "own" | "video", itemId: string, file: File) {
      const mapKey = `${kind}:${itemId}`;
      if (uploadedAssetKeys.has(mapKey) || inFlightUploads.current.has(mapKey)) return;
      inFlightUploads.current.add(mapKey);
      try {
        const res = await fetch(`/api/drafts/${draftId}/assets/${kind}/${itemId}`, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        if (res.ok) setUploadedAssetKeys((prev) => new Set(prev).add(mapKey));
      } catch {
        // left pending — the next retry tick (or a relevant state change) tries again
      } finally {
        inFlightUploads.current.delete(mapKey);
      }
    }
    for (const m of mockups) if (m.psdFile) void uploadOne("psd", m.id, m.psdFile);
    for (const d of designs) void uploadOne("design", d.id, d.file);
    for (const o of ownImages) void uploadOne("own", o.id, o.file);
    for (const v of videos) if (v?.kind === "file" && v.id) void uploadOne("video", v.id, v.file);
  }, [mockups, designs, ownImages, videos, draftId, draftStatus, uploadedAssetKeys, retryTick]);

  /** True once the editor has anything worth saving — avoids creating a draft row for a blank, untouched session. */
  const hasDraftableContent = useCallback(
    () =>
      listingForm.title.trim() !== "" ||
      listingForm.description.trim() !== "" ||
      listingForm.tags.length > 0 ||
      mockups.length > 0 ||
      designs.length > 0 ||
      ownImages.length > 0 ||
      videos.some((v) => v) ||
      editRevision > 0,
    [listingForm, mockups.length, designs.length, ownImages.length, videos, editRevision],
  );

  /** What a draft save writes (bar the thumbnail) — compared by value to tell a real change from a re-render. */
  const draftPayload = useMemo(() => {
    const photosData: DraftPhotosData = {
      mockups: mockups
        .filter((m) => uploadedAssetKeys.has(`psd:${m.id}`))
        .map((m) => ({
          id: m.id,
          name: m.name,
          contentHash: m.contentHash,
          calibration: m.calibration,
          include: m.include,
        })),
      designs: designs
        .filter((d) => uploadedAssetKeys.has(`design:${d.id}`))
        .map((d) => ({ id: d.id, name: d.name })),
      ownImages: ownImages
        .filter((o) => uploadedAssetKeys.has(`own:${o.id}`))
        .map((o) => ({ id: o.id, name: o.file.name })),
      imageOrder,
      removedJobKeys,
      removedEtsyImageIds,
      altTextBySlot,
      activeTab: activeSection,
      videos: draftVideoSlots(videos, (videoId) => uploadedAssetKeys.has(`video:${videoId}`)),
    };

    // Persisted with the draft itself (not just the editor URL) so
    // resuming from "My drafts" still knows this is a copy/edit — see the
    // restore effect above, which reads it back as `body.source`.
    const source: DraftSource | null =
      (publishMode === "copy" || publishMode === "existing") && targetListing
        ? { mode: publishMode, listingId: targetListing.listingId }
        : null;

    return { title: listingForm.title, formData: listingForm, photosData, source };
  }, [
    mockups,
    designs,
    ownImages,
    uploadedAssetKeys,
    imageOrder,
    removedJobKeys,
    removedEtsyImageIds,
    altTextBySlot,
    activeSection,
    videos,
    listingForm,
    publishMode,
    targetListing,
  ]);
  // Which section is scrolled into view is saved with the draft but isn't a change worth autosaving.
  const draftSnapshot = useMemo(
    () => draftSnapshotKey({ ...draftPayload, photosData: { ...draftPayload.photosData, activeTab: undefined } }),
    [draftPayload],
  );
  /** The content last saved — or, until the first user edit, the content as loaded. Autosave only runs when it differs. */
  const lastSavedSnapshot = useRef<string | null>(null);
  const loadSettled = draftStatus !== "restoring" && hydrateListingId == null;

  /**
   * Saves now. Resolves to the draft's id, or `null` when there was nothing to
   * save or saving failed. Only an `explicit` save — the Save draft button, a
   * schedule, the unsaved-changes dialog — clears the unsaved-changes flag: the
   * debounced autosave is a safety net, not the user saying they are done.
   */
  const saveDraftNow = useCallback(async ({ explicit = false } = {}): Promise<string | null> => {
    if (!loadSettled) return null;
    if (!draftId && !hasDraftableContent()) return null;
    setDraftStatus("saving");
    try {
      let id = draftId;
      if (!id) {
        const res = await fetch("/api/drafts", { method: "POST" });
        if (!res.ok) throw new Error(await errorFrom(res));
        const created = (await res.json()) as { id: string };
        id = created.id;
        setDraftId(id);
        const params = new URLSearchParams(searchParams.toString());
        params.set("draftId", id);
        router.replace(`/mockups?${params.toString()}`, { scroll: false });
      }

      // Best-effort thumbnail — whatever the first photo-grid slot shows right now.
      let hasThumbnail: boolean | undefined;
      const firstThumb = photoSlots[0]?.thumbnailUrl;
      if (firstThumb) {
        try {
          const blob = await fetch(firstThumb).then((r) => r.blob());
          const put = await fetch(`/api/drafts/${id}/assets/thumbnail/thumb`, {
            method: "PUT",
            headers: { "Content-Type": blob.type || "image/png" },
            body: blob,
          });
          hasThumbnail = put.ok;
        } catch {
          hasThumbnail = undefined; // leave whatever the draft already has
        }
      }

      const res = await fetch(`/api/drafts/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...draftPayload,
          ...(hasThumbnail !== undefined ? { hasThumbnail } : {}),
        }),
      });
      if (!res.ok) throw new Error(await errorFrom(res));
      lastSavedSnapshot.current = draftSnapshot;
      setDraftStatus("saved");
      setDraftError(null);
      if (explicit) setCommitted({ revision: editRevision, snapshot: draftSnapshot, kind: "saved" });
      return id;
    } catch (err) {
      setDraftStatus("error");
      setDraftError(err instanceof Error ? err.message : "Could not save draft.");
      return null;
    }
  }, [
    loadSettled,
    draftId,
    hasDraftableContent,
    photoSlots,
    draftPayload,
    draftSnapshot,
    editRevision,
    router,
    searchParams,
  ]);

  const saveDraftRef = useRef(saveDraftNow);
  useEffect(() => {
    saveDraftRef.current = saveDraftNow;
  }, [saveDraftNow]);

  const hasPendingUploads =
    mockups.some((m) => m.psdFile && !uploadedAssetKeys.has(`psd:${m.id}`)) ||
    designs.some((d) => !uploadedAssetKeys.has(`design:${d.id}`)) ||
    ownImages.some((o) => !uploadedAssetKeys.has(`own:${o.id}`)) ||
    videos.some((v) => v?.kind === "file" && !(v.id && uploadedAssetKeys.has(`video:${v.id}`)));
  // Until the next user edit, state that settles on its own (seeding, reconciling,
  // uploads finishing) belongs to what was committed, not to a change.
  useEffect(() => {
    if (!loadSettled || editRevision !== committed.revision || draftSnapshot === committed.snapshot) return;
    // Following derived state until the user edits — an intentional sync.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCommitted((prev) => ({ ...prev, snapshot: draftSnapshot }));
  }, [loadSettled, editRevision, committed.revision, committed.snapshot, draftSnapshot]);
  const publishedNow = committed.kind === "published" && editRevision === committed.revision;
  const hasUnsavedChanges =
    loadSettled &&
    editRevision > 0 &&
    ((editRevision !== committed.revision && draftSnapshot !== committed.snapshot) ||
      (hasPendingUploads && !publishedNow));
  const saveFromGuard = useCallback(async () => (await saveDraftRef.current({ explicit: true })) != null, []);
  const { dialog: unsavedDialog } = useUnsavedChangesGuard(hasUnsavedChanges ? 1 : 0, {
    onSave: saveFromGuard,
    saveLabel: "Save draft and leave",
  });

  // ---- autosave, debounced so a closed tab doesn't lose the work ----
  // Only after a user edit, and only when the content differs from what was
  // loaded or last saved: opening a listing or draft never writes it back.
  useEffect(() => {
    if (loadSettled && editRevision === 0) lastSavedSnapshot.current = draftSnapshot;
  }, [loadSettled, editRevision, draftSnapshot]);
  useEffect(() => {
    if (!loadSettled || editRevision === 0 || draftSnapshot === lastSavedSnapshot.current) return;
    const t = setTimeout(() => {
      void saveDraftRef.current();
    }, 2000);
    return () => clearTimeout(t);
  }, [loadSettled, editRevision, draftSnapshot]);

  const buildBatchForm = useCallback(
    (publishTo?: Record<string, unknown>) => {
      const fd = new FormData();
      const overlayBase: number[] = [];
      let flat = 0;
      for (const m of included) {
        overlayBase.push(flat);
        for (const ov of m.overlays) {
          fd.append("overlay", ov.file);
          flat++;
        }
      }
      for (const m of included) if (!m.template) fd.append("mockup", m.file);
      for (const d of designs) fd.append("design", d.file);

      const jobs = included.flatMap((m, i) =>
        designs.map((d, k) => ({
          mockup: i,
          design: k,
          altText: publishTo ? altTextBySlot[`job:${jobKey(m.id, d.id)}`] || undefined : undefined,
        })),
      );

      const payload: Record<string, unknown> = {
        format: "jpeg" as const,
        targetMB: [1.2, 1.7] as [number, number],
        namePattern: "{design}_{mockup}",
        mockups: included.map((m, i) => ({
          name: m.name,
          width: m.psdW,
          height: m.psdH,
          calibration: m.calibration,
          ...(m.template ? { template: m.template } : {}),
          overlays: m.overlays.map((o, j) => ({
            file: overlayBase[i] + j,
            x: o.x,
            y: o.y,
            blend: o.blend,
            alpha: o.alpha,
            clip: o.clip,
            name: o.name,
          })),
        })),
        designs: designs.map((d) => ({ name: d.name })),
        jobs,
        ...(publishTo ? { publishTo } : {}),
      };

      if (publishTo) {
        for (const o of ownImages) fd.append("ownImage", o.file);
        payload.ownImages = ownImages.map((o) => ({
          name: o.file.name,
          altText: altTextBySlot[`own:${o.id}`] || undefined,
        }));

        // Map each grid slot (stable key/id) to the numeric job/own-image
        // index the server payload above just built, in display order — this
        // is what turns a drag reorder into the actual Etsy rank order.
        payload.imageOrder = publishImageOrder(
          imageOrder,
          included.map((m) => m.id),
          designs.map((d) => d.id),
          ownImages.map((o) => o.id),
          altTextBySlot,
        );

        // The video tiles, in slot order: files picked here are sent as
        // `video` parts, a video already on the listing by its Etsy id.
        let fileIndex = 0;
        const videoOrder: ({ kind: "existing"; videoId: number } | { kind: "new"; index: number })[] = [];
        for (const v of videos) {
          if (!v) continue;
          if (v.kind === "etsy") {
            videoOrder.push({ kind: "existing", videoId: v.videoId });
          } else {
            fd.append("video", v.file);
            videoOrder.push({ kind: "new", index: fileIndex++ });
          }
        }
        if (publishTo.mode === "existing") {
          payload.editExisting = true;
          payload.videoOrder = videoOrder;
        }
      }

      fd.set("payload", JSON.stringify(payload));
      return fd;
    },
    [included, designs, ownImages, imageOrder, altTextBySlot, videos],
  );

  const runBatch = useCallback(async () => {
    if (!included.length || !designs.length) return;
    setError(null);
    toast.dismiss("editor-publish");
    try {
      setBusy(`Rendering ${jobCount} images…`);
      const res = await fetch("/api/mockups/render", {
        method: "POST",
        body: buildBatchForm(),
      });
      if (!res.ok) throw new Error(await errorFrom(res));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mockups.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Render failed.");
    } finally {
      setBusy(null);
    }
  }, [included, designs, jobCount, buildBatchForm, toast]);

  /**
   * Every reason this listing can't be published yet, each with the section
   * to fix it in (`null` for page-wide ones), in sidebar order. Shared by
   * Publish and "Schedule for later" — a listing that couldn't publish now
   * shouldn't be queued to publish later.
   */
  const publishErrors = useMemo((): { section: EditorSection | null; message: string }[] => {
    const errors: { section: EditorSection | null; message: string }[] = [];
    if (photoSlots.length === 0) errors.push({ section: "photos", message: "Add at least one photo first." });
    if ((publishMode === "copy" || publishMode === "existing") && publishId == null) {
      errors.push({ section: null, message: "No target listing — go back to Listings and choose one." });
    }
    if (publishMode === "existing" && etsyMedia == null) {
      errors.push({ section: "photos", message: etsyMediaError ?? "Still loading this listing's current photos." });
    }
    if (publishMode === "new" && !listingForm.title.trim()) {
      errors.push({ section: "title", message: "Enter a title for the new draft (Title section)." });
    }
    if (publishMode === "new" && publishId == null && listingForm.taxonomyId == null) {
      errors.push({ section: "details", message: "Choose a category for the new listing (Details section)." });
    }
    if (publishMode === "new" && listingForm.readinessStateId == null) {
      errors.push({ section: "shipping", message: "Choose a processing profile for the new draft (Shipping section)." });
    }
    if (publishMode === "new") {
      const offeringError = validateOfferings(listingForm, photoSlotIds)[0];
      if (offeringError) {
        const tab = VARIATION_SUB_TABS.find((t) => t.key === offeringError.tab)?.label ?? "";
        errors.push({ section: "variations", message: `${offeringError.message} (Variations section, ${tab} tab)` });
      }
    }
    if (publishMode !== "existing") {
      const howError = howItsMadeError({
        whoMade: listingForm.whoMade,
        isSupply: listingForm.isSupply,
        whenMade: listingForm.whenMade,
        productionPartnerIds: listingForm.productionPartnerIds,
      });
      if (howError) errors.push({ section: "howMade", message: `${howError} (How it's made section)` });
      const personalizationError = personalizationQuestionsError(
        listingForm.personalizationQuestions.filter((q) => q.questionText.trim() !== ""),
      );
      if (personalizationError) {
        errors.push({ section: "personalization", message: `${personalizationError} (Personalization section)` });
      }
    }
    return errors.sort((a, b) => compareSections(a.section, b.section));
  }, [photoSlots.length, photoSlotIds, publishMode, publishId, listingForm, etsyMedia, etsyMediaError]);

  /** Why this listing can't be published yet, or `null` when it's ready. */
  const publishBlocker = useCallback((): string | null => publishErrors[0]?.message ?? null, [publishErrors]);

  const erroredSections = useMemo(
    () => new Set(showSectionErrors ? publishErrors.map((e) => e.section) : []),
    [showSectionErrors, publishErrors],
  );

  /**
   * The `publishTo` payload — everything about the listing itself, minus the
   * images. Shared by Publish (which sends it with the renders) and "Schedule
   * for later" (which stores it, to be published unchanged when the time comes).
   */
  const buildPublishTo = useCallback((): Record<string, unknown> => {
    const activePersonalization = listingForm.personalizationQuestions.filter(
      (q) => q.questionText.trim() !== "",
    );
    const publishTo: Record<string, unknown> = {
      mode: publishMode,
      // Omitted (not sent as null) for a blank "new" draft — createDraftListing
      // needs no source listing to borrow anything from.
      ...(publishId != null ? { listingId: publishId } : {}),
    };
    if (publishMode !== "existing") {
      publishTo.howItsMade = {
        whoMade: listingForm.whoMade,
        isSupply: listingForm.isSupply,
        whenMade: listingForm.whenMade,
        productionPartnerIds: listingForm.productionPartnerIds,
      };
      if (activePersonalization.length > 0) {
        publishTo.personalization = activePersonalization;
      }
    }
    if (publishMode === "new") {
      const price = Number.parseFloat(listingForm.price);
      const quantity = Number.parseInt(listingForm.quantity, 10);
      publishTo.newListing = {
        title: listingForm.title.trim(),
        description: listingForm.description.trim(),
        tags: listingForm.tags,
        taxonomyId: listingForm.taxonomyId ?? undefined,
        shopSectionId: listingForm.shopSectionId ?? undefined,
        readinessStateId: listingForm.readinessStateId ?? undefined,
        properties: Object.entries(listingForm.properties).map(([id, p]) => ({
          propertyId: Number(id),
          name: p.name,
          valueIds: p.valueIds,
          values: p.values,
          scaleId: p.scaleId ?? undefined,
        })),
        price: Number.isFinite(price) && price > 0 ? price : undefined,
        quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : undefined,
        sku: listingForm.sku.trim() || undefined,
        variations: buildInventoryPayload(listingForm, photoSlotIds),
        // featured_rank/should_auto_renew aren't settable on createDraftListing —
        // the server sends them via a follow-up updateListing call.
        featuredRank: listingForm.featureListing ? 1 : undefined,
        shouldAutoRenew: listingForm.autoRenew,
      };
    }
    return publishTo;
  }, [listingForm, publishMode, publishId, photoSlotIds]);

  /** Makes the grid what Etsy now holds: its photos and videos, in its order, nothing left to upload. */
  const resetGridToEtsy = useCallback(
    (media: EtsyListingMedia) => {
      const images = [...media.images].sort((a, b) => a.rank - b.rank);
      setEtsyMedia(media);
      setImageOrder(images.map((img) => ({ kind: "etsy", imageId: img.imageId })));
      setAltTextBySlot(Object.fromEntries(images.map((img) => [`etsy:${img.imageId}`, img.altText])));
      setRemovedEtsyImageIds([]);
      setRemovedJobKeys(currentJobRefs.map((r) => r.key));
      setOwnImages((prev) => {
        for (const o of prev) URL.revokeObjectURL(o.url);
        return [];
      });
      const next: (ListingVideoItem | null)[] = media.videos
        .slice(0, MAX_LISTING_VIDEOS)
        .map((v) => ({ kind: "etsy", videoId: v.videoId, videoUrl: v.videoUrl, thumbnailUrl: v.thumbnailUrl }));
      while (next.length < MAX_LISTING_VIDEOS) next.push(null);
      setVideos(next);
    },
    [currentJobRefs],
  );

  /**
   * Sends every difference between the editor and the listing on Etsy: the
   * photo/video grid (order, alt text, added and removed files) through the
   * render route's existing-listing save, then the form's fields through bulk
   * edit's Sync updates path. Differences Etsy's API can't write are listed.
   */
  const syncToEtsy = useCallback(async () => {
    if (publishId == null) return;
    setError(null);
    toast.dismiss("editor-sync");
    setSyncing(true);
    try {
      if (!etsyMedia) throw new Error(etsyMediaError ?? "This listing's current photos are still loading.");
      const res = await writeWithTimeout(`/api/etsy/listings/${publishId}/editor`, {});
      if (!res.ok) throw new Error(await errorFrom(res));
      const { form } = (await res.json()) as { form: ListingFormValue };
      const diff = editorSyncPatch({ ...EMPTY_LISTING_FORM, ...form }, listingForm);
      if ("error" in diff) throw new Error(diff.error);
      const media = mediaChanges(
        mediaStateFromEtsy(etsyMedia),
        mediaStateFromGrid(imageOrder, altTextBySlot, videos, slotIdFor),
      );
      const mediaChanged = media.photos || media.videos;
      const unsyncedNote = diff.unsynced.length > 0 ? describeUnsynced(diff.unsynced) : null;
      const snapshot = draftSnapshot;
      const revision = editRevision;

      if (isEmptyPatch(diff.patch) && !mediaChanged) {
        if (unsyncedNote) throw new Error(unsyncedNote);
        toast.show({ id: "editor-sync", kind: "info", message: "Nothing to sync — the listing on Etsy already matches." });
        setCommitted({ revision, snapshot, kind: "published" });
        return;
      }
      if (diff.patch.variations || diff.patch.variationImages) {
        const invalid = validateOfferings(listingForm, photoSlotIds)[0];
        if (invalid) throw new Error(`Variations: ${invalid.message}`);
      }

      if (mediaChanged) {
        if (photoSlots.length === 0) throw new Error("Photos: a listing needs at least one photo.");
        const saved = await writeWithTimeout("/api/mockups/render", {
          method: "POST",
          body: buildBatchForm({ mode: "existing", listingId: publishId }),
        });
        const body = (await saved.json().catch(() => null)) as
          | { error?: string; failed?: { name?: string; error?: string }[] }
          | null;
        if (!saved.ok || !body) throw new Error(`Photos: ${body?.error || `request failed (${saved.status})`}`);
        const failed = body.failed ?? [];
        const reread = await fetch(`/api/etsy/listings/bulk?ids=${publishId}`);
        const listing = reread.ok
          ? ((await reread.json()) as { listings: EtsyListingMedia[] }).listings[0]
          : undefined;
        if (listing) resetGridToEtsy({ images: listing.images, videos: listing.videos });
        if (failed.length > 0) {
          throw new Error(`Photos: ${failed.map((f) => `${f.name ?? "photo"}: ${f.error ?? "failed"}`).join("; ")}`);
        }
      }

      if (!isEmptyPatch(diff.patch)) {
        const result = await syncListingPatch(publishId, diff.patch, (job) =>
          toast.show({ id: "editor-sync", kind: job.status === "failed" ? "error" : "info", message: `Sync to Etsy: ${describeJob(job)}` }),
        );
        if (!result.ok) throw new Error(result.partial ? `Partly saved. ${result.error ?? ""}`.trim() : result.error);
      }
      toast.show({ id: "editor-sync", kind: "success", message: "Synced to Etsy." });
      if (unsyncedNote) setError(unsyncedNote);
      else setCommitted({ revision, snapshot, kind: "published" });
    } catch (err) {
      setError(`Sync to Etsy failed: ${err instanceof Error ? err.message : "request failed"}`);
    } finally {
      setSyncing(false);
    }
  }, [
    publishId,
    listingForm,
    photoSlotIds,
    photoSlots.length,
    editRevision,
    etsyMedia,
    etsyMediaError,
    imageOrder,
    altTextBySlot,
    videos,
    draftSnapshot,
    buildBatchForm,
    resetGridToEtsy,
    toast,
  ]);

  const publishToEtsy = useCallback(async () => {
    if (photoSlots.length === 0) return;
    const blocker = publishErrors[0];
    if (blocker) {
      setError(blocker.message);
      setShowSectionErrors(true);
      if (blocker.section) goToSection(blocker.section);
      if (blocker.section === "variations") setVariationErrorJump((n) => n + 1);
      return;
    }
    setShowSectionErrors(false);
    setError(null);
    toast.dismiss("editor-publish");
    try {
      setBusy(
        publishMode === "existing"
          ? "Saving photos and videos to Etsy…"
          : "Creating draft and uploading images…",
      );
      const publishTo = buildPublishTo();

      const fd = buildBatchForm(publishTo);
      const res = await fetch("/api/mockups/render", {
        method: "POST",
        body: fd,
      });
      const body = (await res.json().catch(() => null)) as
        | (PublishResult & { error?: string })
        | null;
      if (!res.ok || !body) {
        throw new Error(
          body?.error ||
            (res.status === 401
              ? "Not connected to Etsy — reconnect from the home page."
              : `Upload failed (${res.status})`),
        );
      }
      const result: PublishResult = {
        mode: body.mode ?? publishMode,
        listingId: body.listingId ?? publishId,
        createdDraft: !!body.createdDraft,
        uploaded: body.uploaded ?? [],
        failed: body.failed ?? [],
        skipped: body.skipped ?? 0,
        edited: !!body.edited,
      };
      toast.show({
        id: "editor-publish",
        kind: result.failed.length > 0 ? "error" : "success",
        message: <PublishResultMessage result={result} />,
      });
      setCommitted({ revision: editRevision, snapshot: draftSnapshot, kind: "published" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Etsy upload failed.");
    } finally {
      setBusy(null);
    }
  }, [
    photoSlots,
    publishId,
    publishMode,
    buildBatchForm,
    publishErrors,
    goToSection,
    buildPublishTo,
    editRevision,
    draftSnapshot,
    toast,
  ]);

  // ---- "Schedule for later" — see app/(app)/schedule and lib/scheduling/* ----
  const [scheduleOpen, setScheduleOpen] = useState(false);
  /** This draft's live schedule in the active shop, if it has one. */
  const [schedule, setSchedule] = useState<ScheduledListingSummary | null>(null);
  /** What the browser is doing while a schedule is being rendered and uploaded. */
  const [scheduleProgress, setScheduleProgress] = useState<string | null>(null);

  useEffect(() => {
    if (!draftId) return;
    const controller = new AbortController();
    fetch(`/api/schedule?draftId=${encodeURIComponent(draftId)}`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { scheduledListings?: ScheduledListingSummary[] } | null) => {
        if (!controller.signal.aborted) setSchedule(body?.scheduledListings?.[0] ?? null);
      })
      .catch(() => {
        /* no schedule shown — scheduling itself still reports its own errors */
      });
    return () => controller.abort();
  }, [draftId]);

  /** The images a scheduled publish will send to Etsy, in photo-grid order. */
  const scheduleImageSources = useCallback((): ScheduleImageSource[] => {
    const sources: ScheduleImageSource[] = [];
    for (const ref of imageOrder) {
      const altText = altTextBySlot[slotIdFor(ref)] || undefined;
      if (ref.kind === "job") {
        const [mockupId, designId] = ref.key.split("::");
        const mockup = included.find((m) => m.id === mockupId);
        const design = designs.find((d) => d.id === designId);
        if (mockup && design) sources.push({ kind: "render", mockup, design, altText });
      } else if (ref.kind === "own") {
        const own = ownImages.find((o) => o.id === ref.id);
        if (own) sources.push({ kind: "own", file: own.file, altText });
      }
    }
    return sources;
  }, [imageOrder, altTextBySlot, included, designs, ownImages]);

  /**
   * Renders this listing's images here in the browser, uploads them, saves the
   * draft, and records the schedule. Everything the listing will publish is
   * fixed now — the runner only forwards these images to Etsy later. A failure
   * anywhere stops the whole thing, throws away whatever was uploaded, and is
   * reported in the dialog; nothing is scheduled half-rendered.
   */
  async function submitSchedule(input: ScheduleTimeInput): Promise<string | null> {
    const blocked =
      publishBlocker() ?? scheduleBlocker({ publishMode, videoCount: videos.filter((v) => v).length });
    if (blocked) return blocked;

    const sources = scheduleImageSources();
    if (sources.length === 0) return "Add at least one photo first.";

    try {
      setScheduleProgress("Rendering images…");
      const prepared = await prepareScheduleImages(sources, (done, total) =>
        setScheduleProgress(`Rendering images… ${done}/${total}`),
      );
      setScheduleProgress("Uploading images…");
      const uploaded = await uploadScheduleImages(prepared, (done, total) =>
        setScheduleProgress(`Uploading images… ${done}/${total}`),
      );

      setScheduleProgress("Saving…");
      const id = await saveDraftNow({ explicit: true });
      if (!id) {
        await discardRenderSet(uploaded.renderSetId);
        return "The draft couldn't be saved, so it can't be scheduled yet.";
      }

      // Rescheduling from the editor replaces the stored listing and images
      // with what was just rendered; the server deletes the ones it replaces.
      const existing = schedule && schedule.draftId === id ? schedule : null;
      const res = await fetch(existing ? `/api/schedule/${encodeURIComponent(existing.id)}` : "/api/schedule", {
        method: existing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...input,
          ...(existing ? {} : { draftId: id }),
          publishSpec: buildPublishTo(),
          ...uploaded,
        }),
      });
      if (!res.ok) {
        const error = await errorFrom(res);
        await discardRenderSet(uploaded.renderSetId);
        return error;
      }
      const body = (await res.json()) as { scheduledListing: ScheduledListingSummary };
      setSchedule(body.scheduledListing);
      setScheduleOpen(false);
      toast.show({
        id: "editor-schedule",
        kind: "success",
        message: (
          <>
            Scheduled to publish {scheduleTimeLabel(body.scheduledListing)}. It stays a draft here until then — nothing
            is sent to Etsy yet.{" "}
            <Link href="/schedule" className="font-medium text-primary underline underline-offset-2">
              View schedule
            </Link>
          </>
        ),
      });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Could not schedule this listing.";
    } finally {
      setScheduleProgress(null);
    }
  }

  const scheduledLabel = schedule ? scheduleTimeLabel(schedule) : null;

  const failedScheduleId = schedule?.status === "failed" ? schedule.id : null;
  const failedScheduleError = schedule?.status === "failed" ? schedule.lastError : null;
  useEffect(() => {
    if (!failedScheduleId) return;
    toast.show({
      id: `schedule-failed-${failedScheduleId}`,
      kind: "error",
      message: (
        <>
          The scheduled publish failed{failedScheduleError ? `: ${failedScheduleError}` : ""}. Reschedule to try again.{" "}
          <Link href="/schedule" className="font-medium text-primary underline underline-offset-2">
            View schedule
          </Link>
        </>
      ),
    });
  }, [failedScheduleId, failedScheduleError, toast]);

  useEffect(() => {
    if (error) toast.show({ id: "editor-error", kind: "error", message: error });
    else toast.dismiss("editor-error");
  }, [error, toast]);

  const mediaLoadError = publishMode === "existing" ? etsyMediaError : null;
  useEffect(() => {
    if (mediaLoadError) toast.show({ id: "editor-media-error", kind: "error", message: mediaLoadError });
  }, [mediaLoadError, toast]);

  const areaCount = active ? quadList(active.calibration).length : 0;
  const areaIndex = Math.min(activeArea, Math.max(0, areaCount - 1));

  /** Drives the small incomplete-field dot next to each nav item — a light heuristic, not full Etsy validation. */
  function isSectionIncomplete(section: EditorSection): boolean {
    switch (section) {
      case "photos":
        return photoSlots.length === 0;
      case "title":
        return !listingForm.title.trim();
      case "description":
        return !listingForm.description.trim();
      case "tags":
        return listingForm.tags.length === 0;
      case "details":
        return listingForm.taxonomyId == null;
      case "howMade":
        return (
          howItsMadeError({
            whoMade: listingForm.whoMade,
            isSupply: listingForm.isSupply,
            whenMade: listingForm.whenMade,
            productionPartnerIds: listingForm.productionPartnerIds,
          }) != null
        );
      case "personalization":
        // Optional — a blank slot (no label typed) is just "not configured",
        // not incomplete. Only a question the user started filling in but
        // left invalid (e.g. a dropdown with no options) flags the tab.
        return (
          personalizationQuestionsError(
            listingForm.personalizationQuestions.filter((q) => q.questionText.trim() !== ""),
          ) != null
        );
      case "price": {
        // Hidden and not required once price varies by variation — it's
        // entered per combination on the Variations tab instead.
        const priceToggle = listingForm.variationToggles.price;
        if (priceToggle.enabled && priceToggle.appliesTo.length > 0) return false;
        const p = Number.parseFloat(listingForm.price);
        return !(Number.isFinite(p) && p > 0);
      }
      case "inventory": {
        const q = Number.parseInt(listingForm.quantity, 10);
        return !(Number.isInteger(q) && q > 0);
      }
      case "shipping":
        return listingForm.readinessStateId == null;
      default:
        return false;
    }
  }

  /** A new physical listing can't be created without one — Etsy rejects the draft otherwise. */
  const needsReadinessState = publishMode === "new" && listingForm.readinessStateId == null;

  /** One-line description of what Publish will do — mode and target are both fixed, chosen back on the Listings page. */
  const modeCaption = (() => {
    if (publishMode === "existing") return `Editing "${targetListing?.title}"`;
    if (publishMode === "copy") return `Copy of "${targetListing?.title}"`;
    return targetListing
      ? `New draft, category & shipping borrowed from "${targetListing.title}"`
      : "New draft, created from scratch";
  })();

  /** Set while this draft's own schedule will publish it — publishing now too would duplicate the listing. */
  const publishBlockedReason = publishBlockedBySchedule(schedule);
  /** Set when this editor session can't be scheduled at all (an existing listing, or a video). */
  const scheduleBlockedReason = scheduleBlocker({
    publishMode,
    videoCount: videos.filter((v) => v).length,
  });

  return (
    <div
      className="min-h-screen bg-zinc-50 font-sans dark:bg-black"
      style={{ [SECTION_SCROLL_OFFSET_VAR]: `${scrollOffset}px` } as React.CSSProperties}
    >
      <header ref={headerRef} className="sticky top-0 z-20 border-b border-black/10 bg-zinc-50/95 px-6 py-3 backdrop-blur dark:border-white/15 dark:bg-black/95">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-3">
          <Link
            href="/listings"
            className="text-sm text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            ← Back to listings
          </Link>
          {targetListing && <ListingThumb url={targetListing.thumbnailUrl} size={32} />}
          <div className="min-w-0">
            <p className="truncate text-xs text-zinc-500">{shopName ?? "Your shop"}</p>
            <p className="truncate text-sm font-semibold text-black dark:text-zinc-50">
              {listingForm.title.trim() ||
                (hydrateListingId != null ? targetListing?.title : null) ||
                "Untitled listing"}
            </p>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span
              className={`text-xs ${draftStatus === "error" ? "text-red-600 dark:text-red-400" : "text-zinc-400 dark:text-zinc-500"}`}
            >
              {draftStatus === "restoring" && "Loading draft…"}
              {draftStatus !== "restoring" && hydrateListingId != null && "Loading listing…"}
              {draftStatus === "saving" && "Saving…"}
              {draftStatus === "saved" && "Saved"}
              {draftStatus === "error" && (draftError || "Could not save draft")}
            </span>
            <button
              type="button"
              onClick={() => void saveDraftNow({ explicit: true })}
              disabled={draftStatus === "saving" || !loadSettled}
              className="h-9 rounded-full border border-black/10 px-4 text-sm font-medium transition-colors hover:bg-black/[.04] disabled:opacity-40 dark:border-white/15 dark:hover:bg-white/[.06]"
            >
              Save draft
            </button>
            <button
              type="button"
              onClick={() => setShowPreview(true)}
              className="h-9 rounded-full border border-black/10 px-4 text-sm font-medium transition-colors hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
            >
              Preview
            </button>
            {publishMode === "existing" && publishId != null && (
              <a
                href={`https://www.etsy.com/listing/${publishId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 items-center gap-2 rounded-full border border-black/10 px-4 text-sm font-medium transition-colors hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
              >
                <EtsyMark />
                View on Etsy
              </a>
            )}
            {publishMode === "existing" && publishId != null && (
              <button
                type="button"
                onClick={() => void syncToEtsy()}
                disabled={syncing || !!busy || !loadSettled}
                className="inline-flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-dark disabled:opacity-40"
              >
                {syncing && (
                  <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 animate-spin" fill="none">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.3" strokeWidth="2" />
                    <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                )}
                {syncing ? "Syncing…" : "Sync to Etsy"}
              </button>
            )}
            <span className="max-w-xs truncate text-xs text-zinc-500 dark:text-zinc-400">
              {modeCaption}
            </span>
            {/* The picker hangs off this button (see ScheduleDialog's `anchored`). */}
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  if (scheduleBlockedReason) {
                    toast.show({ id: "schedule-blocked", kind: "info", message: scheduleBlockedReason });
                    return;
                  }
                  setScheduleOpen((open) => !open);
                }}
                aria-expanded={scheduleOpen}
                disabled={
                  !!busy ||
                  !!scheduleProgress ||
                  draftStatus === "restoring" ||
                  (!scheduleBlockedReason && (publishCount === 0 || needsReadinessState))
                }
                title={scheduleBlockedReason ?? undefined}
                className="h-9 rounded-full border border-black/10 px-4 text-sm font-medium transition-colors hover:bg-black/[.04] disabled:opacity-40 dark:border-white/15 dark:hover:bg-white/[.06]"
              >
                {scheduleProgress ??
                  (schedule
                    ? schedule.status === "failed"
                      ? "Reschedule (failed)"
                      : `Scheduled · ${scheduledLabel}`
                    : "Schedule for later")}
              </button>
              {scheduleOpen && (
                <ScheduleDialog
                  anchored
                  heading={schedule ? "Reschedule listing" : "Schedule for later"}
                  description="Your images are rendered and saved now, then published to Etsy at the time you choose. Nothing is sent to Etsy until then."
                  submitLabel={schedule ? "Reschedule" : "Schedule"}
                  initial={schedule}
                  onSubmit={submitSchedule}
                  onClose={() => setScheduleOpen(false)}
                />
              )}
            </div>
            <button
              type="button"
              onClick={publishToEtsy}
              disabled={!!busy || publishCount === 0 || !!publishBlockedReason}
              title={publishBlockedReason ?? undefined}
              className="h-9 rounded-full border border-primary px-4 text-sm font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
            >
              {publishMode === "existing"
                ? `Save to Etsy (${publishCount})`
                : `Create draft & upload (${publishCount})`}
            </button>
          </div>
        </div>

        <div className="mx-auto mt-2 w-full max-w-7xl space-y-1">
          {publishBlockedReason && (
            <p className="text-xs font-medium text-primary">{publishBlockedReason}</p>
          )}
          {needsReadinessState && (
            <p className="text-xs font-medium text-primary">
              Choose a processing profile in the Shipping section before creating this draft.
            </p>
          )}
          {publishMode !== "existing" && (
            <p className="text-xs text-zinc-500">
              A new draft listing is created and images are uploaded to it. The live listing is never touched.
            </p>
          )}
        </div>
      </header>

      <div className="mx-auto w-full max-w-7xl px-6 py-8">
        <div className="flex flex-col gap-6 lg:flex-row">
          {/* ---- left nav: jumps to a section of the form on the right ---- */}
          <nav
            aria-label="Listing sections"
            className="lg:sticky lg:w-[200px] lg:shrink-0 lg:self-start"
            style={{ top: scrollOffset }}
          >
            <ul className="space-y-0.5">
              {EDITOR_SECTIONS.map((item) => {
                const isActive = activeSection === item.key;
                const errored = erroredSections.has(item.key);
                const incomplete = !errored && isSectionIncomplete(item.key);
                return (
                  <li key={item.key}>
                    <a
                      href={`#${item.anchor}`}
                      aria-current={isActive ? "location" : undefined}
                      data-errored={errored || undefined}
                      onClick={(e) => {
                        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                        e.preventDefault();
                        goToSection(item.key);
                      }}
                      className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                        isActive
                          ? "bg-black text-white dark:bg-white dark:text-black"
                          : errored
                            ? "text-red-600 hover:bg-black/[.04] dark:text-red-400 dark:hover:bg-white/[.06]"
                            : "text-zinc-600 hover:bg-black/[.04] dark:text-zinc-400 dark:hover:bg-white/[.06]"
                      }`}
                    >
                      <span>{item.label}</span>
                      {errored && (
                        <span
                          role="img"
                          aria-label={`${item.label} has errors`}
                          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white"
                        >
                          !
                        </span>
                      )}
                      {incomplete && (
                        <span
                          aria-label={`${item.label} incomplete`}
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            isActive ? "bg-white dark:bg-black" : "bg-primary"
                          }`}
                        />
                      )}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* ---- right: every section of the form, top to bottom ---- */}
          <div className="min-w-0 flex-1 space-y-6">
            <EditorSectionCard
              section="photos"
              aside={
                <button
                  type="button"
                  onClick={runBatch}
                  disabled={!!busy || jobCount === 0}
                  className="h-9 rounded-full bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-dark disabled:opacity-40"
                >
                  {busy ?? `Batch render & download (${jobCount})`}
                </button>
              }
            >
              <div className="mt-4 grid gap-6 lg:grid-cols-[260px_1fr_260px]">
                {/* ---- left: lists ---- */}
                <div className="space-y-6">
                  <Dropzone
                    label="Mockup PSDs"
                    accept=".psd"
                    inputRef={psdInput}
                    onFiles={edit(addPsds)}
                  />
                  <button
                    type="button"
                    onClick={() => setShowTemplatePicker(true)}
                    className="h-9 w-full rounded-lg border border-dashed border-black/20 text-sm text-zinc-600 transition-colors hover:bg-black/[.04] dark:border-white/25 dark:text-zinc-300 dark:hover:bg-white/[.06]"
                  >
                    Add from template library
                  </button>
                  {mockups.length > 0 && (
                    <ul className="space-y-1">
                      {mockups.map((m, i) => (
                        <li
                          key={m.id}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", String(i));
                          }}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const from = Number(e.dataTransfer.getData("text/plain"));
                            if (Number.isFinite(from)) edit(moveMockup)(from, i);
                          }}
                        >
                          <div
                            className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm ${
                              m.id === activeId
                                ? "border-primary bg-primary/5"
                                : "border-black/10 hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
                            }`}
                          >
                            <span className="cursor-grab select-none text-zinc-400" aria-hidden="true">
                              ⠿
                            </span>
                            <input
                              type="checkbox"
                              checked={m.include}
                              onChange={(e) =>
                                edit(setMockups)((prev) =>
                                  prev.map((x) =>
                                    x.id === m.id
                                      ? { ...x, include: e.target.checked }
                                      : x,
                                  ),
                                )
                              }
                              className="accent-primary"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                setActiveId(m.id);
                                setActiveArea(0);
                                setCalibrationNote(null);
                              }}
                              className="flex-1 truncate text-left"
                            >
                              {m.name}
                            </button>
                            {m.tone && <ToneBadge tone={m.tone} />}
                            <button
                              type="button"
                              onClick={() => edit(deleteMockup)(m.id)}
                              aria-label={`Delete ${m.name}`}
                              className="text-zinc-400 hover:text-red-600"
                            >
                              ×
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}

                  <Dropzone
                    label="Designs"
                    accept="image/*"
                    inputRef={designInput}
                    onFiles={edit(addDesigns)}
                  />
                  {designs.length > 0 && (
                    <ul className="grid grid-cols-3 gap-2">
                      {designs.map((d) => (
                        <li key={d.id}>
                          <button
                            type="button"
                            onClick={() => setPreviewDesignId(d.id)}
                            title={d.name}
                            className={`block aspect-square w-full overflow-hidden rounded-lg border ${
                              d.id === previewDesign?.id
                                ? "border-primary ring-2 ring-primary/40"
                                : "border-black/10 dark:border-white/15"
                            }`}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={d.url}
                              alt={d.name}
                              className="h-full w-full object-contain"
                            />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* ---- center: editor ---- */}
                <div>
                  {active ? (
                    <>
                      {areaCount > 1 && (
                        <div className="mb-3 flex flex-wrap gap-1.5">
                          {Array.from({ length: areaCount }).map((_, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => setActiveArea(i)}
                              className={`h-7 rounded-full px-2.5 text-xs font-medium ${
                                i === areaIndex
                                  ? "bg-black text-white dark:bg-white dark:text-black"
                                  : "border border-black/10 dark:border-white/15"
                              }`}
                            >
                              {active.areaNames[i] || `Area ${i + 1}`}
                            </button>
                          ))}
                        </div>
                      )}
                      <MockupCanvas
                        key={active.id}
                        mock={active.mockRaster}
                        overlays={previewOverlays}
                        design={previewDesign?.raster ?? null}
                        calibration={active.calibration}
                        activeArea={areaIndex}
                        cornerMode={cornerMode}
                        onAreaChange={edit(onAreaChange)}
                      />
                      <p className="mt-2 text-center text-xs text-zinc-500">
                        {active.psdW}×{active.psdH}px · drag the corners, grab inside the area to move it
                      </p>
                    </>
                  ) : (
                    <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-black/15 text-sm text-zinc-500 dark:border-white/20">
                      Upload a PSD and pick one from the list.
                    </div>
                  )}
                </div>

                {/* ---- right: controls ---- */}
                <div className="space-y-4">
                  {active ? (
                    <>
                      <div>
                        <span className="mb-1.5 block text-sm text-zinc-600 dark:text-zinc-400">
                          Corners
                        </span>
                        <div className="flex gap-1.5">
                          {(
                            [
                              ["free", "Free"],
                              ["ratio", "Keep ratio"],
                            ] as const
                          ).map(([m, label]) => (
                            <button
                              key={m}
                              type="button"
                              onClick={() => setCornerMode(m)}
                              className={`h-8 flex-1 rounded-full text-xs font-medium transition-colors ${
                                cornerMode === m
                                  ? "bg-black text-white dark:bg-white dark:text-black"
                                  : "border border-black/10 text-zinc-600 dark:border-white/15 dark:text-zinc-400"
                              }`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <p className="mt-1 text-xs text-zinc-500">
                          {cornerMode === "ratio"
                            ? "Dragging one corner scales the area proportionally from the opposite corner."
                            : "Each corner drags independently (perspective)."}
                        </p>
                      </div>

                      {SLIDERS.map((s) => {
                        const value = Number(active.calibration[s.key] ?? s.min);
                        return (
                          <label key={s.key} className="block text-sm">
                            <span className="flex justify-between text-zinc-600 dark:text-zinc-400">
                              <span>{s.label}</span>
                              <span className="font-mono">{Math.round(value)}</span>
                            </span>
                            <input
                              type="range"
                              min={s.min}
                              max={s.max}
                              value={value}
                              onChange={(e) => edit(onSlider)(s.key, Number(e.target.value))}
                              className="mt-1 w-full accent-primary"
                            />
                          </label>
                        );
                      })}

                      <div className="border-t border-black/10 pt-4 dark:border-white/15">
                        <button
                          type="button"
                          onClick={saveActiveCalibration}
                          className="h-9 w-full rounded-full border border-black/10 text-sm font-medium transition-colors hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
                        >
                          Save calibration
                        </button>
                        <p className="mt-1.5 text-center text-xs text-zinc-500">
                          {calibrationNote ??
                            (active.hasSavedCalibration
                              ? "A saved calibration was loaded for this template."
                              : "No saved calibration yet for this template — your corner/slider settings only persist for this session.")}
                        </p>
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-zinc-500">Select a mockup to adjust its settings.</p>
                  )}
                </div>
              </div>

              <p className="mt-6 text-sm text-zinc-500 dark:text-zinc-400">
                {mockups.length} templates ({included.length} checked) × {designs.length}{" "}
                designs = <span className="font-medium">{jobCount}</span> images.
                Preview runs in the browser, batch rendering on the server — same core.
              </p>

              <ListingMediaEditor
                slots={photoSlots}
                altTextBySlot={altTextBySlot}
                onMovePhoto={editGrid(moveImageSlot)}
                onRemovePhoto={editGrid(removeImageSlot)}
                onAltTextChange={editGrid(setAltText)}
                onAddPhotos={editGrid(addOwnImages)}
                videos={videos}
                videoErrors={videoErrors}
                onSelectVideo={editGrid(selectVideo)}
                onMoveVideo={editGrid(moveVideoSlot)}
              />
            </EditorSectionCard>

            {hydrateListingId != null ? (
              <p className="rounded-xl border border-black/10 bg-white p-4 text-sm text-zinc-500 dark:border-white/15 dark:bg-zinc-950 md:p-6">
                Loading listing…
              </p>
            ) : (
              <ListingForm
                value={listingForm}
                onChange={edit(setListingForm)}
                onGoToSection={goToSection}
                photoSlots={photoSlots}
                currencyCode={currencyCode}
                showVariationErrors={showSectionErrors}
                variationErrorJump={variationErrorJump}
              />
            )}
            {/* Lets the last sections scroll up to the top, so each can become the active one. */}
            <div aria-hidden className="h-[50vh]" />
          </div>
        </div>
      </div>

      {showTemplatePicker && (
        <TemplatePicker onClose={() => setShowTemplatePicker(false)} onSelect={edit(addFromTemplate)} />
      )}

      {showPreview && (
        <ListingPreviewModal
          title={listingForm.title}
          description={listingForm.description}
          priceLabel={formatPreviewPrice(listingForm)}
          variations={listingForm.variations.map((v) => ({ name: v.name, values: v.values }))}
          media={previewMedia}
          onClose={() => setShowPreview(false)}
        />
      )}

      {unsavedDialog}
    </div>
  );
}

/** The schedule's time as a wall time in the zone it was picked in, e.g. "Sep 20, 2:30 PM GMT+3". */
function scheduleTimeLabel(schedule: Pick<ScheduledListingSummary, "scheduledAt" | "timezone">): string {
  return new Date(schedule.scheduledAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: schedule.timezone,
    timeZoneName: "short",
  });
}

function PublishResultMessage({ result }: { result: PublishResult }) {
  return (
    <>
      {result.createdDraft ? `Draft listing #${result.listingId} created · ` : ""}
      {result.edited && "Photos and videos saved to Etsy · "}
      {result.uploaded.length} images uploaded
      {result.skipped > 0 && ` · ${result.skipped} skipped (${MAX_LISTING_IMAGES}-image limit)`}
      {result.createdDraft && (
        <>
          {" · "}
          <a
            href={`https://www.etsy.com/your/shops/me/listings/${result.listingId}`}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Open on Etsy
          </a>
        </>
      )}
      {result.failed.length > 0 && (
        <ul className="mt-1 list-disc pl-5 text-red-700 dark:text-red-300">
          {result.failed.slice(0, 5).map((f, i) => (
            <li key={i}>
              {f.name}: {f.error}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Dropzone({
  label,
  accept,
  inputRef,
  onFiles,
}: {
  label: string;
  accept: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onFiles: (files: File[]) => void;
}) {
  const [hot, setHot] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setHot(true);
        }}
        onDragLeave={() => setHot(false)}
        onDrop={(e) => {
          e.preventDefault();
          setHot(false);
          onFiles([...e.dataTransfer.files]);
        }}
        className={`flex w-full flex-col items-center gap-1 rounded-xl border-2 border-dashed px-4 py-6 text-sm transition-colors ${
          hot
            ? "border-primary bg-primary/5"
            : "border-black/15 text-zinc-500 hover:border-black/30 dark:border-white/20 dark:hover:border-white/40"
        }`}
      >
        <span className="font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
        <span>click or drag</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        hidden
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function ToneBadge({ tone }: { tone: string }) {
  const dark = tone === "dark";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
        dark ? "bg-zinc-800 text-zinc-100" : "bg-zinc-200 text-zinc-700"
      }`}
    >
      {dark ? "DARK" : "LIGHT"}
    </span>
  );
}

/** Small square thumbnail with a placeholder for listings with no image yet. */
function ListingThumb({ url, size }: { url: string | null; size: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800"
      style={{ width: size, height: size }}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="text-[10px] text-zinc-400">—</span>
      )}
    </span>
  );
}

