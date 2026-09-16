/**
 * Loads an existing listing into the single-listing editor's form.
 *
 * The cached row (filled by lib/etsy/listing-sync.ts) supplies everything it
 * holds. The cache has no category, category attributes, production
 * partners, personalization questions, feature or renewal flag, so those come
 * from one batch read plus one attributes read. A listing that was never
 * synced (no row, or no `syncedAt`) is read from Etsy entirely.
 *
 * Read-only against Etsy. Server-only.
 */

import { prisma } from "@/lib/db/prisma";
import { fetchListingAttributes } from "@/lib/etsy/listing-attributes";
import { fetchListingDetails, type BulkListingDetail } from "@/lib/etsy/listing-details";
import {
  listingFormFromSource,
  sourceFromCache,
  type EditorListingSource,
} from "@/lib/etsy/listing-editor-form";
import { fetchListingInventories } from "@/lib/etsy/listing-inventory";
import { getSellerTaxonomyTree, type TaxonomyNode } from "@/lib/etsy/taxonomy";
import type { ListingFormValue } from "@/app/(app)/mockups/ListingForm";

export interface EditorListingLoad {
  form: ListingFormValue;
  /** Where the listing's own fields came from. */
  source: "cache" | "etsy";
  /** Set when the fields the cache doesn't hold couldn't be read from Etsy. */
  warning: string | null;
}

function taxonomyPath(nodes: TaxonomyNode[], id: number, prefix = ""): string | null {
  for (const n of nodes) {
    const path = prefix ? `${prefix} > ${n.name}` : n.name;
    if (n.id === id) return path;
    const found = taxonomyPath(n.children, id, path);
    if (found) return found;
  }
  return null;
}

async function liveExtras(
  shopId: string,
  listingId: number,
  detail: BulkListingDetail,
): Promise<Pick<EditorListingSource, "taxonomyId" | "taxonomyPath" | "attributes">> {
  const [attributes, tree] = await Promise.all([
    fetchListingAttributes(Number(shopId), [listingId]),
    detail.taxonomyId ? getSellerTaxonomyTree().catch(() => []) : Promise.resolve([]),
  ]);
  return {
    taxonomyId: detail.taxonomyId,
    taxonomyPath: detail.taxonomyId ? (taxonomyPath(tree, detail.taxonomyId) ?? `Category #${detail.taxonomyId}`) : "",
    attributes: attributes.get(listingId) ?? [],
  };
}

/** `null` when the listing isn't this user's and shop's. */
export async function loadListingForEditor(
  userId: string,
  shopId: string,
  listingId: number,
): Promise<EditorListingLoad | null> {
  const row = await prisma.listing.findFirst({
    where: { userId, shopId, listingId: String(listingId), removedAt: null },
    include: {
      inventoryProperties: { include: { values: true } },
      inventoryProducts: { include: { values: { select: { valueId: true } } } },
    },
  });

  if (row?.syncedAt) {
    const source = sourceFromCache(row);
    try {
      const [detail] = await fetchListingDetails([listingId]);
      if (!detail) throw new Error("Etsy didn't return this listing.");
      Object.assign(source, await liveExtras(shopId, listingId, detail), {
        productionPartnerIds: detail.productionPartnerIds,
        personalizationQuestions: detail.personalizationQuestions,
        featured: detail.featured,
        autoRenew: detail.shouldAutoRenew,
        readinessStateId: detail.readinessStateId,
      });
      return { form: listingFormFromSource(source), source: "cache", warning: null };
    } catch (err) {
      return {
        form: listingFormFromSource(source),
        source: "cache",
        warning: `Category, attributes, production partners and renewal settings couldn't be read from Etsy: ${
          err instanceof Error ? err.message : "request failed"
        }`,
      };
    }
  }

  const [detail] = await fetchListingDetails([listingId]);
  if (!detail || String(detail.shopId) !== shopId) return null;
  const [inventories, extras] = await Promise.all([
    fetchListingInventories([listingId]),
    liveExtras(shopId, listingId, detail),
  ]);
  const form = listingFormFromSource({
    title: detail.title,
    description: detail.description,
    tags: detail.tags,
    price: detail.price,
    quantity: detail.quantity,
    sku: detail.sku,
    shopSectionId: detail.shopSectionId,
    readinessStateId: detail.readinessStateId,
    whoMade: detail.whoMade,
    whenMade: detail.whenMade,
    isSupply: detail.isSupply,
    productionPartnerIds: detail.productionPartnerIds,
    personalizationQuestions: detail.personalizationQuestions,
    featured: detail.featured,
    autoRenew: detail.shouldAutoRenew,
    inventory: inventories.get(listingId) ?? null,
    ...extras,
  });
  return { form, source: "etsy", warning: null };
}
