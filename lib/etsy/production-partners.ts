import { TtlCache } from "@/lib/etsy/cache";
import { getShopId, readEtsyResponse } from "@/lib/etsy/listings";
import { etsyFetch } from "@/lib/etsy/auth";

/**
 * Shop production partners (`GET /shops/{shop_id}/production-partners`) —
 * the people/companies a shop credits for helping make a listing. Etsy
 * requires at least one to be named on a listing whose `who_made` is
 * `someone_else` (see `listing-classification.ts`).
 */

const SHOP_CACHE_MS = 10 * 60 * 1000; // 10min
const partnersCache = new TtlCache<number, ProductionPartnerOption[]>(SHOP_CACHE_MS);

export interface ProductionPartnerOption {
  productionPartnerId: number;
  partnerName: string;
  location: string;
}

interface RawProductionPartner {
  production_partner_id: number;
  partner_name: string;
  location: string;
}

/** The connected shop's production partners, for the listing form's How it's made tab. */
export async function getShopProductionPartners(): Promise<ProductionPartnerOption[]> {
  const shopId = await getShopId();
  return partnersCache.get(shopId, async () => {
    const res = await etsyFetch(`/shops/${shopId}/production-partners`);
    const data = (await readEtsyResponse(res, `GET /shops/${shopId}/production-partners`)) as {
      results?: RawProductionPartner[];
    };
    return (data.results ?? []).map((p) => ({
      productionPartnerId: p.production_partner_id,
      partnerName: p.partner_name,
      location: p.location,
    }));
  });
}
