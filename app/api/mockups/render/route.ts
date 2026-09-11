import { NextResponse } from "next/server";
import { getEtsySession } from "@/lib/etsy/auth";
import {
  createDraftListing,
  getListingStructure,
  setListingInventorySku,
  setListingProperty,
} from "@/lib/etsy/listing-create";
import { uploadListingImage } from "@/lib/etsy/listing-images";
import { EtsyApiError, getShopId } from "@/lib/etsy/listings";
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
    properties?: {
      propertyId: number;
      valueIds: number[];
      values: string[];
      scaleId?: number | null;
    }[];
    price?: number;
    quantity?: number;
    sku?: string;
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
      name: typeof name === "string" && name ? name : `özellik #${propertyId as number}`,
      valueIds: valueIds as number[],
      values: values as string[],
      scaleId: typeof scaleId === "number" && scaleId > 0 ? scaleId : null,
    });
  }
  return out;
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

        targetListingId = await createDraftListing(shopId, {
          title:
            mode === "copy"
              ? publish.copyTitle?.trim() || `${src.title} (kopya)`
              : (nl.title as string).trim(),
          description: mode === "copy" ? src.description : nl.description || (nl.title as string),
          quantity,
          price,
          whoMade: src.whoMade,
          whenMade: src.whenMade,
          taxonomyId,
          shippingProfileId: src.shippingProfileId,
          returnPolicyId: src.returnPolicyId,
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
                error: err instanceof Error ? err.message : "kaydedilemedi",
              });
            }
          }
          const sku = typeof nl.sku === "string" ? nl.sku.trim() : "";
          if (sku) {
            try {
              await setListingInventorySku(targetListingId, { sku, price, quantity });
            } catch (err) {
              failed.push({
                name: "SKU",
                error: err instanceof Error ? err.message : "kaydedilemedi",
              });
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
        });
      } catch (err) {
        failed.push({
          name: label(j),
          error: err instanceof Error ? err.message : "upload failed",
        });
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
