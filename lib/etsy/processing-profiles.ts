import { etsyFetch } from "@/lib/etsy/auth";
import { TtlCache } from "@/lib/etsy/cache";
import { getShopId, readEtsyResponse } from "@/lib/etsy/listings";

/**
 * Shop processing profiles ("readiness states") — the per-shop list of
 * ready-to-ship / made-to-order definitions a physical listing must be
 * linked to via `readiness_state_id` (Etsy API v3,
 * `GET /shops/{shop_id}/readiness-state-definitions`). Etsy now requires
 * every physical listing to carry one; `createDraftListing` fails without it.
 */

const SHOP_CACHE_MS = 10 * 60 * 1000; // 10min
const profilesCache = new TtlCache<number, ProcessingProfileOption[]>(SHOP_CACHE_MS);

async function etsyGetJson<T>(path: string): Promise<T> {
  const res = await etsyFetch(path);
  return (await readEtsyResponse(res, `GET ${path}`)) as T;
}

export interface ProcessingProfileOption {
  readinessStateId: number;
  readinessState: "ready_to_ship" | "made_to_order";
  minProcessingDays: number;
  maxProcessingDays: number;
  /** Etsy's own translated label, e.g. "3 - 5 days". */
  displayLabel: string;
}

interface RawProcessingProfile {
  readiness_state_id: number;
  readiness_state: "ready_to_ship" | "made_to_order";
  min_processing_days: number;
  max_processing_days: number;
  processing_days_display_label: string;
}

/** The connected shop's processing profiles, for the listing form's Shipping tab. */
export async function getShopProcessingProfiles(): Promise<ProcessingProfileOption[]> {
  const shopId = await getShopId();
  return profilesCache.get(shopId, async () => {
    const data = await etsyGetJson<{ count: number; results: RawProcessingProfile[] }>(
      `/shops/${shopId}/readiness-state-definitions`,
    );
    return (data.results ?? []).map((p) => ({
      readinessStateId: p.readiness_state_id,
      readinessState: p.readiness_state,
      minProcessingDays: p.min_processing_days,
      maxProcessingDays: p.max_processing_days,
      displayLabel: p.processing_days_display_label,
    }));
  });
}
