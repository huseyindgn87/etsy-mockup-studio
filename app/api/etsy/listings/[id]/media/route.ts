import { NextResponse } from "next/server";
import { fetchListingDetails } from "@/lib/etsy/listing-details";
import { checkImageFileBasics } from "@/lib/etsy/listing-image-limits";
import { readListingImagesInOrder, uploadListingImage } from "@/lib/etsy/listing-images";
import {
  applyListingMediaEdit,
  isEmptyMediaPlan,
  parseMediaOrder,
  planListingMediaEdit,
} from "@/lib/etsy/listing-media-edit";
import { resolveListingScope } from "@/lib/etsy/listing-scope";
import { listStoredListingsByIds } from "@/lib/etsy/listing-store";
import { uploadListingVideo } from "@/lib/etsy/listing-video";
import { EtsyApiError } from "@/lib/etsy/listings";
import { MAX_LISTING_VIDEOS, checkVideoFileBasics } from "@/lib/etsy/video-limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/etsy/listings/[id]/media` — `multipart/form-data`:
 *   - `payload` (json): `{ images: [{ kind: "existing", imageId, altText } | { kind: "new", index, altText }],
 *                          videos?: [{ kind: "existing", videoId } | { kind: "new", index }] }`
 *   - `image` (file, repeated) and `video` (file, repeated), addressed by `index`.
 *
 * Saves one listing's edited photo/video grid — the bulk screen's Sync
 * updates. The id is checked against the caller's own cached listings first,
 * and the listing's current media is read fresh from Etsy, so only this
 * listing's own images and videos can be rearranged. Responds with the
 * listing's media as Etsy has it afterwards.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const resolved = await resolveListingScope();
  if (!resolved.ok) return resolved.response;
  const { userId, shopId } = resolved.scope;

  const { id: rawId } = await params;
  const listingId = Number.parseInt(rawId, 10);
  if (!Number.isInteger(listingId) || listingId <= 0) {
    return NextResponse.json({ error: "Invalid listing id." }, { status: 400 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data." }, { status: 400 });
  }
  const imageFiles = form.getAll("image").filter((f): f is File => f instanceof File);
  const videoFiles = form
    .getAll("video")
    .filter((f): f is File => f instanceof File && f.size > 0)
    .slice(0, MAX_LISTING_VIDEOS);
  for (const file of imageFiles) {
    const error = checkImageFileBasics(file);
    if (error) return NextResponse.json({ error: `${file.name}: ${error}` }, { status: 400 });
  }
  for (const file of videoFiles) {
    const error = checkVideoFileBasics(file);
    if (error) return NextResponse.json({ error: `${file.name}: ${error}` }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(String(form.get("payload") ?? "{}"));
  } catch {
    return NextResponse.json({ error: "`payload` is not valid JSON." }, { status: 400 });
  }
  const desired = parseMediaOrder(payload, imageFiles.length, videoFiles.length);
  if (desired.images.length === 0) {
    return NextResponse.json({ error: "A listing needs at least one photo." }, { status: 400 });
  }

  const [owned] = await listStoredListingsByIds(userId, shopId, [listingId]);
  if (!owned) return NextResponse.json({ error: "Listing not found." }, { status: 404 });

  try {
    const [current] = await fetchListingDetails([listingId]);
    if (!current) return NextResponse.json({ error: "Listing not found." }, { status: 404 });

    const plan = planListingMediaEdit(
      { images: current.images, videos: current.videos },
      desired,
    );
    if (isEmptyMediaPlan(plan) && plan.refused.length === 0) {
      return NextResponse.json({ ok: true, failed: [], images: current.images, videos: current.videos });
    }

    const numericShopId = Number(shopId);
    const result = await applyListingMediaEdit({
      shopId: numericShopId,
      listingId,
      currentImageCount: current.images.length,
      currentVideoCount: current.videos.length,
      plan,
      uploadImage: async (index, rank, altText) => {
        const file = imageFiles[index];
        return uploadListingImage({
          shopId: numericShopId,
          listingId,
          bytes: new Uint8Array(await file.arrayBuffer()),
          filename: file.name || `photo-${index + 1}.jpg`,
          contentType: file.type || "image/jpeg",
          rank,
          altText: altText || undefined,
        });
      },
      uploadVideo: async (index) => {
        const file = videoFiles[index];
        await uploadListingVideo({
          shopId: numericShopId,
          listingId,
          bytes: new Uint8Array(await file.arrayBuffer()),
          filename: file.name || "video",
          contentType: file.type || "application/octet-stream",
        });
      },
      imageName: (index) => imageFiles[index]?.name || `Photo ${index + 1}`,
      videoName: (index) => videoFiles[index]?.name || `Video ${index + 1}`,
      readImages: () => readListingImagesInOrder(listingId),
    });

    const [after] = await fetchListingDetails([listingId]).catch(() => [undefined]);
    return NextResponse.json({
      ok: result.failed.length === 0,
      failed: result.failed,
      skipped: result.skipped,
      images: after?.images ?? null,
      videos: after?.videos ?? null,
    });
  } catch (err) {
    if (err instanceof EtsyApiError) {
      const status = err.status >= 400 && err.status <= 599 ? err.status : 502;
      return NextResponse.json({ error: err.message }, { status });
    }
    const message = err instanceof Error ? err.message : "Request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
