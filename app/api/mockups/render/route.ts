import { NextResponse } from "next/server";
import { getEtsySession } from "@/lib/etsy/auth";
import { createDraftListing, updateVariationImages } from "@/lib/etsy/listing-create";
import { fetchListingDetails } from "@/lib/etsy/listing-details";
import { uploadListingImage } from "@/lib/etsy/listing-images";
import {
  applyListingMediaEdit,
  parseMediaOrder,
  planListingMediaEdit,
  type ImagePlacement,
} from "@/lib/etsy/listing-media-edit";
import { MAX_LISTING_IMAGES } from "@/lib/etsy/listing-image-limits";
import type { PersonalizationQuestionInput } from "@/lib/etsy/listing-personalization";
import { uploadListingVideo } from "@/lib/etsy/listing-video";
import { EtsyApiError, getShopId } from "@/lib/etsy/listings";
import {
  applyListingDetails,
  resolveDraftListingInput,
  sanitizeHowItsMade,
  sanitizePersonalization,
  type CleanVariations,
  type ListingCreationPlan,
  type PublishSpec,
  type ValidHowItsMade,
} from "@/lib/etsy/publish-listing";
import { MAX_LISTING_VIDEOS, checkVideoFileBasics } from "@/lib/etsy/video-limits";
import { getRenderPool } from "@/lib/mockup/render-pool";
import type { RenderJobInput } from "@/lib/mockup/render-types";
import {
  clamp,
  coerceCalibration,
  normalizeBlendMode,
  num,
} from "@/lib/mockup/validate";
import { StoreZip } from "@/lib/mockup/zip-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_TOTAL_BYTES = 400 * 1024 * 1024;
const MAX_FILES = 400;
const MAX_JOBS = 500;
const MAX_DIMENSION = 8000;
const DEFAULT_TARGET_MB: [number, number] = [1.2, 1.7];

interface OverlaySpec {
  file: number;
  x?: number;
  y?: number;
  blend?: string;
  alpha?: number;
  clip?: boolean;
  name?: string;
}
interface MockupSpec {
  name?: string;
  width?: number;
  height?: number;
  calibration?: unknown;
  overlays?: OverlaySpec[];
}
interface JobSpec {
  mockup: number;
  design?: number | null;
  areaDesigns?: (number | null)[];
  name?: string;
  /** Sent as this image's `alt_text` on upload — see `MAX_ALT_TEXT_LENGTH`. */
  altText?: string;
}
/** A user-supplied photo (the `ownImage` file at the same index) — uploaded as-is, no compositing. */
interface OwnImageSpec {
  name?: string;
  altText?: string;
}
/** One entry in the client's chosen upload order — see `payload.imageOrder`. */
interface ImageOrderEntry {
  kind: "job" | "own";
  index: number;
}
interface RenderPayload {
  format?: "jpeg" | "png";
  targetMB?: [number, number];
  namePattern?: string;
  zipName?: string;
  mockups?: MockupSpec[];
  designs?: { name?: string }[];
  jobs?: JobSpec[];
  /** User-uploaded photos (the `ownImage` files, addressed by index) — publish-only. */
  ownImages?: OwnImageSpec[];
  /**
   * The final upload order across rendered jobs and `ownImages`, publish-only.
   * Omitted -> every job in order, then every own image in order (unchanged
   * behavior for callers that don't send it).
   */
  imageOrder?: ImageOrderEntry[];
  /**
   * "existing" mode only: the grid is the listing's whole photo set — `imageOrder`
   * may also hold `{ kind: "etsy", imageId, altText }` for photos already on it,
   * and `videoOrder` (`{ kind: "existing", videoId } | { kind: "new", index }`,
   * `index` into the `video` files) its whole video set. See `listing-media-edit.ts`.
   */
  editExisting?: boolean;
  videoOrder?: unknown;
  /** When set, upload the renders to this Etsy listing instead of zipping. */
  publishTo?: PublishSpec;
}

const FORBIDDEN_NAME_CHARS = '/\\:*?"<>|';

