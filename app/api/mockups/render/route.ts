import { NextResponse } from "next/server";
import { getEtsySession } from "@/lib/etsy/auth";
import {
  createDraftListing,
  getListingStructure,
  setListingInventorySku,
  setListingProperty,
  updateListingInventory,
  updateListingPersonalization,
  updateListingSettings,
  updateVariationImages,
} from "@/lib/etsy/listing-create";
import { uploadListingImage } from "@/lib/etsy/listing-images";
import { MAX_LISTING_IMAGES } from "@/lib/etsy/listing-image-limits";
import { WHEN_MADE_VALUES, WHO_MADE_OPTIONS, howItsMadeError } from "@/lib/etsy/listing-classification";
import {
  PERSONALIZATION_FIELD_TYPES,
  personalizationQuestionsError,
  type PersonalizationQuestionInput,
} from "@/lib/etsy/listing-personalization";
import { uploadListingVideo } from "@/lib/etsy/listing-video";
import { EtsyApiError, getShopId } from "@/lib/etsy/listings";
import { MAX_COMBINATIONS_HARD_CAP } from "@/lib/etsy/variation-limits";
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
/**
 * Etsy's "How it's made" classification — `who_made`/`is_supply`/`when_made`
 * plus production partners (required when `who_made` is `someone_else`).
 * Always the user's own choice on the How it's made tab; never borrowed from
 * `listingId`'s source listing (see `getListingStructure`).
 */
interface HowItsMadeSpec {
  whoMade?: string;
  isSupply?: boolean;
  whenMade?: string;
  productionPartnerIds?: number[];
}
/** One personalization question, in the same shape as `PersonalizationQuestionInput` — see `listing-personalization.ts`. */
interface PersonalizationQuestionSpec {
  questionId?: number;
  questionText?: string;
  instructions?: string;
  required?: boolean;
  fieldType?: string;
  maxAllowedCharacters?: number;
  maxAllowedFiles?: number;
  options?: string[];
}
interface PublishSpec {
  /**
   * "existing" — append to `listingId` (never replaces unless `overwrite`).
   * "copy"     — new draft seeded from `listingId`, upload there.
   * "new"      — new draft (borrows only category/shipping from `listingId`),
   *              fields from `newListing`, upload there.
   * A live listing is never modified except in "existing" mode, and even then
   * images are only added unless the caller explicitly sets `overwrite`.
   */
  mode?: "existing" | "copy" | "new";
  listingId: number;
  startRank?: number;
  /** "existing" mode only. Replace the image at each rank. Default false. */
  overwrite?: boolean;
  copyTitle?: string;
  /** Required for "copy" and "new" — see {@link HowItsMadeSpec}. */
  howItsMade?: HowItsMadeSpec;
  /** Optional, "copy"/"new" only — 0 to `PERSONALIZATION_MAX_QUESTIONS` questions. Omitted/empty -> no personalization is set. */
  personalization?: PersonalizationQuestionSpec[];
  newListing?: {
    title?: string;
    description?: string;
    tags?: string[];
    taxonomyId?: number;
    shopSectionId?: number | null;
    /** Required by Etsy for every physical listing; falls back to the source listing's when omitted. */
    readinessStateId?: number;
    properties?: {
      propertyId: number;
      valueIds: number[];
      values: string[];
      scaleId?: number | null;
    }[];
    price?: number;
    quantity?: number;
    sku?: string;
    /** Not settable at draft creation — sent via a follow-up updateListing call. Omitted -> not featured. */
    featuredRank?: number;
    /** Not settable at draft creation — sent via a follow-up updateListing call. */
    shouldAutoRenew?: boolean;
    /** Present -> use the Inventory API's variation grid instead of the single SKU above. */
    variations?: {
      priceOnProperty?: number[];
      quantityOnProperty?: number[];
      skuOnProperty?: number[];
      readinessStateOnProperty?: number[];
      products: {
        propertyValues: { propertyId: number; name?: string; valueIds: (number | null)[]; values: string[] }[];
        price?: number;
        quantity?: number;
        sku?: string;
        readinessStateId?: number;
        /** Etsy still requires every combination to be supplied; false just marks it inactive. Defaults to true. */
        enabled?: boolean;
      }[];
      /** Assign an already-rendered job's uploaded image to a specific property value. */
      imagesByValue?: { propertyId: number; valueId: number; jobIndex: number }[];
    };
  };
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

/** Etsy's own tag rules: at most 13 tags, each at most 20 characters. */
function sanitizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags) {
    if (typeof t !== "string") continue;
    const trimmed = t.trim().slice(0, 20);
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= 13) break;
  }
  return out;
}

