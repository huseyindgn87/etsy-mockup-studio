import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { MAX_IMAGE_SIZE_BYTES } from "@/lib/etsy/listing-image-limits";
import { MAX_VIDEO_SIZE_BYTES } from "@/lib/etsy/video-limits";
import { STORAGE_NOT_CONFIGURED } from "@/lib/scheduling/content-request";
import { SCHEDULED_IMAGE_CONTENT_TYPES } from "@/lib/scheduling/publish-spec";
import { bulkMediaKey, isRenderSetId, parseBulkMediaSlot, renderImageKey, slotIndex } from "@/lib/scheduling/render-keys";
import { isRenderSetInUse } from "@/lib/scheduling/store";
import { isR2Configured, putObject } from "@/lib/storage/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `PUT /api/schedule/renders/[setId]/[slot]` — stores one file for a job
 * about to be scheduled. Raw bytes, with the file's own `Content-Type`.
 *
 * Two slot forms:
 *   - `image-00` … `image-19` — an image for a listing about to be published:
 *     a mockup the browser just rendered, or a copy of the user's own photo.
 *   - `media-{listingId}-image-NN` / `media-{listingId}-video-NN` — a photo or
 *     video a scheduled **bulk edit** adds to that listing's grid.
 *
 * Written to `scheduled/{userId}/{setId}/{slot}` — a scheduled job's own
 * prefix, never mixed with the user's uploads. A set that already belongs to
 * a schedule can't be overwritten.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ setId: string; slot: string }> }) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { setId, slot } = await params;
  const index = slotIndex(slot);
  const media = parseBulkMediaSlot(slot);
  if (!isRenderSetId(setId) || (index === null && media === null)) {
    return NextResponse.json({ error: "Invalid render set or file slot." }, { status: 400 });
  }
  const isVideo = media?.kind === "video";
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (isVideo) {
    if (!contentType.startsWith("video/")) {
      return NextResponse.json({ error: "That isn't a video file." }, { status: 415 });
    }
  } else if (!(SCHEDULED_IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    return NextResponse.json({ error: "Images must be JPEG, PNG or GIF." }, { status: 415 });
  }
  if (!isR2Configured()) {
    return NextResponse.json({ error: STORAGE_NOT_CONFIGURED }, { status: 503 });
  }

  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length === 0) {
    return NextResponse.json({ error: `The ${isVideo ? "video" : "image"} is empty.` }, { status: 400 });
  }
  const limit = isVideo ? MAX_VIDEO_SIZE_BYTES : MAX_IMAGE_SIZE_BYTES;
  if (bytes.length > limit) {
    const what = media ? `${isVideo ? "Video" : "Photo"} ${media.index + 1}` : `Image ${(index ?? 0) + 1}`;
    return NextResponse.json(
      { error: `${what} is larger than Etsy's ${limit / (1024 * 1024)} MB limit.` },
      { status: 413 },
    );
  }
  if (await isRenderSetInUse(userId, setId)) {
    return NextResponse.json({ error: "These images already belong to a scheduled listing." }, { status: 409 });
  }

  const key = media
    ? bulkMediaKey(userId, setId, media.listingId, media.kind, media.index)
    : renderImageKey(userId, setId, index!);
  await putObject(key, bytes, contentType);
  // The key goes back to the caller: a scheduled bulk edit stores it with the
  // file's name, so the runner can read exactly what was uploaded here.
  return NextResponse.json({ ok: true, key, bytes: bytes.length });
}