/** Longest run of trailing `[a-z0-9]` after a dot, lowercased — "jpg" when there is none. */
function extOf(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename);
  return m ? m[1].toLowerCase() : "jpg";
}

/** Strip path separators and control characters from a would-be filename. */
function sanitize(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || FORBIDDEN_NAME_CHARS.includes(ch) ? "-" : ch;
  }
  return (out.trim() || "mockup").slice(0, 180);
}

const isIndex = (v: unknown, count: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v < count;

/**
 * Validate a client-supplied upload order against the job/own-image arrays
 * actually provided. Malformed or out-of-range entries are dropped
 * individually — the caller falls back to the default order when nothing
 * survives.
 */
function sanitizeImageOrder(raw: unknown, jobCount: number, ownCount: number): ImageOrderEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ImageOrderEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const kind = (e as { kind?: unknown }).kind;
    const index = (e as { index?: unknown }).index;
    if (kind === "job" && isIndex(index, jobCount)) out.push({ kind: "job", index });
    else if (kind === "own" && isIndex(index, ownCount)) out.push({ kind: "own", index });
  }
  return out;
}

/**
 * The edited grid of an existing listing, in order: photos already on it by
 * Etsy id, and rendered jobs / own images as new uploads. Malformed entries
 * are dropped individually.
 */
function sanitizeEditOrder(
  raw: unknown,
  jobs: JobSpec[],
  ownImages: OwnImageSpec[],
): ImagePlacement<ImageOrderEntry>[] {
  if (!Array.isArray(raw)) return [];
  const out: ImagePlacement<ImageOrderEntry>[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const r = e as { kind?: unknown; index?: unknown; imageId?: unknown; altText?: unknown };
    if (r.kind === "etsy" && typeof r.imageId === "number" && Number.isInteger(r.imageId) && r.imageId > 0) {
      out.push({ kind: "existing", imageId: r.imageId, altText: typeof r.altText === "string" ? r.altText : "" });
    } else if (r.kind === "job" && isIndex(r.index, jobs.length)) {
      out.push({ kind: "new", item: { kind: "job", index: r.index }, altText: jobs[r.index].altText ?? "" });
    } else if (r.kind === "own" && isIndex(r.index, ownImages.length)) {
      out.push({ kind: "new", item: { kind: "own", index: r.index }, altText: ownImages[r.index].altText ?? "" });
    }
  }
  return out;
}


/**
 * Batch-render every job and stream the results back as a ZIP.
 *
 * `POST /api/mockups/render` — `multipart/form-data`:
 *   - `mockup`   (file, repeated)  composites, addressed by index
 *   - `design`   (file, repeated)  designs, addressed by index
 *   - `overlay`  (file, repeated)  overlay images, addressed by index
 *   - `ownImage` (file, repeated)  user-uploaded photos, addressed by index —
 *                                  publish-only, uploaded as-is (no compositing)
 *   - `video`    (file, repeated, up to `MAX_LISTING_VIDEOS`) listing videos —
 *                                  only used with `publishTo`, uploaded once the
 *                                  target listing exists, same as the rendered
 *                                  images. Format/size are re-checked server-side
 *                                  (see `video-limits.ts`); the client is expected
 *                                  to have already checked format/size/duration
 *                                  before sending them.
 *   - `payload` (json string):
 *       {
 *         format?: "jpeg" | "png",           // default "jpeg"
 *         targetMB?: [lo, hi],               // JPEG size window, default [1.2, 1.7]
 *         namePattern?: "{design}_{mockup}", // output basename template
 *         zipName?: "mockups.zip",
 *         mockups: [{ name, width?, height?, calibration, overlays?: [{ file, x, y, blend, alpha, clip, name }] }],
 *         designs: [{ name }],
 *         jobs:    [{ mockup, design?, areaDesigns?, name?, altText? }],
 *         ownImages?: [{ name?, altText? }],     // aligned with `ownImage` files
 *         imageOrder?: [{ kind: "job"|"own", index }], // publish-only; default: every job, then every own image
 *       }
 *
 * Each job runs on the `worker_threads` render pool (the shared `lib/mockup`
 * compositor plus a JPEG quality search to the target window). Per-job failures
 * do not abort the batch — they are collected into a `_errors.txt` entry. The
 * response streams as jobs finish, so the request/response shape already fits a
 * future async `jobId` + progress-poll variant.
 *
 * With `payload.publishTo` the renders go to Etsy (first {@link MAX_LISTING_IMAGES},
 * sequential ranks) and the response is JSON, not a ZIP. `mode`:
 *   - "existing" — add to `listingId` (only replaces if `overwrite: true`); with
 *                  `editExisting`, the grid replaces the listing's photos/videos instead
 *                  (reorder, remove, alt text, new files — see `listing-media-edit.ts`)
 *   - "copy"     — new draft seeded from `listingId`
 *   - "new"      — new draft from `newListing`, category/shipping borrowed from `listingId`
 * A live listing is never modified except an explicit "existing" publish.
 *
 * "copy" and "new" both require `publishTo.howItsMade` (`who_made`/`is_supply`/
 * `when_made`/`production_partner_ids`) — always the caller's own choice, never
 * borrowed from `listingId`'s source listing. A combination Etsy's marketplace-
 * eligibility check would reject (see `listing-classification.ts`) is rejected
 * here first, with a clear message, instead of surfacing as a bare 400 from Etsy.
 */
