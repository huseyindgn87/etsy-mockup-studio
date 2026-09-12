import { NextResponse } from "next/server";
import { getEtsySession } from "@/lib/etsy/auth";
import {
  createDraftListing,
  getListingStructure,
  setListingInventorySku,
  setListingProperty,
  updateListingInventory,
  updateVariationImages,
} from "@/lib/etsy/listing-create";
import { uploadListingImage } from "@/lib/etsy/listing-images";
import { EtsyApiError, getShopId } from "@/lib/etsy/listings";
import { MAX_VARIATION_COMBINATIONS } from "@/lib/etsy/variation-limits";
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
const MAX_LISTING_IMAGES = 10; // Etsy's per-listing image cap
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
  altText?: string;
  copyTitle?: string;
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
    /** Present -> use the Inventory API's variation grid instead of the single SKU above. */
    variations?: {
      priceOnProperty?: number[];
      quantityOnProperty?: number[];
      skuOnProperty?: number[];
      readinessStateOnProperty?: number[];
      products: {
        propertyValues: { propertyId: number; name?: string; valueIds: number[]; values: string[] }[];
        price?: number;
        quantity?: number;
        sku?: string;
        readinessStateId?: number;
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
  /** When set, upload the renders to this Etsy listing instead of zipping. */
  publishTo?: PublishSpec;
}

const FORBIDDEN_NAME_CHARS = '/\\:*?"<>|';

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
  propertyValues: { propertyId: number; name: string; valueIds: number[]; values: string[] }[];
  price?: number;
  quantity?: number;
  sku?: string;
  readinessStateId?: number;
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
  const rawProducts = Array.isArray(r.products) ? r.products.slice(0, MAX_VARIATION_COMBINATIONS) : [];

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
        !valueIds.every((v) => Number.isInteger(v) && v > 0) ||
        !values.every((v) => typeof v === "string")
      ) {
        ok = false;
        break;
      }
      propertyValues.push({
        propertyId: propertyId as number,
        name: typeof name === "string" && name ? name : `property #${propertyId as number}`,
        valueIds: valueIds as number[],
        values: values as string[],
      });
    }
    if (!ok) continue;

    const price = (p as { price?: unknown }).price;
    const quantity = (p as { quantity?: unknown }).quantity;
    const sku = (p as { sku?: unknown }).sku;
    const readinessStateId = (p as { readinessStateId?: unknown }).readinessStateId;
    products.push({
      propertyValues,
      price: typeof price === "number" && price > 0 ? price : undefined,
      quantity: typeof quantity === "number" && quantity >= 0 ? Math.trunc(quantity) : undefined,
      sku: typeof sku === "string" && sku.trim() ? sku.trim() : undefined,
      readinessStateId:
        Number.isInteger(readinessStateId) && (readinessStateId as number) > 0
          ? (readinessStateId as number)
          : undefined,
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
 * Batch-render every job and stream the results back as a ZIP.
 *
 * `POST /api/mockups/render` — `multipart/form-data`:
 *   - `mockup`  (file, repeated)  composites, addressed by index
 *   - `design`  (file, repeated)  designs, addressed by index
 *   - `overlay` (file, repeated)  overlay images, addressed by index
 *   - `payload` (json string):
 *       {
 *         format?: "jpeg" | "png",           // default "jpeg"
 *         targetMB?: [lo, hi],               // JPEG size window, default [1.2, 1.7]
 *         namePattern?: "{design}_{mockup}", // output basename template
 *         zipName?: "mockups.zip",
 *         mockups: [{ name, width?, height?, calibration, overlays?: [{ file, x, y, blend, alpha, clip, name }] }],
 *         designs: [{ name }],
 *         jobs:    [{ mockup, design?, areaDesigns?, name? }]
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

  if (mockupFiles.length === 0) {
    return NextResponse.json({ error: "At least one `mockup` file is required." }, { status: 400 });
  }
  if (mockupFiles.length + designFiles.length + overlayFiles.length > MAX_FILES) {
    return NextResponse.json({ error: `Too many files (max ${MAX_FILES}).` }, { status: 413 });
  }
  const totalBytes = [...mockupFiles, ...designFiles, ...overlayFiles].reduce(
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
  if (jobs.length === 0) {
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
    const startRank =
      typeof publish.startRank === "number" && publish.startRank >= 1
        ? Math.trunc(publish.startRank)
        : 1;
    // A live listing's images are only ever ADDED. Replacing happens only in
    // "existing" mode and only when the caller explicitly opts in.
    const overwrite = mode === "existing" && publish.overwrite === true;
    const contentType = format === "png" ? "image/png" : "image/jpeg";

    const capped = jobs.slice(0, MAX_LISTING_IMAGES);
    const skipped = jobs.length - capped.length;

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
          whoMade: src.whoMade,
          whenMade: src.whenMade,
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

    // Render all in parallel on the pool; upload sequentially so Etsy ranks
    // stay contiguous (rank N needs N-1 images already present).
    const rendered = await Promise.all(capped.map((j) => pool.run(buildInput(j))));

    const uploaded: {
      name: string;
      rank: number;
      listingImageId: number;
      url: string | null;
      jobIndex: number;
    }[] = [];

    for (let i = 0; i < capped.length; i++) {
      const j = capped[i];
      const res = rendered[i];
      if (!res.ok) {
        failed.push({ name: label(j), error: res.error });
        continue;
      }
      try {
        const img = await uploadListingImage({
          shopId,
          listingId: targetListingId,
          bytes: new Uint8Array(res.bytes),
          filename: uniqueName(baseName(j), res.ext),
          contentType,
          rank: startRank + i,
          overwrite,
          altText: publish.altText,
        });
        uploaded.push({
          name: label(j),
          rank: img.rank,
          listingImageId: img.listingImageId,
          url: img.url,
          jobIndex: i,
        });
      } catch (err) {
        failed.push({
          name: label(j),
          error: err instanceof Error ? err.message : "upload failed",
        });
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
