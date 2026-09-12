"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { blobToRaster, dataUrlToBlob, rasterToDataUrl } from "@/lib/mockup/client";
import { compose } from "@/lib/mockup/compose";
import { quadList } from "@/lib/mockup/geometry";
import type { Calibration, Overlay, Quad, Raster } from "@/lib/mockup/types";
import { normalizeBlendMode } from "@/lib/mockup/validate";
import { MAX_COMBINATIONS_HARD_CAP } from "@/lib/etsy/variation-limits";
import {
  ACCEPTED_IMAGE_EXTENSIONS,
  MAX_ALT_TEXT_LENGTH,
  MAX_LISTING_IMAGES,
  checkImageFileBasics,
} from "@/lib/etsy/listing-image-limits";
import {
  ACCEPTED_VIDEO_EXTENSIONS,
  MAX_LISTING_VIDEOS,
  MAX_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_SIZE_BYTES,
  MIN_VIDEO_DURATION_SECONDS,
  checkVideoDuration,
  checkVideoFileBasics,
} from "@/lib/etsy/video-limits";
import ListingForm, {
  EMPTY_LISTING_FORM,
  type ListingFormTab,
  type ListingFormValue,
  type VariationToggleKey,
} from "./ListingForm";
import MockupCanvas from "./MockupCanvas";

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

interface ListingOption {
  listingId: number;
  title: string;
  thumbnailUrl: string | null;
}

/** A user-uploaded photo, added straight into the photo grid alongside rendered mockups. */
interface OwnImage {
  id: string;
  file: File;
  url: string;
}

/**
 * One photo-grid slot: either a rendered mockup×design combo (identified by a
 * stable `mockupId::designId` key, since indices shift as mockups/designs are
 * added or removed) or a user-uploaded photo (identified by its `OwnImage.id`).
 * `imageOrder` state is a list of these — its order IS the Etsy upload/rank
 * order, slot 0 becoming the listing thumbnail.
 */
type ImageSlotRef = { kind: "job"; key: string } | { kind: "own"; id: string };

/** One photo-grid slot — a rendered mockup×design combo or a user-uploaded photo. */
interface PhotoSlot {
  slotId: string;
  ref: ImageSlotRef;
  thumbnailUrl: string | null;
  label: string;
}

const jobKey = (mockupId: string, designId: string) => `${mockupId}::${designId}`;
const slotIdFor = (ref: ImageSlotRef) => (ref.kind === "job" ? `job:${ref.key}` : `own:${ref.id}`);

/** First 40 characters of a title, as shown per row in the listing picker. */
const shortTitle = (t: string) => (t.length > 40 ? `${t.slice(0, 40)}…` : t);

/** The joined value ids a field's `appliesTo`-scoped subset of one combination — matches `ListingForm`'s own key. */
function comboKeyFor(appliesTo: number[], valueIds: number[]): string {
  return appliesTo.map((i) => valueIds[i]).join(":");
}

/**
 * Turn the form's variation cards + toggles into the wire shape
 * `publishTo.newListing.variations` expects — the cartesian product of every
 * variation's values, with each row's price/quantity/SKU/processing-profile
 * read from whichever cell the form stored it under (a field left off, or a
 * blank cell, falls back to the base form price/quantity server-side).
 */