interface PropertyEntry {
  propertyId: number;
  name: string;
  valueIds: number[];
  values: string[];
  scaleId?: number | null;
}

/** Drop malformed property entries rather than fail the whole publish. */
function sanitizeProperties(raw: unknown): PropertyEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PropertyEntry[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const propertyId = (p as { propertyId?: unknown }).propertyId;
    const name = (p as { name?: unknown }).name;
    const valueIds = (p as { valueIds?: unknown }).valueIds;
    const values = (p as { values?: unknown }).values;
    const scaleId = (p as { scaleId?: unknown }).scaleId;
    if (
      !Number.isInteger(propertyId) ||
      (propertyId as number) <= 0 ||
      !Array.isArray(valueIds) ||
      !Array.isArray(values) ||
      valueIds.length === 0 ||
      valueIds.length !== values.length ||
      !valueIds.every((v) => Number.isInteger(v) && v > 0) ||
      !values.every((v) => typeof v === "string")
    ) {
      continue;
    }
    out.push({
      propertyId: propertyId as number,
      name: typeof name === "string" && name ? name : `property #${propertyId as number}`,
      valueIds: valueIds as number[],
      values: values as string[],
      scaleId: typeof scaleId === "number" && scaleId > 0 ? scaleId : null,
    });
  }
  return out;
}

interface CleanVariationProduct {
  propertyValues: { propertyId: number; name: string; valueIds: (number | null)[]; values: string[] }[];
  price?: number;
  quantity?: number;
  sku?: string;
  readinessStateId?: number;
  /** Etsy still requires every combination to be supplied; false just marks it inactive. */
  enabled: boolean;
}
interface CleanVariations {
  products: CleanVariationProduct[];
  priceOnProperty: number[];
  quantityOnProperty: number[];
  skuOnProperty: number[];
  readinessStateOnProperty: number[];
  imagesByValue: { propertyId: number; valueId: number; jobIndex: number }[];
}

const positiveIntArray = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x) && x > 0) : [];

/**
 * Validate a variation grid sent by the client. Malformed products / property
 * entries are dropped individually rather than failing the whole publish —
 * the client already built this from its own UI state, so a mismatch here
 * most likely means one row got out of sync, not that the whole grid is junk.
 */
