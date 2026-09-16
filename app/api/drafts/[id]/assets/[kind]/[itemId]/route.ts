import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getDraftRow } from "@/lib/drafts/store";
import { MAX_DRAFT_PSDS } from "@/lib/drafts/constants";
import type { DraftAssetKind } from "@/lib/drafts/types";
import { MAX_VIDEO_SIZE_BYTES } from "@/lib/etsy/video-limits";
import { draftAssetKey, draftPrefix, getObject, listKeys, putObject } from "@/lib/storage/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KINDS = new Set<DraftAssetKind>(["psd", "design", "own", "video", "thumbnail"]);
const ITEM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Mirrors `/api/mockups/psd`'s own cap — no reason a draft upload should allow more. */
const MAX_PSD_BYTES = 80 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

function maxBytesFor(kind: DraftAssetKind): number {
  if (kind === "psd") return MAX_PSD_BYTES;
  if (kind === "thumbnail") return MAX_THUMBNAIL_BYTES;
  if (kind === "video") return MAX_VIDEO_SIZE_BYTES;
  return MAX_IMAGE_BYTES;
}

function parseKindAndId(kind: string, itemId: string): DraftAssetKind | null {
  if (!KINDS.has(kind as DraftAssetKind) || !ITEM_ID_RE.test(itemId)) return null;
  return kind as DraftAssetKind;
}

/**
 * `PUT /api/drafts/[id]/assets/[kind]/[itemId]` — uploads (or replaces) one
 * binary file for a draft: a raw PSD, a design image, a user-uploaded photo,
 * a video, or the drafts-list thumbnail. Body is the raw file bytes; `Content-Type`
 * carries the MIME type. PSDs are capped at `MAX_DRAFT_PSDS` per draft.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; kind: string; itemId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { id, kind: kindRaw, itemId } = await params;
  const kind = parseKindAndId(kindRaw, itemId);
  if (!kind) {
    return NextResponse.json({ error: "Invalid asset kind or id." }, { status: 400 });
  }
  const draft = await getDraftRow(session.user.id, id);
  if (!draft) {
    return NextResponse.json({ error: "Draft not found." }, { status: 404 });
  }

  const cap = maxBytesFor(kind);
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > cap) {
    return NextResponse.json(
      { error: `File too large (max ${Math.round(cap / 1024 / 1024)} MB).` },
      { status: 413 },
    );
  }

  if (kind === "psd") {
    const existing = await listKeys(`${draftPrefix(id)}psd/`);
    const alreadyHasThis = existing.includes(draftAssetKey(id, "psd", itemId));
    if (!alreadyHasThis && existing.length >= MAX_DRAFT_PSDS) {
      return NextResponse.json(
        { error: `A draft can hold at most ${MAX_DRAFT_PSDS} PSDs.` },
        { status: 400 },
      );
    }
  }

  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.byteLength > cap) {
    return NextResponse.json(
      { error: `File too large (max ${Math.round(cap / 1024 / 1024)} MB).` },
      { status: 413 },
    );
  }
  // The proxy buffers request bodies only up to `proxyClientMaxBodySize`
  // and passes the rest on silently cut short — never store a partial file.
  if (declaredLength > 0 && bytes.byteLength < declaredLength) {
    return NextResponse.json({ error: "The upload arrived incomplete — try again." }, { status: 413 });
  }
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  await putObject(draftAssetKey(id, kind, itemId), bytes, contentType);
  return NextResponse.json({ ok: true });
}

/**
 * `GET /api/drafts/[id]/assets/[kind]/[itemId]` — streams one stored file
 * back (design images, own photos, videos, the thumbnail). Raw PSDs are never fetched
 * this way — the draft-restore route (`GET /api/drafts/[id]`) re-parses them
 * server-side instead, so there's no client-facing endpoint for that kind.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; kind: string; itemId: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { id, kind: kindRaw, itemId } = await params;
  const kind = parseKindAndId(kindRaw, itemId);
  if (!kind || kind === "psd") {
    return NextResponse.json({ error: "Invalid asset kind or id." }, { status: 400 });
  }
  const draft = await getDraftRow(session.user.id, id);
  if (!draft) {
    return NextResponse.json({ error: "Draft not found." }, { status: 404 });
  }
  const obj = await getObject(draftAssetKey(id, kind, itemId));
  if (!obj) {
    return NextResponse.json({ error: "Asset not found." }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(obj.body), { headers: { "Content-Type": obj.contentType } });
}
