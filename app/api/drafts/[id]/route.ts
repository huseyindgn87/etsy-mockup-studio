import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { deleteDraft, getDraftRow, saveDraft } from "@/lib/drafts/store";
import type { DraftMockupMeta, DraftSource } from "@/lib/drafts/types";
import { coercePhotosData } from "@/lib/drafts/validate";
import { restoredDraftVideos } from "@/lib/drafts/videos";
import { draftAssetKey, getObject } from "@/lib/storage/r2";
import { parsePsd } from "@/lib/mockup/psd";
import { encodeRasterDataUrl } from "@/lib/mockup/server";
import { measureTone } from "@/lib/mockup/tone";
import { coerceCalibration } from "@/lib/mockup/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Re-derives one restored mockup from its stored raw PSD bytes — the same
 * parse `/api/mockups/psd` runs on a fresh upload — merged with the user's
 * saved calibration/include flag. `null` when the PSD's bytes are missing
 * (upload never finished) or unreadable; the caller just drops it rather
 * than failing the whole draft restore over one bad mockup.
 */
async function restoreMockup(draftId: string, meta: DraftMockupMeta) {
  try {
    const obj = await getObject(draftAssetKey(draftId, "psd", meta.id));
    if (!obj) return null;
    const buf = new Uint8Array(obj.body).buffer as ArrayBuffer;
    const parsed = parsePsd(buf);
    const [composite, overlays] = await Promise.all([
      encodeRasterDataUrl(parsed.composite),
      Promise.all(
        parsed.overlays.map(async (ov) => ({
          x: ov.x,
          y: ov.y,
          w: ov.w,
          h: ov.h,
          blend: ov.blend,
          alpha: ov.alpha,
          clip: ov.clip,
          name: ov.name,
          image: await encodeRasterDataUrl({ data: ov.data, width: ov.w, height: ov.h }),
        })),
      ),
    ]);
    const tone = measureTone(parsed.composite, { isMock: true, name: meta.name });
    return {
      id: meta.id,
      name: meta.name,
      contentHash: meta.contentHash,
      include: meta.include,
      calibration: coerceCalibration(meta.calibration),
      psd: { width: parsed.width, height: parsed.height },
      composite,
      overlays,
      areaNames: parsed.areaNames,
      tone: tone.tone,
    };
  } catch {
    // A missing/unreadable PSD, or a storage hiccup fetching it — either way
    // this one mockup just doesn't come back; the rest of the draft (and every
    // other mockup) still should.
    return null;
  }
}

/**
 * `GET /api/drafts/[id]` — the full editor-restore payload: `formData`
 * (`ListingFormValue`, opaque JSON here) plus every mockup re-derived from
 * its stored PSD, and design/own-image entries with a URL the client fetches
 * their raw bytes from (`/api/drafts/[id]/assets/[kind]/[itemId]`).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { id } = await params;
  const row = await getDraftRow(session.user.id, id);
  if (!row) {
    return NextResponse.json({ error: "Draft not found." }, { status: 404 });
  }

  const photosData = coercePhotosData(row.photosData);
  const mockups = (await Promise.all(photosData.mockups.map((m) => restoreMockup(id, m)))).filter(
    (m): m is NonNullable<typeof m> => m !== null,
  );

  const sourceListingId = row.sourceListingId ? Number.parseInt(row.sourceListingId, 10) : NaN;
  const source: DraftSource | null =
    (row.sourceMode === "copy" || row.sourceMode === "existing") && Number.isInteger(sourceListingId) && sourceListingId > 0
      ? { mode: row.sourceMode, listingId: sourceListingId }
      : null;

  return NextResponse.json({
    id: row.id,
    title: row.title,
    formData: row.formData,
    source,
    activeTab: photosData.activeTab,
    imageOrder: photosData.imageOrder,
    removedJobKeys: photosData.removedJobKeys,
    removedEtsyImageIds: photosData.removedEtsyImageIds,
    altTextBySlot: photosData.altTextBySlot,
    videos: photosData.videos && restoredDraftVideos(id, photosData.videos),
    mockups,
    designs: photosData.designs.map((d) => ({
      id: d.id,
      name: d.name,
      url: `/api/drafts/${id}/assets/design/${d.id}`,
    })),
    ownImages: photosData.ownImages.map((o) => ({
      id: o.id,
      name: o.name,
      url: `/api/drafts/${id}/assets/own/${o.id}`,
    })),
  });
}

interface SavePayload {
  title?: unknown;
  formData?: unknown;
  photosData?: unknown;
  hasThumbnail?: unknown;
  /** Present (possibly `null`, to clear it) whenever the editor sends its
   * current copy/edit identity — absent means "leave whatever's already saved". */
  source?: unknown;
}

function isValidSource(value: unknown): value is DraftSource {
  return (
    !!value &&
    typeof value === "object" &&
    ((value as { mode?: unknown }).mode === "copy" || (value as { mode?: unknown }).mode === "existing") &&
    Number.isInteger((value as { listingId?: unknown }).listingId) &&
    ((value as { listingId: number }).listingId as number) > 0
  );
}

/**
 * `PUT /api/drafts/[id]` — saves the editor's current metadata (everything
 * except binary files, which go through the assets endpoint). Used by both
 * the explicit "Save draft" button and autosave.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { id } = await params;

  let body: SavePayload;
  try {
    body = (await request.json()) as SavePayload;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const patch: Parameters<typeof saveDraft>[2] = {};
  if (typeof body.title === "string") patch.title = body.title.slice(0, 200);
  if (body.formData && typeof body.formData === "object") {
    patch.formData = body.formData as unknown as Prisma.InputJsonValue;
  }
  if (body.photosData && typeof body.photosData === "object") {
    patch.photosData = body.photosData as unknown as Prisma.InputJsonValue;
  }
  if (typeof body.hasThumbnail === "boolean") patch.hasThumbnail = body.hasThumbnail;
  if ("source" in body) {
    if (body.source === null) {
      patch.sourceMode = null;
      patch.sourceListingId = null;
    } else if (isValidSource(body.source)) {
      patch.sourceMode = body.source.mode;
      patch.sourceListingId = String(body.source.listingId);
    }
  }

  const row = await saveDraft(session.user.id, id, patch);
  if (!row) {
    return NextResponse.json({ error: "Draft not found." }, { status: 404 });
  }
  return NextResponse.json({ id: row.id, updatedAt: row.updatedAt });
}

/** `DELETE /api/drafts/[id]` — deletes the draft and its R2 files. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { id } = await params;
  const ok = await deleteDraft(session.user.id, id);
  if (!ok) {
    return NextResponse.json({ error: "Draft not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