function sanitizeVariations(raw: unknown): CleanVariations | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rawProducts = Array.isArray(r.products) ? r.products.slice(0, MAX_COMBINATIONS_HARD_CAP) : [];

  const products: CleanVariationProduct[] = [];
  for (const p of rawProducts) {
    if (!p || typeof p !== "object") continue;
    const pvRaw = (p as { propertyValues?: unknown }).propertyValues;
    if (!Array.isArray(pvRaw) || pvRaw.length === 0) continue;

    const propertyValues: CleanVariationProduct["propertyValues"] = [];
    let ok = true;
    for (const pv of pvRaw) {
      if (!pv || typeof pv !== "object") {
        ok = false;
        break;
      }
      const propertyId = (pv as { propertyId?: unknown }).propertyId;
      const name = (pv as { name?: unknown }).name;
      const valueIds = (pv as { valueIds?: unknown }).valueIds;
      const values = (pv as { values?: unknown }).values;
      if (
        !Number.isInteger(propertyId) ||
        (propertyId as number) <= 0 ||
        !Array.isArray(valueIds) ||
        !Array.isArray(values) ||
        valueIds.length === 0 ||
        valueIds.length !== values.length ||
        // null is a free-text value on an otherwise-real Etsy property (see VariationValuePicker).
        !valueIds.every((v) => v === null || (Number.isInteger(v) && v > 0)) ||
        !values.every((v) => typeof v === "string")
      ) {
        ok = false;
        break;
      }
      propertyValues.push({
        propertyId: propertyId as number,
        name: typeof name === "string" && name ? name : `property #${propertyId as number}`,
        valueIds: valueIds as (number | null)[],
        values: values as string[],
      });
    }
    if (!ok) continue;

    const price = (p as { price?: unknown }).price;
    const quantity = (p as { quantity?: unknown }).quantity;
    const sku = (p as { sku?: unknown }).sku;
    const readinessStateId = (p as { readinessStateId?: unknown }).readinessStateId;
    const enabled = (p as { enabled?: unknown }).enabled;
    products.push({
      propertyValues,
      price: typeof price === "number" && price > 0 ? price : undefined,
      quantity: typeof quantity === "number" && quantity >= 0 ? Math.trunc(quantity) : undefined,
      sku: typeof sku === "string" && sku.trim() ? sku.trim() : undefined,
      readinessStateId:
        Number.isInteger(readinessStateId) && (readinessStateId as number) > 0
          ? (readinessStateId as number)
          : undefined,
      enabled: enabled !== false, // never dropped — Etsy requires every combination, just marked inactive
    });
  }
  if (products.length === 0) return null;

  const imagesRaw = Array.isArray(r.imagesByValue) ? r.imagesByValue : [];
  const imagesByValue = imagesRaw
    .filter((i): i is { propertyId: number; valueId: number; jobIndex: number } => {
      if (!i || typeof i !== "object") return false;
      const o = i as Record<string, unknown>;
      return (
        Number.isInteger(o.propertyId) &&
        (o.propertyId as number) > 0 &&
        Number.isInteger(o.valueId) &&
        (o.valueId as number) > 0 &&
        Number.isInteger(o.jobIndex) &&
        (o.jobIndex as number) >= 0
      );
    })
    .map((i) => ({ propertyId: i.propertyId, valueId: i.valueId, jobIndex: i.jobIndex }));

  return {
    products,
    priceOnProperty: positiveIntArray(r.priceOnProperty),
    quantityOnProperty: positiveIntArray(r.quantityOnProperty),
    skuOnProperty: positiveIntArray(r.skuOnProperty),
    readinessStateOnProperty: positiveIntArray(r.readinessStateOnProperty),
    imagesByValue,
  };
}

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

const WHO_MADE_VALUES = WHO_MADE_OPTIONS.map((o) => o.value);

interface ValidHowItsMade {
  whoMade: (typeof WHO_MADE_OPTIONS)[number]["value"];
  isSupply: boolean;
  whenMade: string;
  productionPartnerIds: number[];
}

/**
 * Validate the client's "How it's made" block. Unlike the other sanitizers
 * in this file, a malformed or missing value here fails the whole publish
 * (with a 400 and a clear message) rather than being silently dropped —
 * Etsy requires `who_made`/`when_made`/`is_supply` together on every
 * physical listing, and this app never fills them in on the caller's behalf
 * (see `getListingStructure` and `listing-classification.ts`).
 */
function sanitizeHowItsMade(raw: unknown): { value: ValidHowItsMade } | { error: string } {
  if (!raw || typeof raw !== "object") {
    return {
      error: "How it's made is required — choose who made this item, what it is, and when it was made.",
    };
  }
  const r = raw as HowItsMadeSpec;
  if (typeof r.whoMade !== "string" || !(WHO_MADE_VALUES as string[]).includes(r.whoMade)) {
    return { error: "How it's made: choose who made this item." };
  }
  if (typeof r.whenMade !== "string" || !(WHEN_MADE_VALUES as readonly string[]).includes(r.whenMade)) {
    return { error: "How it's made: choose when this item was made." };
  }
  if (typeof r.isSupply !== "boolean") {
    return { error: "How it's made: choose whether this is a finished product or a supply." };
  }
  const productionPartnerIds = Array.isArray(r.productionPartnerIds)
    ? r.productionPartnerIds.filter((id): id is number => Number.isInteger(id) && id > 0)
    : [];
  const value: ValidHowItsMade = {
    whoMade: r.whoMade as ValidHowItsMade["whoMade"],
    isSupply: r.isSupply,
    whenMade: r.whenMade,
    productionPartnerIds,
  };
  const businessError = howItsMadeError(value);
  if (businessError) return { error: businessError };
  return { value };
}

const PERSONALIZATION_FIELD_TYPE_VALUES = PERSONALIZATION_FIELD_TYPES.map((t) => t.value);

