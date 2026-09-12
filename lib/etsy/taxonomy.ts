import { etsyFetch } from "@/lib/etsy/auth";
import { TtlCache } from "@/lib/etsy/cache";
import { EtsyApiError, getShopId } from "@/lib/etsy/listings";

/**
 * Category taxonomy, category-specific listing properties, and shop sections
 * (API v3) — the data behind the "Details" section of a listing form.
 *
 * `seller-taxonomy/nodes` and `.../properties` are public (no OAuth scope,
 * just the app api-key) and identical for every caller, so the tree and each
 * category's properties are cached in memory per server process. Shop
 * sections are per-shop but still slow-changing, so they get the same
 * treatment (shorter TTL, keyed by shop id).
 */

async function etsyGetJson<T>(path: string): Promise<T> {
  const res = await etsyFetch(path);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(
      `[etsy] GET ${path} -> ${res.status}`,
      typeof body === "string" ? body : JSON.stringify(body),
    );
    throw new EtsyApiError(`Etsy API responded ${res.status} for ${path}`, res.status, body);
  }
  return body as T;
}

export interface TaxonomyNode {
  id: number;
  level: number;
  name: string;
  parentId: number | null;
  children: TaxonomyNode[];
}

interface RawTaxonomyNode {
  id: number;
  level: number;
  name: string;
  parent_id: number | null;
  children?: RawTaxonomyNode[];
}

function mapNode(raw: RawTaxonomyNode): TaxonomyNode {
  return {
    id: raw.id,
    level: raw.level,
    name: raw.name,
    parentId: raw.parent_id ?? null,
    children: (raw.children ?? []).map(mapNode),
  };
}

const TAXONOMY_CACHE_MS = 24 * 60 * 60 * 1000; // 24h — Etsy's category tree barely ever changes
const taxonomyTreeCache = new TtlCache<"tree", TaxonomyNode[]>(TAXONOMY_CACHE_MS);

/** The full seller category tree, root nodes with nested `children`. */
export async function getSellerTaxonomyTree(): Promise<TaxonomyNode[]> {
  return taxonomyTreeCache.get("tree", async () => {
    const data = await etsyGetJson<{ results: RawTaxonomyNode[] }>(
      "/seller-taxonomy/nodes",
    );
    return (data.results ?? []).map(mapNode);
  });
}

export interface TaxonomyPropertyValue {
  valueId: number | null;
  name: string;
  /** Which scale this value belongs to, when the property has more than one (e.g. US/UK/EU shoe sizes). */
  scaleId: number | null;
}

export interface TaxonomyPropertyScale {
  scaleId: number;
  displayName: string;
}

export interface TaxonomyProperty {
  propertyId: number;
  name: string;
  displayName: string;
  isRequired: boolean;
  isMultivalued: boolean;
  maxValuesAllowed: number | null;
  /** Settable as a plain listing attribute (the "Details" section). */
  supportsAttributes: boolean;
  /** Usable as an inventory variation (the "Variations" section). */
  supportsVariations: boolean;
  /** Alternate unit systems for this property's values (e.g. US/UK/EU sizing) — empty when the property has none. */
  scales: TaxonomyPropertyScale[];
  /** Every value across every scale; filter by `scaleId` once one is chosen. */
  possibleValues: TaxonomyPropertyValue[];
}

interface RawTaxonomyProperty {
  property_id: number;
  name: string;
  display_name: string;
  is_required?: boolean;
  supports_attributes?: boolean;
  supports_variations?: boolean;
  is_multivalued?: boolean;
  max_values_allowed?: number | null;
  scales?: { scale_id: number; display_name: string }[];
  possible_values?: { value_id: number | null; name: string; scale_id?: number | null }[];
}

const propertiesCache = new TtlCache<number, TaxonomyProperty[]>(TAXONOMY_CACHE_MS);

/**
 * Every category-specific listing property for one taxonomy node that has
 * selectable values (primary/secondary colour, material, size, occasion,
 * holiday, sleeve length, ...) — free-text properties with no
 * `possible_values` are dropped since nothing here can offer them as
 * options. Each property is flagged for which section(s) of the listing
 * form it belongs in: `supportsAttributes` (Details) and/or
 * `supportsVariations` (Variations) — most support only one, some support
 * both.
 */
export async function getTaxonomyProperties(taxonomyId: number): Promise<TaxonomyProperty[]> {
  return propertiesCache.get(taxonomyId, async () => {
    const data = await etsyGetJson<{ results: RawTaxonomyProperty[] }>(
      `/seller-taxonomy/nodes/${taxonomyId}/properties`,
    );
    return (data.results ?? [])
      .filter((p) => (p.possible_values ?? []).length > 0)
      .map((p) => ({
        propertyId: p.property_id,
        name: p.name,
        displayName: p.display_name || p.name,
        isRequired: !!p.is_required,
        isMultivalued: !!p.is_multivalued,
        maxValuesAllowed: p.max_values_allowed ?? null,
        supportsAttributes: !!p.supports_attributes,
        supportsVariations: !!p.supports_variations,
        scales: (p.scales ?? []).map((s) => ({ scaleId: s.scale_id, displayName: s.display_name })),
        possibleValues: (p.possible_values ?? []).map((v) => ({
          valueId: v.value_id,
          name: v.name,
          scaleId: v.scale_id ?? null,
        })),
      }));
  });
}

export interface ShopSectionOption {
  shopSectionId: number;
  title: string;
}

interface RawShopSection {
  shop_section_id: number;
  title: string;
  rank: number;
}

const SHOP_CACHE_MS = 10 * 60 * 1000; // 10min
const sectionsCache = new TtlCache<number, ShopSectionOption[]>(SHOP_CACHE_MS);

/** The connected user's shop sections, in their display order. */
export async function getShopSectionsList(): Promise<ShopSectionOption[]> {
  const shopId = await getShopId();
  return sectionsCache.get(shopId, async () => {
    const data = await etsyGetJson<{ results: RawShopSection[] }>(
      `/shops/${shopId}/sections`,
    );
    return (data.results ?? [])
      .sort((a, b) => a.rank - b.rank)
      .map((s) => ({ shopSectionId: s.shop_section_id, title: s.title }));
  });
}
