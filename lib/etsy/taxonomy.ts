import { etsyFetch } from "@/lib/etsy/auth";
import { EtsyApiError, getShopId } from "@/lib/etsy/listings";

/**
 * Category taxonomy, category-specific listing properties, and shop sections
 * (API v3) — the data behind the "Details" section of a listing form.
 *
 * `seller-taxonomy/nodes` and `.../properties` are public (no OAuth scope,
 * just the app api-key) and identical for every caller, so the tree and each
 * category's properties are cached in memory per server process.
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

const TAXONOMY_CACHE_MS = 60 * 60 * 1000; // 1h — Etsy's category tree barely ever changes
let taxonomyCache: { at: number; tree: TaxonomyNode[] } | null = null;

/** The full seller category tree, root nodes with nested `children`. */
export async function getSellerTaxonomyTree(): Promise<TaxonomyNode[]> {
  if (taxonomyCache && Date.now() - taxonomyCache.at < TAXONOMY_CACHE_MS) {
    return taxonomyCache.tree;
  }
  const data = await etsyGetJson<{ results: RawTaxonomyNode[] }>(
    "/seller-taxonomy/nodes",
  );
  const tree = (data.results ?? []).map(mapNode);
  taxonomyCache = { at: Date.now(), tree };
  return tree;
}

export interface TaxonomyPropertyValue {
  valueId: number | null;
  name: string;
}

export interface TaxonomyProperty {
  propertyId: number;
  name: string;
  displayName: string;
  isRequired: boolean;
  isMultivalued: boolean;
  maxValuesAllowed: number | null;
  possibleValues: TaxonomyPropertyValue[];
}

interface RawTaxonomyProperty {
  property_id: number;
  name: string;
  display_name: string;
  is_required?: boolean;
  supports_attributes?: boolean;
  is_multivalued?: boolean;
  max_values_allowed?: number | null;
  possible_values?: { value_id: number | null; name: string }[];
}

const propertiesCache = new Map<number, { at: number; properties: TaxonomyProperty[] }>();

/**
 * Category-specific listing properties (e.g. primary/secondary colour,
 * occasion, sleeve length) for one taxonomy node — only the ones settable as
 * plain listing attributes (`supports_attributes`), not the ones that only
 * make sense as inventory variations.
 */
export async function getTaxonomyProperties(taxonomyId: number): Promise<TaxonomyProperty[]> {
  const cached = propertiesCache.get(taxonomyId);
  if (cached && Date.now() - cached.at < TAXONOMY_CACHE_MS) return cached.properties;

  const data = await etsyGetJson<{ results: RawTaxonomyProperty[] }>(
    `/seller-taxonomy/nodes/${taxonomyId}/properties`,
  );
  const properties = (data.results ?? [])
    .filter((p) => p.supports_attributes && (p.possible_values ?? []).length > 0)
    .map((p) => ({
      propertyId: p.property_id,
      name: p.name,
      displayName: p.display_name || p.name,
      isRequired: !!p.is_required,
      isMultivalued: !!p.is_multivalued,
      maxValuesAllowed: p.max_values_allowed ?? null,
      possibleValues: (p.possible_values ?? []).map((v) => ({
        valueId: v.value_id,
        name: v.name,
      })),
    }));
  propertiesCache.set(taxonomyId, { at: Date.now(), properties });
  return properties;
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

/** The connected user's shop sections, in their display order. */
export async function getShopSectionsList(): Promise<ShopSectionOption[]> {
  const shopId = await getShopId();
  const data = await etsyGetJson<{ results: RawShopSection[] }>(
    `/shops/${shopId}/sections`,
  );
  return (data.results ?? [])
    .sort((a, b) => a.rank - b.rank)
    .map((s) => ({ shopSectionId: s.shop_section_id, title: s.title }));
}