function buildVariationsPayload(
  form: ListingFormValue,
):
  | {
      priceOnProperty: number[];
      quantityOnProperty: number[];
      skuOnProperty: number[];
      readinessStateOnProperty: number[];
      products: {
        propertyValues: { propertyId: number; name: string; valueIds: (number | null)[]; values: string[] }[];
        price?: number;
        quantity?: number;
        sku?: string;
        readinessStateId?: number;
        enabled: boolean;
      }[];
    }
  | undefined {
  const dims = form.variations;
  if (dims.length === 0) return undefined;

  let combos: { valueIds: number[]; values: string[] }[] = [{ valueIds: [], values: [] }];
  for (const dim of dims) {
    const next: typeof combos = [];
    for (const a of combos) {
      for (let i = 0; i < dim.valueIds.length; i++) {
        next.push({
          valueIds: [...a.valueIds, dim.valueIds[i]],
          values: [...a.values, dim.values[i]],
        });
      }
    }
    combos = next;
  }
  combos = combos.slice(0, MAX_COMBINATIONS_HARD_CAP);

  const read = (key: VariationToggleKey, valueIds: number[]): string | undefined => {
    const toggle = form.variationToggles[key];
    if (!toggle.enabled) return undefined;
    return form.variationRows[key][comboKeyFor(toggle.appliesTo, valueIds)];
  };

  const products = combos.map((c) => {
    const rp = Number.parseFloat(read("price", c.valueIds) ?? "");
    const rq = Number.parseInt(read("quantity", c.valueIds) ?? "", 10);
    const rSku = read("sku", c.valueIds);
    const rReadiness = Number.parseInt(read("readiness", c.valueIds) ?? "", 10);
    return {
      propertyValues: dims.map((d, i) => ({
        propertyId: d.propertyId,
        name: d.name,
        // A negative id is a free-text value added on top of a real Etsy
        // property (see VariationValuePicker) — Etsy expects value_id:null for those.
        valueIds: [c.valueIds[i] < 0 ? null : c.valueIds[i]],
        values: [c.values[i]],
      })),
      price: Number.isFinite(rp) && rp > 0 ? rp : undefined,
      quantity: Number.isFinite(rq) && rq >= 0 ? rq : undefined,
      sku: rSku?.trim() || undefined,
      readinessStateId: Number.isFinite(rReadiness) && rReadiness > 0 ? rReadiness : undefined,
      // Disabled rows are still sent — Etsy requires every combination — just marked inactive.
      enabled: form.variationRowEnabled[c.valueIds.join(":")] !== false,
    };
  });

  const onProperty = (key: VariationToggleKey): number[] =>
    form.variationToggles[key].enabled
      ? form.variationToggles[key].appliesTo.map((i) => dims[i].propertyId)
      : [];

  return {
    priceOnProperty: onProperty("price"),
    quantityOnProperty: onProperty("quantity"),
    skuOnProperty: onProperty("sku"),
    readinessStateOnProperty: onProperty("readiness"),
    products,
  };
}

type PublishMode = "existing" | "copy" | "new";

interface PublishResult {
  mode: PublishMode;
  listingId: number;
  createdDraft: boolean;
  uploaded: { name: string; rank: number }[];
  failed: { name: string; error: string }[];
  skipped: number;
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

/** Reads a video file's duration via a hidden `<video>` element — NaN if the browser can't decode it. */
function probeVideoDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(v.duration);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(NaN);
    };
    v.src = url;
  });
}

async function errorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (res.status === 401) return "Not connected to Etsy — reconnect from the home page.";
  return body?.error || `Request failed (${res.status})`;
}

/** Left-nav tabs, mirroring Etsy's own "New listing" screen. */
type NavTab = ListingFormTab | "photos" | "personalization";

const LISTING_FORM_TABS: readonly ListingFormTab[] = [
  "title",
  "description",
  "tags",
  "details",
  "price",
  "inventory",
  "variations",
  "shipping",
  "settings",
];
function isListingFormTab(tab: NavTab): tab is ListingFormTab {
  return (LISTING_FORM_TABS as readonly string[]).includes(tab);
}

const NAV_ITEMS: { key: NavTab; label: string }[] = [
  { key: "photos", label: "Photos" },
  { key: "title", label: "Title" },
  { key: "description", label: "Description" },
  { key: "tags", label: "Tags" },
  { key: "details", label: "Details" },
  { key: "price", label: "Price" },
  { key: "inventory", label: "Inventory" },
  { key: "variations", label: "Variations" },
  { key: "personalization", label: "Personalization" },
  { key: "shipping", label: "Shipping" },
  { key: "settings", label: "Settings" },
];

