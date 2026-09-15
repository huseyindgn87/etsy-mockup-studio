/**
 * Cloudflare R2 client — the blob store for saved-draft binary files (PSDs,
 * design images, own photos, thumbnails; see lib/drafts/*). R2 speaks the S3
 * API, so this is a thin wrapper around `@aws-sdk/client-s3`; nothing here is
 * R2-specific beyond the endpoint URL.
 *
 * Server-only: never import from a "use client" file.
 */

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { DraftAssetKind } from "@/lib/drafts/types";

const globalForR2 = globalThis as unknown as { r2Client?: S3Client };

/**
 * True once every R2 env var is present. Callers that can degrade gracefully
 * (e.g. a user-template upload) should check this *before* touching
 * `putObject`/`getObject`/etc. and surface a clear, non-crashing error instead —
 * the bucket isn't provisioned yet (see AGENTS.md).
 */
export function isR2Configured(): boolean {
  return !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);
}

function client(): S3Client {
  if (globalForR2.r2Client) return globalForR2.r2Client;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Missing R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY. Copy .env.example to " +
        ".env.local and fill in an R2 API token (Cloudflare dashboard -> R2 -> Manage API tokens).",
    );
  }
  const c = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  globalForR2.r2Client = c;
  return c;
}

function bucket(): string {
  const name = process.env.R2_BUCKET;
  if (!name) throw new Error("Missing R2_BUCKET. Copy .env.example to .env.local and fill it in.");
  return name;
}

/** Deterministic object key for one draft asset — `drafts/{draftId}/{kind}/{itemId}`. */
export function draftAssetKey(draftId: string, kind: DraftAssetKind, itemId: string): string {
  return `drafts/${draftId}/${kind}/${itemId}`;
}

/** Every object under a draft lives here — the prefix `deletePrefix` wipes on draft delete/expiry. */
export function draftPrefix(draftId: string): string {
  return `drafts/${draftId}/`;
}

/** Deterministic object key for one user-uploaded mockup template. */
export function userTemplateKey(ownerId: string, storageName: string): string {
  return `templates/user/${ownerId}/${storageName}`;
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await client().send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }),
  );
}

/** `null` when the object doesn't exist. */
export async function getObject(key: string): Promise<{ body: Buffer; contentType: string } | null> {
  try {
    const res = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    const body = Buffer.from(await res.Body!.transformToByteArray());
    return { body, contentType: res.ContentType ?? "application/octet-stream" };
  } catch (err) {
    if (err instanceof Error && err.name === "NoSuchKey") return null;
    throw err;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

/** Object keys under `prefix`, one page (up to 1000) — enough for a single draft's assets. */
export async function listKeys(prefix: string): Promise<string[]> {
  const res = await client().send(
    new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, MaxKeys: 1000 }),
  );
  return (res.Contents ?? []).map((o) => o.Key!).filter(Boolean);
}

/** Deletes exactly `keys` (at most 1000 per call) — nothing is listed or matched by prefix. */
export async function deleteObjects(keys: string[]): Promise<void> {
  if (!keys.length) return;
  await client().send(
    new DeleteObjectsCommand({
      Bucket: bucket(),
      Delete: { Objects: keys.slice(0, 1000).map((Key) => ({ Key })) },
    }),
  );
}

/** Deletes every object under `prefix` — used to wipe a whole draft's files on delete/expiry. */
export async function deletePrefix(prefix: string): Promise<void> {
  const keys = await listKeys(prefix);
  if (!keys.length) return;
  await client().send(
    new DeleteObjectsCommand({
      Bucket: bucket(),
      Delete: { Objects: keys.map((Key) => ({ Key })) },
    }),
  );
}
