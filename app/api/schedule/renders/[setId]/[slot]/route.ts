import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { MAX_IMAGE_SIZE_BYTES } from "@/lib/etsy/listing-image-limits";
import { STORAGE_NOT_CONFIGURED } from "@/lib/scheduling/content-request";
import { SCHEDULED_IMAGE_CONTENT_TYPES } from "@/lib/scheduling/publish-spec";
import { isRenderSetId, renderImageKey, slotIndex } from "@/lib/scheduling/render-keys";
import { isRenderSetInUse } from "@/lib/scheduling/store";
import { isR2Configured, putObject } from "@/lib/storage/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `PUT /api/schedule/renders/[setId]/image-NN` — stores one image for a
 * listing about to be scheduled: a mockup the browser just rendered, or a
 * copy of the user's own photo. Raw bytes, `Content-Type` image/jpeg, png or
 * gif. Slots run `image-00` … `image-19` (Etsy's 20-image limit).
 *
 * Written to `scheduled/{userId}/{setId}/image-NN` — a scheduled job's own
 * prefix, never mixed with the user's uploads. A set that already belongs to
 * a schedule can't be overwritten.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ setId: string; slot: string }> }) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { setId, slot } = await params;
  const index = slotIndex(slot);
  if (!isRenderSetId(setId) || index === null) {
    return NextResponse.json({ error: "Invalid render set or image slot." }, { status: 400 });
  }
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!(SCHEDULED_IMAGE_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    return NextResponse.json({ error: "Images must be JPEG, PNG or GIF." }, { status: 415 });
  }
  if (!isR2Configured()) {
    return NextResponse.json({ error: STORAGE_NOT_CONFIGURED }, { status: 503 });
  }

  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length === 0) return NextResponse.json({ error: "The image is empty." }, { status: 400 });
  if (bytes.length > MAX_IMAGE_SIZE_BYTES) {
    return NextResponse.json(
      { error: `Image ${index + 1} is larger than Etsy's ${MAX_IMAGE_SIZE_BYTES / (1024 * 1024)} MB limit.` },
      { status: 413 },
    );
  }
  if (await isRenderSetInUse(userId, setId)) {
    return NextResponse.json({ error: "These images already belong to a scheduled listing." }, { status: 409 });
  }

  await putObject(renderImageKey(userId, setId, index), bytes, contentType);
  return NextResponse.json({ ok: true, bytes: bytes.length });
}
