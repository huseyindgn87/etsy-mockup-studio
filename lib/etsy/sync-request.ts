import type { BulkListingPatch } from "@/lib/etsy/bulk-edit";
import type { SaveResult } from "@/app/(app)/listings/bulk/types";

/** How long one listing's write may take before the run gives up on it. */
export const WRITE_TIMEOUT_MS = 30_000;

/**
 * One listing's write, abandoned if it hasn't answered in 30 s: the request is
 * aborted and the caller told, so a hanging listing can't hold up the others.
 */
export async function writeWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Timed out after ${WRITE_TIMEOUT_MS / 1000} seconds.`));
    }, WRITE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fetch(url, { ...init, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** One listing's field patch through `POST /api/etsy/listings/bulk/save` — what Sync updates sends per listing. */
export async function syncListingPatch(listingId: number, patch: BulkListingPatch): Promise<SaveResult> {
  try {
    const res = await writeWithTimeout("/api/etsy/listings/bulk/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates: [{ listingId, patch }] }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error || `Request failed (${res.status})`);
    }
    const saved = ((await res.json()) as { results: SaveResult[] }).results;
    return saved.find((r) => r.listingId === listingId) ?? { listingId, ok: false, error: "Etsy said nothing." };
  } catch (err) {
    return { listingId, ok: false, error: err instanceof Error ? err.message : "Save failed." };
  }
}
