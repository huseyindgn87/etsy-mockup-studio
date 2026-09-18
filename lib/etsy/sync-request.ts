import type { BulkListingPatch } from "@/lib/etsy/bulk-edit";
import type { SaveResult } from "@/app/(app)/listings/bulk/types";
import { waitForJob } from "@/lib/jobs/client";
import type { JobView } from "@/lib/jobs/types";

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

/**
 * One listing's field patch through `POST /api/etsy/listings/bulk/save` — what
 * Sync updates sends per listing. The save is a queued job: when it isn't
 * finished by the time the request answers (202), its status is followed —
 * each one reported to `onStatus` — until it's done or has failed.
 */
export async function syncListingPatch(
  listingId: number,
  patch: BulkListingPatch,
  onStatus?: (job: JobView) => void,
): Promise<SaveResult> {
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
    const body = (await res.json()) as { results?: SaveResult[]; jobId?: string; job?: JobView };
    let saved = body.results;
    if (res.status === 202 && body.jobId) {
      if (body.job) onStatus?.(body.job);
      const job = await waitForJob(body.jobId, { onStatus });
      if (job.status === "failed") throw new Error(job.error || "Saving failed.");
      saved = (job.result as { results?: SaveResult[] } | null)?.results;
    }
    return saved?.find((r) => r.listingId === listingId) ?? { listingId, ok: false, error: "Etsy said nothing." };
  } catch (err) {
    return { listingId, ok: false, error: err instanceof Error ? err.message : "Save failed." };
  }
}