/**
 * Validate the client's personalization questions. Unlike `sanitizeHowItsMade`,
 * an omitted/empty array is valid — personalization is entirely optional. A
 * malformed or Etsy-incompatible set fails the whole publish (400, a clear
 * message) rather than being silently dropped or partially sent.
 */
function sanitizePersonalization(
  raw: unknown,
): { value: PersonalizationQuestionInput[] } | { error: string } {
  if (raw == null) return { value: [] };
  if (!Array.isArray(raw)) {
    return { error: "publishTo.personalization must be an array." };
  }
  const value: PersonalizationQuestionInput[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      return { error: "Personalization: each question must be an object." };
    }
    const q = item as PersonalizationQuestionSpec;
    if (
      typeof q.fieldType !== "string" ||
      !(PERSONALIZATION_FIELD_TYPE_VALUES as string[]).includes(q.fieldType)
    ) {
      return { error: "Personalization: choose a field type for every question." };
    }
    value.push({
      questionId: Number.isInteger(q.questionId) ? q.questionId : undefined,
      questionText: typeof q.questionText === "string" ? q.questionText : "",
      instructions: typeof q.instructions === "string" ? q.instructions : "",
      required: q.required === true,
      fieldType: q.fieldType as PersonalizationQuestionInput["fieldType"],
      maxAllowedCharacters: Number.isFinite(q.maxAllowedCharacters) ? Number(q.maxAllowedCharacters) : 0,
      maxAllowedFiles: Number.isFinite(q.maxAllowedFiles) ? Number(q.maxAllowedFiles) : 0,
      options: Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === "string") : [],
    });
  }
  const businessError = personalizationQuestionsError(value);
  if (businessError) return { error: businessError };
  return { value };
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
 *   - "existing" — add to `listingId` (only replaces if `overwrite: true`)
 *   - "copy"     — new draft seeded from `listingId`
 *   - "new"      — new draft from `newListing`, category/shipping borrowed from `listingId`
 * A live listing is never modified except an explicit "existing" + `overwrite`.
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

  if (mockupFiles.length === 0 && ownImageFiles.length === 0) {
    return NextResponse.json(
      { error: "At least one `mockup` or `ownImage` file is required." },
      { status: 400 },
    );
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
  if (jobs.length === 0 && !(ownImages.length > 0 && payload.publishTo)) {
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
    if (!Number.isInteger(publish.listingId) || publish.listingId <= 0) {
      return NextResponse.json(
        { error: "publishTo.listingId must be a positive integer." },
        { status: 400 },
      );
    }
    const mode = publish.mode === "copy" || publish.mode === "new" ? publish.mode : "existing";
    if (mode === "new" && !publish.newListing?.title?.trim()) {
      return NextResponse.json(
        { error: "publishTo.newListing.title is required for a new listing." },
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
    let targetListingId = publish.listingId;
    let createdDraft = false;
    const failed: { name: string; error: string }[] = [];
    // Set only in "new" mode when the form sent a variation grid — the single-SKU
    // path below is skipped in that case, and the upload loop below resolves
    // `imagesByValue`'s jobIndex against the images actually uploaded.
    let variations: CleanVariations | null = null;

    try {
      shopId = await getShopId();
      if (mode !== "existing") {
        const src = await getListingStructure(publish.listingId);
        const nl = publish.newListing ?? {};
        const quantity =
          mode === "new" && Number.isInteger(nl.quantity) && (nl.quantity as number) > 0
            ? (nl.quantity as number)
            : src.quantity;
        const price =
          mode === "new" && typeof nl.price === "number" && nl.price > 0 ? nl.price : src.price;
        const taxonomyId =
          mode === "new" && Number.isInteger(nl.taxonomyId) && (nl.taxonomyId as number) > 0
            ? (nl.taxonomyId as number)
            : src.taxonomyId;
        const readinessStateId =
          mode === "new" && Number.isInteger(nl.readinessStateId) && (nl.readinessStateId as number) > 0
            ? (nl.readinessStateId as number)
            : src.readinessStateId;

        targetListingId = await createDraftListing(shopId, {
          title:
            mode === "copy"
              ? publish.copyTitle?.trim() || `${src.title} (copy)`
              : (nl.title as string).trim(),
          description: mode === "copy" ? src.description : nl.description || (nl.title as string),
          quantity,
          price,
          // Validated above whenever mode !== "existing" — this call only
          // ever runs in that branch, so `howItsMade` is always set here.
          whoMade: howItsMade!.whoMade,
          isSupply: howItsMade!.isSupply,
          whenMade: howItsMade!.whenMade,
          productionPartnerIds: howItsMade!.productionPartnerIds,
          taxonomyId,
          shippingProfileId: src.shippingProfileId,
          returnPolicyId: src.returnPolicyId,
          readinessStateId,
          shopSectionId:
            mode === "new" && typeof nl.shopSectionId === "number" && nl.shopSectionId > 0
              ? nl.shopSectionId
              : null,
          tags: mode === "copy" ? src.tags : mode === "new" ? sanitizeTags(nl.tags) : [],
          materials: mode === "copy" ? src.materials : [],
        });
        createdDraft = true;

        // featured_rank/should_auto_renew aren't part of createDraftListing either —
        // same follow-up-call pattern as properties/SKU/variations below.
        if (mode === "new" && (nl.featuredRank != null || typeof nl.shouldAutoRenew === "boolean")) {
          try {
            await updateListingSettings(shopId, targetListingId, {
              featuredRank: nl.featuredRank,
              shouldAutoRenew: nl.shouldAutoRenew,
            });
          } catch (err) {
            failed.push({
              name: "Settings",
              error: err instanceof Error ? err.message : "could not be saved",
            });
          }
        }

        // Personalization isn't part of createDraftListing either — Etsy has
        // no personalization params on createDraftListing/updateListing at
        // all (its older flat fields are deprecated); it's a dedicated
        // resource set with a separate call once the listing exists. Skipped
        // entirely when nothing was configured, so a "copy"/"new" draft with
        // no personalization tab input never sends an empty-replacing call.
        if (personalization.length > 0) {
          try {
            await updateListingPersonalization(shopId, targetListingId, personalization);
          } catch (err) {
            failed.push({
              name: "Personalization",
              error: err instanceof Error ? err.message : "could not be saved",
            });
          }
        }

        // Category-specific properties and SKU aren't part of createDraftListing —
        // Etsy sets them with separate calls once the listing exists. Failures
        // here don't block the image upload that follows; they're reported
        // alongside any upload failures instead.
        if (mode === "new") {
          for (const p of sanitizeProperties(nl.properties)) {
            try {
              await setListingProperty(shopId, targetListingId, p);
            } catch (err) {
              failed.push({
                name: p.name,
                error: err instanceof Error ? err.message : "could not be saved",
              });
            }
          }
          variations = sanitizeVariations(nl.variations);
          if (variations) {
            // A variation grid replaces the single default product outright —
            // sending both would just have the second PUT overwrite the first.
            try {
              await updateListingInventory(targetListingId, {
                products: variations.products.map((p) => ({
                  sku: p.sku,
                  propertyValues: p.propertyValues,
                  price: p.price ?? price,
                  quantity: p.quantity ?? quantity,
                  readinessStateId: p.readinessStateId,
                  enabled: p.enabled,
                })),
                priceOnProperty: variations.priceOnProperty,
                quantityOnProperty: variations.quantityOnProperty,
                skuOnProperty: variations.skuOnProperty,
                readinessStateOnProperty: variations.readinessStateOnProperty,
              });
            } catch (err) {
              failed.push({
                name: "Variations",
                error: err instanceof Error ? err.message : "could not be saved",
              });
              variations = null; // grid failed to save -> don't try to attach images to it
            }
          } else {
            const sku = typeof nl.sku === "string" ? nl.sku.trim() : "";
            if (sku) {
              try {
                await setListingInventorySku(targetListingId, { sku, price, quantity });
              } catch (err) {
                failed.push({
                  name: "SKU",
                  error: err instanceof Error ? err.message : "could not be saved",
                });
              }
            }
          }
        }
      }
    } catch (err) {
      const status = err instanceof EtsyApiError ? err.status : 502;
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Etsy request failed." },
        { status: status >= 400 && status < 600 ? status : 502 },
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
    }[] = [];

    for (const entry of capped) {
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
      const resolved = variations.imagesByValue
        .map((i) => {
          const listingImageId = byJobIndex.get(i.jobIndex);
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
        sourceListingId: publish.listingId,
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
