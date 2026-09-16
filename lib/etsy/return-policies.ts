import { etsyFetch } from "@/lib/etsy/auth";
import { TtlCache } from "@/lib/etsy/cache";
import { getShopId, readEtsyResponse } from "@/lib/etsy/listings";

/**
 * The connected shop's return policies (Etsy API v3,
 * `GET /shops/{shop_id}/policies/return`) — the dropdown behind the bulk
 * editor's Shipping > Return policy field. Reads only; policies themselves
 * are created and edited in Etsy's own Shop Manager.
 *
 * Etsy's spec documents no OAuth scope on this endpoint beyond the app
 * api-key, and `return_policy_id` is a documented `updateListing` parameter,
 * so assigning one needs nothing this app doesn't already request.
 */

const SHOP_CACHE_MS = 10 * 60 * 1000; // 10min — same TTL as sections/shipping profiles
const policiesCache = new TtlCache<number, ReturnPolicyOption[]>(SHOP_CACHE_MS);

export interface ReturnPolicyOption {
  returnPolicyId: number;
  acceptsReturns: boolean;
  acceptsExchanges: boolean;
  /** Days, one of Etsy's documented set [7, 14, 21, 30, 45, 60, 90]. */
  returnDeadline: number | null;
  /** Etsy names return policies only by their terms, so the label is built from them. */
  label: string;
}

interface RawReturnPolicy {
  return_policy_id: number;
  accepts_returns?: boolean;
  accepts_exchanges?: boolean;
  return_deadline?: number | null;
}

/** Etsy has no title on a return policy — describe it by what it allows. */
function describe(raw: RawReturnPolicy): string {
  const accepts: string[] = [];
  if (raw.accepts_returns) accepts.push("Returns");
  if (raw.accepts_exchanges) accepts.push("Exchanges");
  if (accepts.length === 0) return "No returns or exchanges";
  const deadline = raw.return_deadline ? ` within ${raw.return_deadline} days` : "";
  return `${accepts.join(" & ")} accepted${deadline}`;
}

/** The connected shop's return policies, for the bulk editor's Shipping section. */
export async function getShopReturnPolicies(): Promise<ReturnPolicyOption[]> {
  const shopId = await getShopId();
  return policiesCache.get(shopId, async () => {
    const res = await etsyFetch(`/shops/${shopId}/policies/return`);
    const data = (await readEtsyResponse(res, `GET /shops/${shopId}/policies/return`)) as {
      results?: RawReturnPolicy[];
    };
    return (data.results ?? []).map((p) => ({
      returnPolicyId: p.return_policy_id,
      acceptsReturns: p.accepts_returns === true,
      acceptsExchanges: p.accepts_exchanges === true,
      returnDeadline: p.return_deadline ?? null,
      label: describe(p),
    }));
  });
}