export default function MockupsPage() {
  const [mockups, setMockups] = useState<MockupItem[]>([]);
  const [designs, setDesigns] = useState<DesignItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeArea, setActiveArea] = useState(0);
  const [previewDesignId, setPreviewDesignId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [listings, setListings] = useState<ListingOption[]>([]);
  const [listingsLoading, setListingsLoading] = useState(true);
  const [selectedListing, setSelectedListing] = useState<ListingOption | null>(null);
  const publishId = selectedListing?.listingId ?? null;
  const [publishMode, setPublishMode] = useState<PublishMode>("copy");
  const [overwriteExisting, setOverwriteExisting] = useState(false);
  const [listingForm, setListingForm] = useState<ListingFormValue>(EMPTY_LISTING_FORM);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [cornerMode, setCornerMode] = useState<"free" | "ratio">("free");
  const [activeTab, setActiveTab] = useState<NavTab>("photos");
  const [shopName, setShopName] = useState<string | null>(null);
  const [videos, setVideos] = useState<(File | null)[]>(() => Array(MAX_LISTING_VIDEOS).fill(null));
  const [videoErrors, setVideoErrors] = useState<(string | null)[]>(() =>
    Array(MAX_LISTING_VIDEOS).fill(null),
  );

  const selectVideo = useCallback(async (slot: number, file: File | null) => {
    setVideoErrors((prev) => prev.map((e, i) => (i === slot ? null : e)));
    if (!file) {
      setVideos((prev) => prev.map((v, i) => (i === slot ? null : v)));
      return;
    }
    const basicsError = checkVideoFileBasics(file);
    if (basicsError) {
      setVideoErrors((prev) => prev.map((e, i) => (i === slot ? basicsError : e)));
      return;
    }
    const duration = await probeVideoDuration(file);
    const durationError = checkVideoDuration(duration);
    if (durationError) {
      setVideoErrors((prev) => prev.map((e, i) => (i === slot ? durationError : e)));
      return;
    }
    setVideos((prev) => prev.map((v, i) => (i === slot ? file : v)));
  }, []);

  // ---- photo grid: rendered mockups + user-uploaded photos, one Etsy image slot each ----
  const [ownImages, setOwnImages] = useState<OwnImage[]>([]);
  const [imageOrder, setImageOrder] = useState<ImageSlotRef[]>([]);
  const [altTextBySlot, setAltTextBySlot] = useState<Record<string, string>>({});
  const [enlargedSlotId, setEnlargedSlotId] = useState<string | null>(null);
  const [jobThumbs, setJobThumbs] = useState<Record<string, string>>({});

  const addOwnImages = useCallback((files: File[]) => {
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
    setEnlargedSlotId((cur) => (cur === `own:${id}` ? null : cur));
  }, []);

  function setAltText(slotId: string, text: string) {
    setAltTextBySlot((prev) => ({ ...prev, [slotId]: text.slice(0, MAX_ALT_TEXT_LENGTH) }));
  }

  function moveImageSlot(from: number, to: number) {
    setImageOrder((prev) => {
      if (from < 0 || from >= prev.length || to < 0 || to >= prev.length || from === to) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }

  const psdInput = useRef<HTMLInputElement>(null);
  const designInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    // Every active listing, not just a page of them — the picker filters
    // titles itself (see ListingPicker), so it needs the whole shop up front.
    fetch("/api/etsy/listings?state=active&all=true", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          body: {
            listings?: { listingId: number; title: string; thumbnailUrl: string | null }[];
          } | null,
        ) => {
          if (!body?.listings) return;
          const mapped = body.listings.map((l) => ({
            listingId: l.listingId,
            title: l.title,
            thumbnailUrl: l.thumbnailUrl,
          }));
          setListings(mapped);
          setSelectedListing((cur) => cur ?? mapped[0] ?? null);
        },
      )
      .catch(() => {
        /* not connected / no shop — the publish control just stays hidden */
      })
      .finally(() => setListingsLoading(false));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    fetch("/api/etsy/shop")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { shopName?: string } | null) => setShopName(body?.shopName ?? null))
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
    setError(null);
    const added: MockupItem[] = [];
    for (let i = 0; i < psds.length; i++) {
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

        const scale = Math.min(
          1,
          PREVIEW_MAX / Math.max(body.psd.width, body.psd.height),
        );
        const compositeBlob = dataUrlToBlob(body.composite);
        const compositeFile = new File(
          [compositeBlob],
          `${stripExt(file.name)}.png`,
          { type: "image/png" },
        );
        const mockRaster = await blobToRaster(compositeBlob, { scale });
        const overlays: OverlayMeta[] = await Promise.all(
          body.overlays.map(async (ov) => {
            const blob = dataUrlToBlob(ov.image);
            return {
              file: new File([blob], `${ov.name || "overlay"}.png`, {
                type: "image/png",
              }),
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

        added.push({
          id: uid(),
          name: stripExt(file.name),
          file: compositeFile,
          psdW: body.psd.width,
          psdH: body.psd.height,
          contentHash: body.contentHash,
          previewScale: scale,
          mockRaster,
          overlays,
          areaNames: body.areaNames ?? [],
          calibration: body.savedCalibration ?? body.suggestedCalibration,
          hasSavedCalibration: !!body.savedCalibration,
          include: true,
          tone: body.tone?.tone ?? null,
        });
      } catch (err) {
        setError(`${file.name}: ${err instanceof Error ? err.message : "could not be read"}`);
      }
    }
    if (added.length) {
      setMockups((prev) => [...prev, ...added]);
      setActiveId((cur) => cur ?? added[0].id);
    }
    setBusy(null);
  }, []);

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
  // end, and refs pointing at something removed are dropped.
  useEffect(() => {
    // Reconciling derived state against two other state values (not a DOM/
    // external-system sync) — an intentional synchronous update.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setImageOrder((prev) => {
      const validJobKeys = new Set(currentJobRefs.map((r) => r.key));
      const validOwnIds = new Set(ownImages.map((o) => o.id));
      const kept = prev.filter((r) => (r.kind === "job" ? validJobKeys.has(r.key) : validOwnIds.has(r.id)));
      const keptJobKeys = new Set(
        kept.filter((r): r is { kind: "job"; key: string } => r.kind === "job").map((r) => r.key),
      );
      const keptOwnIds = new Set(
        kept.filter((r): r is { kind: "own"; id: string } => r.kind === "own").map((r) => r.id),
      );
      const newJobs = currentJobRefs.filter((r) => !keptJobKeys.has(r.key));
      const newOwn = ownImages
        .filter((o) => !keptOwnIds.has(o.id))
        .map((o): ImageSlotRef => ({ kind: "own", id: o.id }));
      const next = [...kept, ...newJobs, ...newOwn];
      if (next.length === prev.length && next.every((r, i) => slotIdFor(r) === slotIdFor(prev[i]))) {
        return prev; // unchanged — avoid a pointless re-render
      }
      return next;
    });
  }, [currentJobRefs, ownImages]);

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
        const own = ownImages.find((o) => o.id === ref.id);
        return { slotId, ref, thumbnailUrl: own?.url ?? null, label: own?.file.name ?? "Photo" };
      }),
    [imageOrder, jobThumbs, included, designs, ownImages],
  );
  const publishCount = Math.min(photoSlots.length, MAX_LISTING_IMAGES);
  const enlargedSlot = photoSlots.find((s) => s.slotId === enlargedSlotId) ?? null;

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
      for (const m of included) fd.append("mockup", m.file);
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
        const jobIndexFor = (key: string): number | null => {
          const [mockupId, designId] = key.split("::");
          const i = included.findIndex((m) => m.id === mockupId);
          const k = designs.findIndex((d) => d.id === designId);
          return i < 0 || k < 0 ? null : i * designs.length + k;
        };
        payload.imageOrder = imageOrder
          .map((ref) => {
            if (ref.kind === "job") {
              const index = jobIndexFor(ref.key);
              return index == null ? null : { kind: "job" as const, index };
            }
            const index = ownImages.findIndex((o) => o.id === ref.id);
            return index < 0 ? null : { kind: "own" as const, index };
          })
          .filter((e): e is { kind: "job" | "own"; index: number } => e != null);
      }

      fd.set("payload", JSON.stringify(payload));
      return fd;
    },
    [included, designs, ownImages, imageOrder, altTextBySlot],
  );

  const runBatch = useCallback(async () => {
    if (!included.length || !designs.length) return;
    setError(null);
    setPublishResult(null);
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
  }, [included, designs, jobCount, buildBatchForm]);

  const publishToEtsy = useCallback(async () => {
    if (photoSlots.length === 0 || publishId == null) return;
    if (publishMode === "new" && !listingForm.title.trim()) {
      setError("Enter a title for the new draft (Listing information form).");
      return;
    }
    if (publishMode === "new" && listingForm.readinessStateId == null) {
      setError("Choose a processing profile for the new draft (Shipping tab).");
      return;
    }
    setError(null);
    setPublishResult(null);
    try {
      setBusy(
        publishMode === "existing"
          ? `Adding ${publishCount} images to Etsy…`
          : "Creating draft and uploading images…",
      );
      const publishTo: Record<string, unknown> = {
        mode: publishMode,
        listingId: publishId,
      };
      if (publishMode === "existing") publishTo.overwrite = overwriteExisting;
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
          variations: buildVariationsPayload(listingForm),
          // featured_rank/should_auto_renew aren't settable on createDraftListing —
          // the server sends them via a follow-up updateListing call.
          featuredRank: listingForm.featureListing ? 1 : undefined,
          shouldAutoRenew: listingForm.autoRenew,
        };
      }

      const fd = buildBatchForm(publishTo);
      for (const v of videos) if (v) fd.append("video", v);
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
      setPublishResult({
        mode: body.mode ?? publishMode,
        listingId: body.listingId ?? publishId,
        createdDraft: !!body.createdDraft,
        uploaded: body.uploaded ?? [],
        failed: body.failed ?? [],
        skipped: body.skipped ?? 0,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Etsy upload failed.");
    } finally {
      setBusy(null);
    }
  }, [
    photoSlots,
    publishId,
    publishMode,
    overwriteExisting,
    listingForm,
    publishCount,
    buildBatchForm,
    videos,
  ]);

  const areaCount = active ? quadList(active.calibration).length : 0;
  const areaIndex = Math.min(activeArea, Math.max(0, areaCount - 1));

  /** Drives the small incomplete-field dot next to each nav item — a light heuristic, not full Etsy validation. */
  function isTabIncomplete(tab: NavTab): boolean {
    switch (tab) {
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

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <header className="sticky top-0 z-20 border-b border-black/10 bg-zinc-50/95 px-6 py-3 backdrop-blur dark:border-white/15 dark:bg-black/95">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-3">
          <Link
            href="/"
            className="text-sm text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            ← Back
          </Link>
          <div className="min-w-0">
            <p className="truncate text-xs text-zinc-500">{shopName ?? "Your shop"}</p>
            <p className="truncate text-sm font-semibold text-black dark:text-zinc-50">
              {listingForm.title.trim() || "Untitled listing"}
            </p>
          </div>

          {(listingsLoading || listings.length > 0) && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {(
                [
                  ["copy", "Copy → to a copy"],
                  ["new", "New draft → to it"],
                  ["existing", "Add to selected listing"],
                ] as const
              ).map(([m, lbl]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setPublishMode(m)}
                  className={`h-8 rounded-full px-3 text-xs font-medium ${
                    publishMode === m
                      ? "bg-black text-white dark:bg-white dark:text-black"
                      : "border border-black/10 text-zinc-600 dark:border-white/15 dark:text-zinc-400"
                  }`}
                >
                  {lbl}
                </button>
              ))}
              <ListingPicker
                listings={listings}
                loading={listingsLoading}
                value={selectedListing}
                onChange={setSelectedListing}
                disabled={!!busy}
              />
              <button
                type="button"
                onClick={publishToEtsy}
                disabled={!!busy || publishCount === 0 || publishId == null || needsReadinessState}
                className="h-9 rounded-full border border-[#f56400] px-4 text-sm font-medium text-[#f56400] transition-colors hover:bg-[#f56400]/10 disabled:opacity-40"
              >
                {publishMode === "existing"
                  ? `Add (${publishCount})`
                  : `Create draft & upload (${publishCount})`}
              </button>
            </div>
          )}
        </div>

        {(listingsLoading || listings.length > 0) && (
          <div className="mx-auto mt-2 w-full max-w-7xl space-y-1">
            {publishMode === "existing" && (
              <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                <input
                  type="checkbox"
                  checked={overwriteExisting}
                  onChange={(e) => setOverwriteExisting(e.target.checked)}
                  className="accent-[#f56400]"
                />
                replace existing images (in rank order)
              </label>
            )}
            {needsReadinessState && (
              <p className="text-xs font-medium text-[#f56400]">
                Choose a processing profile on the Shipping tab before creating this draft.
              </p>
            )}
            <p className="text-xs text-zinc-500">
              {publishMode === "existing"
                ? overwriteExisting
                  ? "The selected listing's first images will be replaced with these renders."
                  : `Images are added to the selected listing (anything past the ${MAX_LISTING_IMAGES}-image limit is skipped). No images are deleted.`
                : "A new draft listing is created and images are uploaded to it. The live listing is never touched."}
            </p>
          </div>
        )}
      </header>

      <div className="mx-auto w-full max-w-7xl px-6 py-8">
        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
            {error}
          </div>
        )}

        {publishResult && (
          <div className="mb-4 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/50 dark:text-green-300">
            {publishResult.createdDraft
              ? `Draft listing #${publishResult.listingId} created · `
              : ""}
            {publishResult.uploaded.length} images uploaded
            {publishResult.skipped > 0 &&
              ` · ${publishResult.skipped} skipped (${MAX_LISTING_IMAGES}-image limit)`}
            {publishResult.createdDraft && (
              <>
                {" · "}
                <a
                  href={`https://www.etsy.com/your/shops/me/listings/${publishResult.listingId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Open on Etsy
                </a>
              </>
            )}
            {publishResult.failed.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-red-700 dark:text-red-300">
                {publishResult.failed.slice(0, 5).map((f, i) => (
                  <li key={i}>
                    {f.name}: {f.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex flex-col gap-6 lg:flex-row">
          {/* ---- left nav ---- */}
          <nav className="lg:w-[200px] lg:shrink-0">
            <ul className="space-y-0.5">
              {NAV_ITEMS.map((item) => {
                const isActive = activeTab === item.key;
                const incomplete = isTabIncomplete(item.key);
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      onClick={() => setActiveTab(item.key)}
                      className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                        isActive
                          ? "bg-black text-white dark:bg-white dark:text-black"
                          : "text-zinc-600 hover:bg-black/[.04] dark:text-zinc-400 dark:hover:bg-white/[.06]"
                      }`}
                    >
                      <span>{item.label}</span>
                      {incomplete && (
                        <span
                          aria-label={`${item.label} incomplete`}
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            isActive ? "bg-white dark:bg-black" : "bg-[#f56400]"
                          }`}
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* ---- right: active tab's panel ---- */}
          <div className="min-w-0 flex-1 rounded-xl border border-black/10 bg-white p-4 dark:border-white/15 dark:bg-zinc-950 md:p-6">
            {activeTab === "photos" && (
              <div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-50">Photos</h3>
                  <button
                    type="button"
                    onClick={runBatch}
                    disabled={!!busy || jobCount === 0}
                    className="h-9 rounded-full bg-[#f56400] px-4 text-sm font-medium text-white transition-colors hover:bg-[#d95700] disabled:opacity-40"
                  >
                    {busy ?? `Batch render & download (${jobCount})`}
                  </button>
                </div>

                <div className="mt-4 grid gap-6 lg:grid-cols-[260px_1fr_260px]">
                  {/* ---- left: lists ---- */}
                  <div className="space-y-6">
                    <Dropzone
                      label="Mockup PSDs"
                      accept=".psd"
                      inputRef={psdInput}
                      onFiles={addPsds}
                    />
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
                              if (Number.isFinite(from)) moveMockup(from, i);
                            }}
                          >
                            <div
                              className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm ${
                                m.id === activeId
                                  ? "border-[#f56400] bg-[#f56400]/5"
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
                                  setMockups((prev) =>
                                    prev.map((x) =>
                                      x.id === m.id
                                        ? { ...x, include: e.target.checked }
                                        : x,
                                    ),
                                  )
                                }
                                className="accent-[#f56400]"
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
                                onClick={() => deleteMockup(m.id)}
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
                      onFiles={addDesigns}
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
                                  ? "border-[#f56400] ring-2 ring-[#f56400]/40"
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
                          onAreaChange={onAreaChange}
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
                                onChange={(e) => onSlider(s.key, Number(e.target.value))}
                                className="mt-1 w-full accent-[#f56400]"
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

                <PhotoGrid
                  slots={photoSlots}
                  onMove={moveImageSlot}
                  onEnlarge={setEnlargedSlotId}
                  onAddOwn={addOwnImages}
                />

                <div className="mt-8 border-t border-black/10 pt-6 dark:border-white/15">
                  <VideoSection videos={videos} errors={videoErrors} onSelect={selectVideo} />
                </div>
              </div>
            )}

            {activeTab === "personalization" && <ComingNextPanel label="Personalization" />}

            <ListingForm
              value={listingForm}
              onChange={setListingForm}
              activeTab={isListingFormTab(activeTab) ? activeTab : null}
              onGoToTab={setActiveTab}
            />
          </div>
        </div>
      </div>

      {enlargedSlot && (
        <PhotoEnlargeModal
          slot={enlargedSlot}
          index={photoSlots.findIndex((s) => s.slotId === enlargedSlot.slotId)}
          altText={altTextBySlot[enlargedSlot.slotId] ?? ""}
          onAltTextChange={(text) => setAltText(enlargedSlot.slotId, text)}
          onMakeThumbnail={() => {
            const from = photoSlots.findIndex((s) => s.slotId === enlargedSlot.slotId);
            if (from > 0) moveImageSlot(from, 0);
          }}
          onRemove={
            enlargedSlot.ref.kind === "own"
              ? () => {
                  removeOwnImage(enlargedSlot.ref.kind === "own" ? enlargedSlot.ref.id : "");
                }
              : undefined
          }
          onClose={() => setEnlargedSlotId(null)}
        />
      )}
    </div>
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
            ? "border-[#f56400] bg-[#f56400]/5"
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

/**
 * One video, uploaded to the target listing in the same publish call as the
 * rendered images (once the listing exists). Format and size are checked as
 * soon as a file is picked; duration is checked once the browser can decode
 * its metadata — an unreadable duration (an unusual codec) doesn't block the
 * file, since Etsy is still the final check.
 */
/**
 * The listing's photo slots: rendered mockups (in mockup×design order) and
 * user-uploaded photos, filling Etsy's `MAX_LISTING_IMAGES` image slots.
 * Filled slots are draggable to reorder — that order becomes the Etsy upload
 * rank, so slot 1 is always the listing thumbnail. Empty slots are shown so
 * the user can see how many are left.
 */
function PhotoGrid({
  slots,
  onMove,
  onEnlarge,
  onAddOwn,
}: {
  slots: PhotoSlot[];
  onMove: (from: number, to: number) => void;
  onEnlarge: (slotId: string) => void;
  onAddOwn: (files: File[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const emptyCount = Math.max(0, MAX_LISTING_IMAGES - slots.length);

  return (
    <div className="mt-6 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-bold text-zinc-900 dark:text-zinc-50">
          Photos{" "}
          <span className="font-normal text-zinc-500">
            ({slots.length}/{MAX_LISTING_IMAGES})
          </span>
        </h4>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="h-8 rounded-full border border-black/10 px-3 text-xs font-medium hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
        >
          Upload your own
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_IMAGE_EXTENSIONS.map((e) => `.${e}`).join(",")}
          multiple
          hidden
          onChange={(e) => {
            onAddOwn([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>

      <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
        {slots.map((slot, i) => (
          <button
            key={slot.slotId}
            type="button"
            draggable
            onClick={() => onEnlarge(slot.slotId)}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", String(i));
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const from = Number(e.dataTransfer.getData("text/plain"));
              if (Number.isFinite(from)) onMove(from, i);
            }}
            title={slot.label}
            className="group relative aspect-square cursor-grab overflow-hidden rounded-lg border border-black/10 bg-zinc-100 active:cursor-grabbing dark:border-white/15 dark:bg-zinc-900"
          >
            {slot.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={slot.thumbnailUrl}
                alt={slot.label}
                className="h-full w-full object-cover"
                draggable={false}
              />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[10px] text-zinc-400">
                Rendering…
              </span>
            )}
            <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] font-medium text-white">
              {i === 0 ? "Thumbnail" : i + 1}
            </span>
          </button>
        ))}

        {Array.from({ length: emptyCount }).map((_, i) => (
          <div
            key={`empty-${i}`}
            className="flex aspect-square items-center justify-center rounded-lg border-2 border-dashed border-black/10 text-[10px] text-zinc-400 dark:border-white/15"
          >
            {slots.length + i + 1}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Enlarged view of one photo-grid slot, with its alt-text field and character counter. */
function PhotoEnlargeModal({
  slot,
  index,
  altText,
  onAltTextChange,
  onMakeThumbnail,
  onRemove,
  onClose,
}: {
  slot: PhotoSlot;
  index: number;
  altText: string;
  onAltTextChange: (text: string) => void;
  onMakeThumbnail: () => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={slot.label}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-xl dark:bg-zinc-950 sm:flex-row"
      >
        <div className="flex min-h-0 flex-1 items-center justify-center bg-zinc-100 p-2 dark:bg-zinc-900">
          {slot.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={slot.thumbnailUrl}
              alt={slot.label}
              className="max-h-[70vh] w-full object-contain sm:max-h-[80vh]"
            />
          ) : (
            <p className="p-10 text-sm text-zinc-500">Rendering…</p>
          )}
        </div>

        <div className="w-full space-y-3 p-4 sm:w-72">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
              {index === 0 ? "Listing thumbnail" : slot.label}
            </p>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="shrink-0 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            >
              ×
            </button>
          </div>

          <label className="block text-sm">
            <span className="flex justify-between text-xs text-zinc-500">
              <span>Alt text</span>
              <span className="font-mono">
                {altText.length}/{MAX_ALT_TEXT_LENGTH}
              </span>
            </span>
            <textarea
              rows={4}
              value={altText}
              maxLength={MAX_ALT_TEXT_LENGTH}
              onChange={(e) => onAltTextChange(e.target.value)}
              placeholder="Describe this image for screen readers and search…"
              className="mt-1 w-full resize-y rounded-lg border border-black/10 bg-white px-2 py-1.5 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-900"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            {index > 0 && (
              <button
                type="button"
                onClick={onMakeThumbnail}
                className="h-8 rounded-full border border-black/10 px-3 text-xs font-medium hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
              >
                Make listing thumbnail
              </button>
            )}
            {onRemove && (
              <button
                type="button"
                onClick={() => {
                  onRemove();
                  onClose();
                }}
                className="h-8 rounded-full border border-red-200 px-3 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:hover:bg-red-950/50"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Video slots — one per `MAX_LISTING_VIDEOS`, matching Etsy's per-listing
 * video cap, each independently uploaded/removed. Format and size are
 * checked as soon as a file is picked; duration is checked once the browser
 * can decode its metadata — an unreadable duration (an unusual codec)
 * doesn't block the file, since Etsy is still the final check.
 */
function VideoSection({
  videos,
  errors,
  onSelect,
}: {
  videos: (File | null)[];
  errors: (string | null)[];
  onSelect: (slot: number, file: File | null) => void;
}) {
  return (
    <div className="space-y-4">
      <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-50">Video</h3>
      <p className="text-sm text-zinc-500">
        Up to {MAX_LISTING_VIDEOS} videos, {Math.round(MAX_VIDEO_SIZE_BYTES / (1024 * 1024))} MB
        each, {MIN_VIDEO_DURATION_SECONDS}-{MAX_VIDEO_DURATION_SECONDS} seconds long. Accepted
        formats: {ACCEPTED_VIDEO_EXTENSIONS.join(", ").toUpperCase()}. Etsy removes audio on
        upload.
      </p>
      <div className="flex flex-wrap gap-4">
        {videos.map((video, i) => (
          <VideoSlot
            key={i}
            slot={i}
            video={video}
            error={errors[i] ?? null}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

function VideoSlot({
  slot,
  video,
  error,
  onSelect,
}: {
  slot: number;
  video: File | null;
  error: string | null;
  onSelect: (slot: number, file: File | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const url = useMemo(() => (video ? URL.createObjectURL(video) : null), [video]);
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  return (
    <div className="w-64 space-y-2">
      {error && <p className="text-xs font-medium text-red-600">{error}</p>}
      {video && url ? (
        <>
          <video
            src={url}
            controls
            className="w-full rounded-lg border border-black/10 dark:border-white/15"
          />
          <div className="flex items-center justify-between gap-2 text-xs text-zinc-500">
            <span className="min-w-0 truncate">
              {video.name} · {(video.size / (1024 * 1024)).toFixed(1)} MB
            </span>
            <button
              type="button"
              onClick={() => onSelect(slot, null)}
              className="shrink-0 font-medium text-red-600 hover:underline"
            >
              Remove
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex h-36 w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-black/15 px-4 text-sm text-zinc-500 hover:border-black/30 dark:border-white/20 dark:hover:border-white/40"
        >
          <span className="font-medium text-zinc-700 dark:text-zinc-300">Upload a video</span>
          <span>Slot {slot + 1}</span>
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => {
          onSelect(slot, e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** Placeholder panel for nav tabs whose Etsy calls aren't wired up yet. */
function ComingNextPanel({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-black/15 p-10 text-center dark:border-white/20">
      <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-50">{label}</h3>
      <p className="mt-1 text-sm text-zinc-500">Coming next.</p>
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

/**
 * Visual listing picker: a closed button showing the current pick, opening a
 * dropdown where each row is a large thumbnail + the first 40 characters of
 * the title (a plain `<select>` can't render images in its options).
 *
 * `listings` is the WHOLE shop (see the `all=true` fetch in the page
 * component) — filtering is a plain, literal, case-insensitive title
 * substring match done right here, not Etsy's own shop search (which ranks
 * by relevance across title/tags/materials/description and readily returns
 * listings whose title never contains what you typed).
 */
function ListingPicker({
  listings,
  loading,
  value,
  onChange,
  disabled,
}: {
  listings: ListingOption[];
  loading: boolean;
  value: ListingOption | null;
  onChange: (listing: ListingOption) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onOutside);
    return () => document.removeEventListener("pointerdown", onOutside);
  }, [open]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return listings;
    return listings.filter((l) => l.title.toLowerCase().includes(q));
  }, [listings, query]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex h-11 items-center gap-2 rounded-lg border border-black/10 bg-white pr-3 pl-1.5 text-left text-sm disabled:opacity-50 dark:border-white/15 dark:bg-zinc-950"
      >
        <ListingThumb url={value?.thumbnailUrl ?? null} size={32} />
        <span className="max-w-[200px] truncate">
          {value ? shortTitle(value.title) : loading ? "Loading listings…" : "Select a listing"}
        </span>
        <span className="text-zinc-400">▾</span>
      </button>

      {open && (
        <div className="absolute z-10 mt-1 w-80 overflow-hidden rounded-lg border border-black/10 bg-white shadow-lg dark:border-white/15 dark:bg-zinc-950">
          <div className="border-b border-black/10 p-2 dark:border-white/15">
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title…"
              className="h-8 w-full rounded-md border border-black/10 bg-white px-2 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-900"
            />
          </div>
          <ul className="max-h-72 overflow-y-auto py-1">
            {loading && (
              <li className="px-2 py-3 text-center text-xs text-zinc-500">
                Loading listings…
              </li>
            )}
            {!loading && rows.length === 0 && (
              <li className="px-2 py-3 text-center text-xs text-zinc-500">
                {query.trim() ? "No matching listings." : "No listings."}
              </li>
            )}
            {!loading &&
              rows.map((l) => (
                <li key={l.listingId}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(l);
                      setOpen(false);
                      setQuery("");
                    }}
                    className={`flex w-full items-center gap-3 px-2 py-2 text-left text-sm hover:bg-black/[.04] dark:hover:bg-white/[.06] ${
                      l.listingId === value?.listingId ? "bg-[#f56400]/10" : ""
                    }`}
                  >
                    <ListingThumb url={l.thumbnailUrl} size={48} />
                    <span className="flex-1 truncate">{shortTitle(l.title)}</span>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
