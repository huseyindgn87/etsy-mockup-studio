import { etsyFetch } from "@/lib/etsy/auth";
import { TtlCache } from "@/lib/etsy/cache";
import { getShopId, readEtsyResponse } from "@/lib/etsy/listings";

/**
 * The connected shop's shipping profiles (Etsy API v3,
 * `GET /shops/{shop_id}/shipping-profiles`) — the dropdown behind the bulk
 * editor's Shipping section. Reads only; profiles themselves are created and
 * edited in Etsy's own Shop Manager.
 *
 * Needs no extra OAuth scope: the endpoint requires `shops_r`, which this app
 * already requests (see lib/etsy/config.ts's `DEFAULT_SCOPES`).
 */

const SHOP_CACHE_MS = 10 * 60 * 1000; // 10min — same TTL as sections/processing profiles
const profilesCache = new TtlCache<number, ShippingProfileOption[]>(SHOP_CACHE_MS);

export interface ShippingProfileOption {
  shippingProfileId: number;
  title: string;
  /** "manual" or "calculated" — calculated profiles can be assigned but not created via the API. */
  profileType: string | null;
  originCountryIso: string | null;
}

interface RawShippingProfile {
  shipping_profile_id: number;
  title: string;
  is_deleted?: boolean;
  profile_type?: string;
  origin_country_iso?: string;
}

/** The connected shop's shipping profiles, deleted ones left out. */
export async function getShopShippingProfiles(): Promise<ShippingProfileOption[]> {
  const shopId = await getShopId();
  return profilesCache.get(shopId, async () => {
    const res = await etsyFetch(`/shops/${shopId}/shipping-profiles`);
    const data = (await readEtsyResponse(res, `GET /shops/${shopId}/shipping-profiles`)) as {
      results?: RawShippingProfile[];
    };
    return (data.results ?? [])
      .filter((p) => !p.is_deleted)
      .map((p) => ({
        shippingProfileId: p.shipping_profile_id,
        title: p.title,
        profileType: p.profile_type ?? null,
        originCountryIso: p.origin_country_iso ?? null,
      }));
  });
}