export async function POST(request: Request) {
  if (!(await getEtsySession())) {
    return NextResponse.json({ error: "Not connected to Etsy." }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data." }, { status: 400 });
  }

  const mockupFiles = form.getAll("mockup").filter((f): f is File => f instanceof File);
  const designFiles = form.getAll("design").filter((f): f is File => f instanceof File);
  const overlayFiles = form.getAll("overlay").filter((f): f is File => f instanceof File);
  const ownImageFiles = form.getAll("ownImage").filter((f): f is File => f instanceof File);
  const videoFiles = form
    .getAll("video")
    .filter((f): f is File => f instanceof File && f.size > 0)
    .slice(0, MAX_LISTING_VIDEOS);
  for (const videoFile of videoFiles) {
    const videoError = checkVideoFileBasics(videoFile);
    if (videoError) return NextResponse.json({ error: videoError }, { status: 400 });
  }

  if (
    mockupFiles.length + designFiles.length + overlayFiles.length + ownImageFiles.length >
    MAX_FILES
  ) {
    return NextResponse.json({ error: `Too many files (max ${MAX_FILES}).` }, { status: 413 });
  }
  const totalBytes = [...mockupFiles, ...designFiles, ...overlayFiles, ...ownImageFiles].reduce(
    (a, f) => a + f.size,
    0,
  );
  if (totalBytes > MAX_TOTAL_BYTES) {
    return NextResponse.json({ error: "Upload too large." }, { status: 413 });
  }

  let payload: RenderPayload;
  try {
    payload = JSON.parse(String(form.get("payload") ?? "{}")) as RenderPayload;
  } catch {
    return NextResponse.json({ error: "`payload` is not valid JSON." }, { status: 400 });
  }
  const editExisting =
    payload.editExisting === true &&
    !!payload.publishTo &&
    typeof payload.publishTo === "object" &&
    payload.publishTo.mode !== "copy" &&
    payload.publishTo.mode !== "new";
  if (mockupFiles.length === 0 && ownImageFiles.length === 0 && !editExisting) {
    return NextResponse.json(
      { error: "At least one `mockup` or `ownImage` file is required." },
      { status: 400 },
    );
  }

  const mockups = Array.isArray(payload.mockups) ? payload.mockups : [];
  const designs = Array.isArray(payload.designs) ? payload.designs : [];
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
  const ownImages = Array.isArray(payload.ownImages) ? payload.ownImages : [];

  if (mockups.length !== mockupFiles.length) {
    return NextResponse.json(
      { error: "`payload.mockups` length must match the number of `mockup` files." },
      { status: 400 },
    );
  }
  if (designs.length !== designFiles.length) {
    return NextResponse.json(
      { error: "`payload.designs` length must match the number of `design` files." },
      { status: 400 },
    );
  }
  if (ownImages.length !== ownImageFiles.length) {
    return NextResponse.json(
      { error: "`payload.ownImages` length must match the number of `ownImage` files." },
      { status: 400 },
    );
  }
  // A zip/download request always needs at least one job. A publish request
  // may consist entirely of user-uploaded photos with no rendered mockups.
  if (jobs.length === 0 && !(ownImages.length > 0 && payload.publishTo) && !editExisting) {
    return NextResponse.json({ error: "`payload.jobs` is empty." }, { status: 400 });
  }
  if (jobs.length > MAX_JOBS) {
    return NextResponse.json({ error: `Too many jobs (max ${MAX_JOBS}).` }, { status: 413 });
  }

  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    if (!isIndex(j.mockup, mockupFiles.length)) {
      return NextResponse.json({ error: `jobs[${i}].mockup out of range.` }, { status: 400 });
    }
    if (j.design != null && !isIndex(j.design, designFiles.length)) {
      return NextResponse.json({ error: `jobs[${i}].design out of range.` }, { status: 400 });
    }
    if (
      j.areaDesigns != null &&
      (!Array.isArray(j.areaDesigns) ||
        j.areaDesigns.some((k) => k != null && !isIndex(k, designFiles.length)))
    ) {
      return NextResponse.json({ error: `jobs[${i}].areaDesigns out of range.` }, { status: 400 });
    }
  }
  for (let i = 0; i < mockups.length; i++) {
    for (const o of mockups[i].overlays ?? []) {
      if (!isIndex(o?.file, overlayFiles.length)) {
        return NextResponse.json(
          { error: `mockups[${i}].overlays references an out-of-range \`file\`.` },
          { status: 400 },
        );
      }
    }
  }

  const format: "jpeg" | "png" = payload.format === "png" ? "png" : "jpeg";
  const tRaw = Array.isArray(payload.targetMB) ? payload.targetMB : DEFAULT_TARGET_MB;
  const targetMin = Math.max(1, num(tRaw[0], DEFAULT_TARGET_MB[0])) * 1024 * 1024;
  const targetMax = Math.max(targetMin + 1, num(tRaw[1], DEFAULT_TARGET_MB[1]) * 1024 * 1024);
  const namePattern =
    typeof payload.namePattern === "string" ? payload.namePattern : "{design}_{mockup}";
  const zipName =
    sanitize(
      typeof payload.zipName === "string"
        ? payload.zipName.replace(/\.zip$/i, "")
        : "mockups",
    ) + ".zip";

  const mockBufs = await Promise.all(mockupFiles.map((f) => f.arrayBuffer()));
  const designBufs = await Promise.all(designFiles.map((f) => f.arrayBuffer()));
  const overlayBufs = await Promise.all(overlayFiles.map((f) => f.arrayBuffer()));
  // Each job transfers (detaches) its buffers to a worker, so hand out copies.
  const copy = (b: ArrayBuffer): ArrayBuffer => b.slice(0);
  const dim = (v: number | undefined): number | undefined =>
    typeof v === "number" && v > 0 ? clamp(Math.round(v), 1, MAX_DIMENSION) : undefined;

  const buildInput = (j: JobSpec): RenderJobInput => {
    const mk = mockups[j.mockup];
    return {
      mock: copy(mockBufs[j.mockup]),
      design: j.design != null ? copy(designBufs[j.design]) : null,
      areaDesigns: Array.isArray(j.areaDesigns)
        ? j.areaDesigns.map((k) => (k != null ? copy(designBufs[k]) : null))
        : null,
      overlays: (mk.overlays ?? []).map((o) => ({
        bytes: copy(overlayBufs[o.file]),
        x: Math.round(num(o.x, 0)),
        y: Math.round(num(o.y, 0)),
        blend: normalizeBlendMode(o.blend),
        alpha: clamp(num(o.alpha, 1), 0, 1),
        clip: !!o.clip,
        name: typeof o.name === "string" ? o.name : "",
      })),
      calibration: coerceCalibration(mk.calibration),
      width: dim(mk.width),
      height: dim(mk.height),
      format,
      targetMin,
      targetMax,
    };
  };

  const label = (j: JobSpec): string => {
    const mk = mockups[j.mockup]?.name ?? `mockup${j.mockup}`;
    const dg = j.design != null ? designs[j.design]?.name ?? `design${j.design}` : "group";
    return `${dg} -> ${mk}`;
  };
  const baseName = (j: JobSpec): string => {
    if (typeof j.name === "string" && j.name.trim()) return sanitize(j.name);
    const mk = mockups[j.mockup]?.name ?? `mockup${j.mockup}`;
    const dg = j.design != null ? designs[j.design]?.name ?? `design${j.design}` : "group";
    return sanitize(namePattern.replaceAll("{design}", dg).replaceAll("{mockup}", mk));
  };

  const zip = new StoreZip();
  const usedNames = new Map<string, number>();
  const failures: string[] = [];
  const encoder = new TextEncoder();
  const pool = getRenderPool();

  const uniqueName = (base: string, ext: string): string => {
    const seen = usedNames.get(base) ?? 0;
    usedNames.set(base, seen + 1);
    return `${seen === 0 ? base : `${base}-${seen + 1}`}.${ext}`;
  };

  // ---- publish branch: render, then push to Etsy ----
  const publish = payload.publishTo;
  if (publish && typeof publish === "object") {
    const mode = publish.mode === "copy" || publish.mode === "new" ? publish.mode : "existing";
    const hasListingId = Number.isInteger(publish.listingId) && (publish.listingId as number) > 0;
    if (!hasListingId && (mode === "existing" || mode === "copy")) {
      return NextResponse.json(
        { error: `publishTo.listingId is required for mode "${mode}".` },
        { status: 400 },
      );
    }
    if (publish.listingId != null && !hasListingId) {
      return NextResponse.json(
        { error: "publishTo.listingId must be a positive integer." },
        { status: 400 },
      );
    }
    const sourceListingId = hasListingId ? (publish.listingId as number) : null;
    if (mode === "new" && !publish.newListing?.title?.trim()) {
      return NextResponse.json(
        { error: "publishTo.newListing.title is required for a new listing." },
        { status: 400 },
      );
    }
    // A brand-new listing with no source to borrow a category from must
    // supply its own — createDraftListing requires taxonomy_id outright.
    if (
      mode === "new" &&
      sourceListingId == null &&
      !(Number.isInteger(publish.newListing?.taxonomyId) && (publish.newListing!.taxonomyId as number) > 0)
    ) {
      return NextResponse.json(
        { error: "Choose a category for the new listing (Details tab)." },
        { status: 400 },
      );
    }
    // Required for every new draft (copy or new) — never borrowed from the
    // source listing (see `getListingStructure`) and never defaulted here;
    // a combination Etsy would reject is caught now, with a clear message,
    // instead of surfacing as a bare 400 once it reaches Etsy.
    let howItsMade: ValidHowItsMade | undefined;
    if (mode !== "existing") {
      const sanitized = sanitizeHowItsMade(publish.howItsMade);
      if ("error" in sanitized) {
        return NextResponse.json({ error: sanitized.error }, { status: 400 });
      }
      howItsMade = sanitized.value;
    }
    // Optional, "copy"/"new" only — an omitted/empty array just means no
    // personalization. A malformed or Etsy-incompatible set is rejected now,
    // with a clear message, instead of surfacing as a bare 400 from Etsy.
    let personalization: PersonalizationQuestionInput[] = [];
    if (mode !== "existing") {
      const sanitized = sanitizePersonalization(publish.personalization);
      if ("error" in sanitized) {
        return NextResponse.json({ error: sanitized.error }, { status: 400 });
      }
      personalization = sanitized.value;
    }
    const startRank =
      typeof publish.startRank === "number" && publish.startRank >= 1
        ? Math.trunc(publish.startRank)
        : 1;
    // A live listing's images are only ever ADDED. Replacing happens only in
    // "existing" mode and only when the caller explicitly opts in.
    const overwrite = mode === "existing" && publish.overwrite === true;
    const contentType = format === "png" ? "image/png" : "image/jpeg";

    // Final upload order across rendered jobs and user-uploaded photos.
    // Explicit `imageOrder` wins when the client sent one (drag-reordered
    // grid); otherwise every job in order, then every own image in order.
    const sanitizedOrder = sanitizeImageOrder(payload.imageOrder, jobs.length, ownImages.length);
    const order: ImageOrderEntry[] =
      sanitizedOrder.length > 0
        ? sanitizedOrder
        : [
            ...jobs.map((_, i) => ({ kind: "job" as const, index: i })),
            ...ownImages.map((_, i) => ({ kind: "own" as const, index: i })),
          ];
    const capped = order.slice(0, MAX_LISTING_IMAGES);
    const skipped = order.length - capped.length;

    let shopId: number;
    // "existing" always has sourceListingId (validated above); "copy"/"new"
    // overwrite this with the freshly created draft's id just below.
    let targetListingId = sourceListingId ?? 0;
    let createdDraft = false;
    const failed: { name: string; error: string }[] = [];
    // Set only in "new" mode when the form sent a variation grid — the single-SKU
    // path below is skipped in that case, and the upload loop below resolves
    // `imagesByValue`'s jobIndex/imageIndex against the images actually uploaded.
    let variations: CleanVariations | null = null;

    try {
      shopId = await getShopId();
      if (mode !== "existing") {
        const plan: ListingCreationPlan = {
          mode,
          sourceListingId,
          // Validated above whenever mode !== "existing" — this block only
          // ever runs in that branch, so `howItsMade` is always set here.
          howItsMade: howItsMade!,
          personalization,
          newListing: publish.newListing ?? {},
          copyTitle: publish.copyTitle,
        };
        const resolved = await resolveDraftListingInput(plan);
        targetListingId = await createDraftListing(shopId, resolved.input);
        createdDraft = true;
        // Settings, personalization, properties and SKU/variations are
        // follow-up calls once the draft exists. Failures there don't block
        // the image upload that follows; they're reported alongside any
        // upload failures instead.
        variations = await applyListingDetails(shopId, targetListingId, plan, resolved, (name, err) => {
          failed.push({ name, error: err instanceof Error ? err.message : "could not be saved" });
        });
      }
    } catch (err) {
      const status = err instanceof EtsyApiError ? err.status : 502;
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Etsy request failed." },
        { status: status >= 400 && status < 600 ? status : 502 },
      );
    }

    if (editExisting) {
      const desiredImages = sanitizeEditOrder(payload.imageOrder, jobs, ownImages);
      if (desiredImages.length === 0) {
        return NextResponse.json({ error: "A listing needs at least one photo." }, { status: 400 });
      }
      const desiredVideos = Array.isArray(payload.videoOrder)
        ? parseMediaOrder({ images: [], videos: payload.videoOrder }, 0, videoFiles.length).videos
        : null;

      let current: Awaited<ReturnType<typeof fetchListingDetails>>[number] | undefined;
      try {
        [current] = await fetchListingDetails([targetListingId]);
      } catch (err) {
        const status = err instanceof EtsyApiError ? err.status : 502;
        return NextResponse.json(
          { error: err instanceof Error ? err.message : "Etsy request failed." },
          { status: status >= 400 && status < 600 ? status : 502 },
        );
      }
      if (!current) return NextResponse.json({ error: "Listing not found." }, { status: 404 });

      const plan = planListingMediaEdit(
        { images: current.images, videos: current.videos },
        { images: desiredImages, videos: desiredVideos },
      );
      const toRender = [
        ...new Set(
          plan.placeImages.flatMap((p) => (p.kind === "new" && p.item.kind === "job" ? [p.item.index] : [])),
        ),
      ];
      const rendered = new Map(
        await Promise.all(toRender.map(async (idx) => [idx, await pool.run(buildInput(jobs[idx]))] as const)),
      );
      const entryName = (entry: ImageOrderEntry) =>
        entry.kind === "job"
          ? label(jobs[entry.index])
          : ownImages[entry.index]?.name?.trim() || ownImageFiles[entry.index].name || `photo-${entry.index + 1}`;

      const result = await applyListingMediaEdit({
        shopId,
        listingId: targetListingId,
        currentImageCount: current.images.length,
        currentVideoCount: current.videos.length,
        plan,
        uploadImage: async (entry, rank, altText) => {
          if (entry.kind === "job") {
            const res = rendered.get(entry.index);
            if (!res || !res.ok) throw new Error(res ? res.error : "render failed");
            return uploadListingImage({
              shopId,
              listingId: targetListingId,
              bytes: new Uint8Array(res.bytes),
              filename: uniqueName(baseName(jobs[entry.index]), res.ext),
              contentType,
              rank,
              altText: altText || undefined,
            });
          }
          const file = ownImageFiles[entry.index];
          return uploadListingImage({
            shopId,
            listingId: targetListingId,
            bytes: new Uint8Array(await file.arrayBuffer()),
            filename: uniqueName(sanitize(entryName(entry)), extOf(file.name)),
            contentType: file.type || "image/jpeg",
            rank,
            altText: altText || undefined,
          });
        },
        uploadVideo: async (index) => {
          const file = videoFiles[index];
          await uploadListingVideo({
            shopId,
            listingId: targetListingId,
            bytes: new Uint8Array(await file.arrayBuffer()),
            filename: file.name || "video",
            contentType: file.type || "application/octet-stream",
          });
        },
        imageName: entryName,
        videoName: (index) => videoFiles[index]?.name || `Video ${index + 1}`,
      });

      return NextResponse.json(
        {
          mode,
          sourceListingId,
          listingId: targetListingId,
          createdDraft: false,
          edited: true,
          shopId,
          uploaded: result.placed
            .filter((p) => p.item)
            .map((p) => ({ name: p.name, rank: p.rank, listingImageId: p.listingImageId, url: p.url })),
          failed: result.failed,
          skipped: result.skipped,
        },
        { status: result.failed.length > 0 && result.placed.length === 0 ? 502 : 200 },
      );
    }

    // The listing (existing, copied, or freshly drafted) now exists — upload
    // each video the same way as the rendered images below. A failure here
    // doesn't block image upload; it's reported alongside any other failure.
    for (let i = 0; i < videoFiles.length; i++) {
      const videoFile = videoFiles[i];
      try {
        await uploadListingVideo({
          shopId,
          listingId: targetListingId,
          bytes: new Uint8Array(await videoFile.arrayBuffer()),
          filename: videoFile.name || "video",
          contentType: videoFile.type || "application/octet-stream",
        });
      } catch (err) {
        failed.push({
          name: videoFiles.length > 1 ? `Video ${i + 1}` : "Video",
          error: err instanceof Error ? err.message : "could not be uploaded",
        });
      }
    }

    // Render every job the final order references, in parallel on the pool
    // (own images need no rendering). Upload sequentially, in order, so Etsy
    // ranks stay contiguous — rank is assigned by successful-upload count, so
    // one failure never leaves a gap for the ones that follow it.
    const jobIndexesToRender = [
      ...new Set(capped.filter((e) => e.kind === "job").map((e) => e.index)),
    ];
    const renderedByJobIndex = new Map(
      await Promise.all(
        jobIndexesToRender.map(
          async (idx) => [idx, await pool.run(buildInput(jobs[idx]))] as const,
        ),
      ),
    );
    const ownBufs = await Promise.all(ownImageFiles.map((f) => f.arrayBuffer()));

    const uploaded: {
      name: string;
      rank: number;
      listingImageId: number;
      url: string | null;
      jobIndex?: number;
      orderIndex: number;
    }[] = [];

    for (const [orderIndex, entry] of capped.entries()) {
      if (entry.kind === "job") {
        const j = jobs[entry.index];
        const res = renderedByJobIndex.get(entry.index);
        if (!res || !res.ok) {
          failed.push({ name: label(j), error: res ? res.error : "render failed" });
          continue;
        }
        try {
          const img = await uploadListingImage({
            shopId,
            listingId: targetListingId,
            bytes: new Uint8Array(res.bytes),
            filename: uniqueName(baseName(j), res.ext),
            contentType,
            rank: startRank + uploaded.length,
            overwrite,
            altText: j.altText,
          });
          uploaded.push({
            name: label(j),
            rank: img.rank,
            listingImageId: img.listingImageId,
            url: img.url,
            jobIndex: entry.index,
            orderIndex,
          });
        } catch (err) {
          failed.push({
            name: label(j),
            error: err instanceof Error ? err.message : "upload failed",
          });
        }
      } else {
        const file = ownImageFiles[entry.index];
        const spec = ownImages[entry.index];
        const name = spec?.name?.trim() || file.name || `photo-${entry.index + 1}`;
        try {
          const img = await uploadListingImage({
            shopId,
            listingId: targetListingId,
            bytes: new Uint8Array(ownBufs[entry.index]),
            filename: uniqueName(sanitize(name), extOf(file.name)),
            contentType: file.type || "image/jpeg",
            rank: startRank + uploaded.length,
            overwrite,
            altText: spec?.altText,
          });
          uploaded.push({
            name,
            rank: img.rank,
            listingImageId: img.listingImageId,
            url: img.url,
            orderIndex,
          });
        } catch (err) {
          failed.push({
            name,
            error: err instanceof Error ? err.message : "upload failed",
          });
        }
      }
    }

    // Per-value variation images are a separate call from the inventory grid
    // itself, and need real listing image ids — only resolvable now that the
    // upload loop above has run. A value whose job failed/wasn't uploaded is
    // silently dropped here; the underlying failure is already in `failed`.
    if (variations && variations.imagesByValue.length > 0) {
      const byJobIndex = new Map(uploaded.map((u) => [u.jobIndex, u.listingImageId]));
      const byOrderIndex = new Map(uploaded.map((u) => [u.orderIndex, u.listingImageId]));
      const resolved = variations.imagesByValue
        .map((i) => {
          const listingImageId =
            i.imageIndex != null ? byOrderIndex.get(i.imageIndex) : byJobIndex.get(i.jobIndex);
          return listingImageId != null
            ? { propertyId: i.propertyId, valueId: i.valueId, imageId: listingImageId }
            : null;
        })
        .filter((i): i is { propertyId: number; valueId: number; imageId: number } => i != null);
      if (resolved.length > 0) {
        try {
          await updateVariationImages(shopId, targetListingId, resolved);
        } catch (err) {
          failed.push({
            name: "Variation images",
            error: err instanceof Error ? err.message : "could not be saved",
          });
        }
      }
    }

    return NextResponse.json(
      {
        mode,
        sourceListingId,
        listingId: targetListingId,
        createdDraft,
        shopId,
        uploaded,
        failed,
        skipped,
      },
      { status: uploaded.length > 0 || createdDraft ? 200 : 502 },
    );
  }

  const tagged = jobs.map((j, k) =>
    pool.run(buildInput(j)).then((res) => ({ k, job: j, res })),
  );

  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const pending = new Map(tagged.map((p, k) => [k, p]));
        while (pending.size > 0) {
          const done = await Promise.race(pending.values());
          pending.delete(done.k);
          if (cancelled) return;
          if (!done.res.ok) {
            failures.push(`${label(done.job)}: ${done.res.error}`);
            continue;
          }
          const name = uniqueName(baseName(done.job), done.res.ext);
          controller.enqueue(zip.file(name, new Uint8Array(done.res.bytes)));
        }
        if (failures.length > 0) {
          controller.enqueue(
            zip.file("_errors.txt", encoder.encode(failures.join("\n") + "\n")),
          );
        }
        controller.enqueue(zip.end());
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipName}"`,
      "Cache-Control": "no-store",
    },
  });
}
