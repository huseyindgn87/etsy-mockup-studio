/**
 * Pulls every listing (every state, fully paginated) for the active shop
 * straight from Etsy and reconciles it into our own tables — the listings
 * page's on-demand "Refresh" action. Etsy is always the source of truth; these
 * tables exist only so the app can render instantly instead of live-querying
 * Etsy on every view.
 *
 * Strictly read-only against Etsy: every request here is a GET.
 *
 * Three stages, each reported to `onEvent`:
 *  1. `listings`  — every page of every state, with images, videos and
 *     personalization as associations. Nothing is written until all pages
 *     have arrived, so a failure here leaves the database untouched.
 *  2. `saving`    — listing fields, images and videos upserted in batches;
 *     rows no longer on Etsy are marked removed.
 *  3. `inventory` — one `getListingInventory` call per listing, rate-limited,
 *     written in batches. A listing's `syncedAt` is set in the same
 *     transaction as its grid, so it marks "fully synced".
 *
 * Resuming: a listing whose `syncedAt` is newer than the shop connection's
 * `lastSyncedAt` (set by the route only after a whole sync succeeds) was
 * finished by a run that didn't complete. A re-run skips its inventory call
 * unless Etsy reports it modified since, or that run is older than
 * {@link RESUME_WINDOW_MS}.
 *
 * Server-only — pulls in Prisma; never import from a "use client" file.
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { etsyFetch } from "@/lib/etsy/auth";
import { liveProducts, readInventory, type RawInventory } from "@/lib/etsy/listing-inventory";
import {
  decodeHtmlEntities,
  ETSY_LISTING_STATES,
  EtsyApiError,
  formatPrice,
  pickThumbnail,
  readEtsyResponse,
  type EtsyListingImage,
  type EtsyListingState,
  type EtsyRawListing,
} from "@/lib/etsy/listings";

/** Etsy's per-request page cap. */
const MAX_PAGE = 100;
/** How many pages to fetch in parallel — mirrors `fetchAllShopListings`'s own concurrency. */
const SYNC_CONCURRENCY = 4;
/** Defensive cap so a runaway shop/count doesn't loop forever. */
const SAFETY_CAP = 20_000;

/**
 * Inventory calls per second. Etsy's per-app quota is 5/s; staying under it
 * leaves room for the rest of the app while a sync runs.
 */
export const INVENTORY_REQUESTS_PER_SECOND = 4;
const INVENTORY_CONCURRENCY = 4;
/** Listings whose inventory is fetched and committed together. */
const INVENTORY_BATCH_SIZE = 25;
/** How old an unfinished run can be and still be resumed rather than redone. */
export const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

export type SyncStage = "listings" | "saving" | "inventory";

export type RefreshProgressEvent =
  | { type: "status"; stage?: SyncStage; message: string }
  | { type: "progress"; stage: SyncStage; fetched: number; total: number; message: string }
  | { type: "done"; inserted: number; updated: number; removed: number; total: number; resumed: number }
  | { type: "error"; message: string };

export interface SyncResult {
  inserted: number;
  updated: number;
  removed: number;
  total: number;
  /** Listings whose inventory an earlier, unfinished run had already stored. */
  resumed: number;
}

export interface SyncOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

async function etsyGetJson<T>(path: string): Promise<T> {
  const res = await etsyFetch(path);
  return (await readEtsyResponse(res, `GET ${path}`)) as T;
}

function listingsPagePath(shopId: string, state: EtsyListingState, offset: number): string {
  const query = new URLSearchParams({
    state,
    limit: String(MAX_PAGE),
    offset: String(offset),
    sort_on: "created",
    sort_order: "desc",
    includes: "Images,Videos,Personalization",
  });
  return `/shops/${shopId}/listings?${query.toString()}`;
}

interface SyncRawImage extends EtsyListingImage {
  listing_image_id?: number;
  rank?: number;
  alt_text?: string | null;
}

interface SyncRawListing extends EtsyRawListing {
  images?: SyncRawImage[];
  videos?: {
    video_id?: number;
    thumbnail_url?: string;
    video_url?: string;
    video_state?: string;
  }[];
  description?: string;
  tags?: string[];
  materials?: string[];
  listing_type?: string;
  who_made?: string;
  when_made?: string;
  is_supply?: boolean;
  shipping_profile_id?: number | null;
  return_policy_id?: number | null;
  item_weight?: number | null;
  item_weight_unit?: string | null;
  item_length?: number | null;
  item_width?: number | null;
  item_height?: number | null;
  item_dimensions_unit?: string | null;
  processing_min?: number | null;
  processing_max?: number | null;
  is_personalizable?: boolean;
  personalization_is_required?: boolean;
  personalization_instructions?: string | null;
  personalization_char_count_max?: number | null;
  personalization?: {
    personalization_questions?: {
      instructions?: string;
      required?: boolean;
      max_allowed_characters?: number;
    }[];
  };
  skus?: string[];
  last_modified_timestamp?: number;
  updated_timestamp?: number;
}

interface EtsySyncListingsResponse {
  count: number;
  results: SyncRawListing[];
}

export interface SyncedImage {
  etsyImageId: string | null;
  url: string;
  altText: string | null;
  rank: number;
}

export interface SyncedVideo {
  etsyVideoId: string | null;
  url: string;
  thumbnailUrl: string | null;
  rank: number;
}

export interface SyncedListingRow {
  listingId: string;
  title: string;
  state: string;
  url: string;
  quantity: number;
  price: string | null;
  thumbnailUrl: string | null;
  endingAt: Date | null;
  shopSectionId: number | null;
  sku: string | null;
  description: string | null;
  tags: string[];
  materials: string[];
  listingType: string | null;
  whoMade: string | null;
  whenMade: string | null;
  isSupply: boolean | null;
  priceAmount: number | null;
  priceDivisor: number | null;
  currencyCode: string | null;
  shippingProfileId: string | null;
  returnPolicyId: string | null;
  itemWeight: number | null;
  itemWeightUnit: string | null;
  itemLength: number | null;
  itemWidth: number | null;
  itemHeight: number | null;
  itemDimensionsUnit: string | null;
  processingMin: number | null;
  processingMax: number | null;
  isPersonalizable: boolean;
  personalizationIsRequired: boolean;
  personalizationInstructions: string | null;
  personalizationCharCountMax: number | null;
  images: SyncedImage[];
  videos: SyncedVideo[];
  /** Etsy's last-modified time in ms — used to decide resumes, not stored. */
  lastModifiedMs: number | null;
}

const positiveOrNull = (value: unknown): number | null =>
  typeof value === "number" && value > 0 ? value : null;

const idOrNull = (value: unknown): string | null => {
  const n = positiveOrNull(value);
  return n == null ? null : String(n);
};

const textOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

const intOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;

function mapImages(raw: SyncRawImage[] | undefined): SyncedImage[] {
  return (raw ?? [])
    .map((img, i) => ({
      etsyImageId: idOrNull(img.listing_image_id),
      url: img.url_fullxfull ?? img.url_570xN ?? img.url_340x270 ?? img.url_170x135 ?? img.url_75x75 ?? "",
      altText: textOrNull(img.alt_text),
      rank: typeof img.rank === "number" ? img.rank : i + 1,
    }))
    .filter((img) => img.url)
    .sort((a, b) => a.rank - b.rank);
}

function mapVideos(raw: SyncRawListing["videos"]): SyncedVideo[] {
  return (raw ?? [])
    .filter((v) => v.video_url && v.video_state !== "deleted")
    .map((v, i) => ({
      etsyVideoId: idOrNull(v.video_id),
      url: v.video_url as string,
      thumbnailUrl: textOrNull(v.thumbnail_url),
      rank: i + 1,
    }));
}

function mapRawListing(raw: SyncRawListing): SyncedListingRow {
  const questions = raw.personalization?.personalization_questions ?? [];
  const isPersonalizable = raw.is_personalizable === true || questions.length > 0;
  const first = questions[0];
  const modified = raw.last_modified_timestamp ?? raw.updated_timestamp;

  return {
    listingId: String(raw.listing_id),
    title: decodeHtmlEntities(raw.title),
    state: raw.state,
    url: raw.url,
    quantity: raw.quantity ?? 0,
    price: formatPrice(raw.price),
    thumbnailUrl: pickThumbnail(raw.images),
    endingAt: typeof raw.ending_timestamp === "number" ? new Date(raw.ending_timestamp * 1000) : null,
    shopSectionId: positiveOrNull(raw.shop_section_id),
    sku: (raw.skus ?? []).find((s) => s.trim().length > 0) ?? null,
    description: typeof raw.description === "string" ? decodeHtmlEntities(raw.description) : null,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    materials: Array.isArray(raw.materials) ? raw.materials : [],
    listingType: textOrNull(raw.listing_type),
    whoMade: textOrNull(raw.who_made),
    whenMade: textOrNull(raw.when_made),
    isSupply: typeof raw.is_supply === "boolean" ? raw.is_supply : null,
    priceAmount: raw.price ? intOrNull(raw.price.amount) : null,
    priceDivisor: raw.price ? intOrNull(raw.price.divisor) : null,
    currencyCode: textOrNull(raw.price?.currency_code),
    shippingProfileId: idOrNull(raw.shipping_profile_id),
    returnPolicyId: idOrNull(raw.return_policy_id),
    itemWeight: positiveOrNull(raw.item_weight),
    itemWeightUnit: textOrNull(raw.item_weight_unit),
    itemLength: positiveOrNull(raw.item_length),
    itemWidth: positiveOrNull(raw.item_width),
    itemHeight: positiveOrNull(raw.item_height),
    itemDimensionsUnit: textOrNull(raw.item_dimensions_unit),
    processingMin: intOrNull(raw.processing_min),
    processingMax: intOrNull(raw.processing_max),
    isPersonalizable,
    personalizationIsRequired: isPersonalizable && (raw.personalization_is_required ?? first?.required) === true,
    personalizationInstructions: isPersonalizable
      ? textOrNull(raw.personalization_instructions ?? first?.instructions)
      : null,
    personalizationCharCountMax: isPersonalizable
      ? intOrNull(raw.personalization_char_count_max ?? first?.max_allowed_characters)
      : null,
    images: mapImages(raw.images),
    videos: mapVideos(raw.videos),
    lastModifiedMs: typeof modified === "number" ? modified * 1000 : null,
  };
}

/**
 * Fetch every listing across every state for `shopId`, paging until each
 * state's Etsy-reported count is exhausted. Deliberately bypasses
 * `fetchAllShopListings`'s page cache — a manual refresh exists specifically
 * to see past whatever's cached — but every request still goes through
 * `etsyFetch`, so the 429 retry/backoff and quota logging still apply.
 */
async function fetchAllListingsForSync(
  shopId: string,
  onProgress: (fetched: number, total: number) => void,
): Promise<SyncedListingRow[]> {
  const firstPages = await Promise.all(
    ETSY_LISTING_STATES.map(async (state) => {
      const data = await etsyGetJson<EtsySyncListingsResponse>(listingsPagePath(shopId, state, 0));
      return { state, count: Math.min(data.count ?? 0, SAFETY_CAP), results: data.results ?? [] };
    }),
  );

  const total = firstPages.reduce((sum, p) => sum + p.count, 0);
  const raw: SyncRawListing[] = [];
  let fetched = 0;
  for (const page of firstPages) {
    raw.push(...page.results);
    fetched += page.results.length;
  }
  onProgress(fetched, total);

  const jobs: Array<{ state: EtsyListingState; offset: number }> = [];
  for (const page of firstPages) {
    for (let offset = MAX_PAGE; offset < page.count; offset += MAX_PAGE) {
      jobs.push({ state: page.state, offset });
    }
  }

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const data = await etsyGetJson<EtsySyncListingsResponse>(
        listingsPagePath(shopId, job.state, job.offset),
      );
      const results = data.results ?? [];
      raw.push(...results);
      fetched += results.length;
      onProgress(fetched, total);
    }
  }
  await Promise.all(Array.from({ length: Math.min(SYNC_CONCURRENCY, jobs.length) }, worker));

  // A listing changing state mid-sync can show up on two state pages.
  const byId = new Map<string, SyncedListingRow>();
  for (const r of raw) byId.set(String(r.listing_id), mapRawListing(r));
  return [...byId.values()];
}

/**
 * Spaces calls at least `1000 / perSecond` ms apart, across every concurrent
 * caller — so no one-second window ever holds more than `perSecond` calls.
 */
export function createRateLimiter(
  perSecond: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): () => Promise<void> {
  const interval = 1000 / perSecond;
  let nextSlot = 0;
  return async () => {
    const t = now();
    const slot = Math.max(t, nextSlot);
    nextSlot = slot + interval;
    if (slot > t) await sleep(slot - t);
  };
}

/**
 * Each listing's inventory, rate-limited. A listing Etsy no longer has (404,
 * deleted since its page was read) maps to `null`; any other failure stops
 * the batch and is thrown, so nothing from it is written.
 */
async function fetchInventoryBatch(
  listingIds: string[],
  limit: () => Promise<void>,
): Promise<Map<string, RawInventory | null>> {
  const out = new Map<string, RawInventory | null>();
  let cursor = 0;
  let failed = false;

  async function worker(): Promise<void> {
    while (!failed && cursor < listingIds.length) {
      const listingId = listingIds[cursor++];
      await limit();
      if (failed) return;
      try {
        out.set(listingId, await readInventory(Number(listingId)));
      } catch (err) {
        if (err instanceof EtsyApiError && err.status === 404) {
          out.set(listingId, null);
        } else {
          failed = true;
          throw err;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(INVENTORY_CONCURRENCY, listingIds.length) }, worker));
  return out;
}

const TRANSACTION_TIMEOUT_MS = 120_000;

/**
 * How many `Listing` rows go into one `INSERT ... ON CONFLICT DO UPDATE`
 * statement (with their images and videos in the same transaction). A
 * row-at-a-time upsert loop (~700 round trips for a mid-size shop) was
 * measured taking well over a minute against Neon — batching keeps a
 * full-shop reconciliation to a handful of statements.
 */
const UPSERT_BATCH_SIZE = 100;

/**
 * Upsert `rows` by `userId`+`shopId`+`listingId` and replace their images and
 * videos. `id` is generated here since raw SQL bypasses Prisma's
 * `@default(cuid())`; on a conflict it's discarded in favour of the existing
 * row's id (the `DO UPDATE` never touches `id`). `syncedAt` is left alone —
 * only the inventory stage sets it. Returns listingId → row id.
 */
async function saveListingBatch(
  tx: Prisma.TransactionClient,
  userId: string,
  shopId: string,
  rows: SyncedListingRow[],
): Promise<Map<string, string>> {
  const valueRows = rows.map(
    (row) =>
      Prisma.sql`(${randomUUID()}, ${userId}, ${shopId}, ${row.listingId}, ${row.title}, ${row.state}, ${row.url}, ${row.quantity}, ${row.price}, ${row.thumbnailUrl}, ${row.endingAt}, ${row.shopSectionId}, ${row.sku}, ${row.description}, ${row.tags}::text[], ${row.materials}::text[], ${row.listingType}, ${row.whoMade}, ${row.whenMade}, ${row.isSupply}, ${row.priceAmount}, ${row.priceDivisor}, ${row.currencyCode}, ${row.shippingProfileId}, ${row.returnPolicyId}, ${row.itemWeight}, ${row.itemWeightUnit}, ${row.itemLength}, ${row.itemWidth}, ${row.itemHeight}, ${row.itemDimensionsUnit}, ${row.processingMin}, ${row.processingMax}, ${row.isPersonalizable}, ${row.personalizationIsRequired}, ${row.personalizationInstructions}, ${row.personalizationCharCountMax}, NULL, NOW(), NOW())`,
  );
  await tx.$executeRaw`
    INSERT INTO "listings"
      ("id", "userId", "shopId", "listingId", "title", "state", "url", "quantity", "price", "thumbnailUrl", "endingAt", "shopSectionId", "sku", "description", "tags", "materials", "listingType", "whoMade", "whenMade", "isSupply", "priceAmount", "priceDivisor", "currencyCode", "shippingProfileId", "returnPolicyId", "itemWeight", "itemWeightUnit", "itemLength", "itemWidth", "itemHeight", "itemDimensionsUnit", "processingMin", "processingMax", "isPersonalizable", "personalizationIsRequired", "personalizationInstructions", "personalizationCharCountMax", "removedAt", "createdAt", "updatedAt")
    VALUES ${Prisma.join(valueRows)}
    ON CONFLICT ("userId", "shopId", "listingId")
    DO UPDATE SET
      "title" = EXCLUDED."title",
      "state" = EXCLUDED."state",
      "url" = EXCLUDED."url",
      "quantity" = EXCLUDED."quantity",
      "price" = EXCLUDED."price",
      "thumbnailUrl" = EXCLUDED."thumbnailUrl",
      "endingAt" = EXCLUDED."endingAt",
      "shopSectionId" = EXCLUDED."shopSectionId",
      "sku" = EXCLUDED."sku",
      "description" = EXCLUDED."description",
      "tags" = EXCLUDED."tags",
      "materials" = EXCLUDED."materials",
      "listingType" = EXCLUDED."listingType",
      "whoMade" = EXCLUDED."whoMade",
      "whenMade" = EXCLUDED."whenMade",
      "isSupply" = EXCLUDED."isSupply",
      "priceAmount" = EXCLUDED."priceAmount",
      "priceDivisor" = EXCLUDED."priceDivisor",
      "currencyCode" = EXCLUDED."currencyCode",
      "shippingProfileId" = EXCLUDED."shippingProfileId",
      "returnPolicyId" = EXCLUDED."returnPolicyId",
      "itemWeight" = EXCLUDED."itemWeight",
      "itemWeightUnit" = EXCLUDED."itemWeightUnit",
      "itemLength" = EXCLUDED."itemLength",
      "itemWidth" = EXCLUDED."itemWidth",
      "itemHeight" = EXCLUDED."itemHeight",
      "itemDimensionsUnit" = EXCLUDED."itemDimensionsUnit",
      "processingMin" = EXCLUDED."processingMin",
      "processingMax" = EXCLUDED."processingMax",
      "isPersonalizable" = EXCLUDED."isPersonalizable",
      "personalizationIsRequired" = EXCLUDED."personalizationIsRequired",
      "personalizationInstructions" = EXCLUDED."personalizationInstructions",
      "personalizationCharCountMax" = EXCLUDED."personalizationCharCountMax",
      "removedAt" = NULL,
      "updatedAt" = NOW()
  `;

  const stored = await tx.listing.findMany({
    where: { userId, shopId, listingId: { in: rows.map((r) => r.listingId) } },
    select: { id: true, listingId: true },
  });
  const rowIdByListingId = new Map(stored.map((s) => [s.listingId, s.id]));
  const rowIds = stored.map((s) => s.id);

  await tx.listingImage.deleteMany({ where: { userId, listingRowId: { in: rowIds } } });
  await tx.listingVideo.deleteMany({ where: { userId, listingRowId: { in: rowIds } } });

  const images: Prisma.ListingImageCreateManyInput[] = [];
  const videos: Prisma.ListingVideoCreateManyInput[] = [];
  for (const row of rows) {
    const listingRowId = rowIdByListingId.get(row.listingId);
    if (!listingRowId) continue;
    for (const img of row.images) images.push({ userId, listingRowId, ...img });
    for (const video of row.videos) videos.push({ userId, listingRowId, ...video });
  }
  if (images.length > 0) await tx.listingImage.createMany({ data: images });
  if (videos.length > 0) await tx.listingVideo.createMany({ data: videos });

  return rowIdByListingId;
}

interface InventoryRows {
  properties: Prisma.ListingInventoryPropertyCreateManyInput[];
  values: Prisma.ListingInventoryValueCreateManyInput[];
  products: Prisma.ListingInventoryProductCreateManyInput[];
  productValues: Prisma.ListingInventoryProductValueCreateManyInput[];
}

/** One listing's grid as rows: properties/values in Etsy's product order, then each live product. */
function inventoryRows(
  userId: string,
  listingRowId: string,
  listing: SyncedListingRow,
  inventory: RawInventory,
  out: InventoryRows,
): void {
  const products = liveProducts(inventory);
  const priceOn = new Set(inventory.price_on_property ?? []);
  const quantityOn = new Set(inventory.quantity_on_property ?? []);
  const skuOn = new Set(inventory.sku_on_property ?? []);

  const properties = new Map<number, { id: string; values: { id: string; etsyValueId: number | null; value: string }[] }>();

  const valueRowFor = (propertyId: number, valueId: number | null, value: string): string => {
    const property = properties.get(propertyId)!;
    const known = property.values.find((v) =>
      valueId == null ? v.etsyValueId == null && v.value === value : v.etsyValueId === valueId,
    );
    if (known) return known.id;
    const id = randomUUID();
    property.values.push({ id, etsyValueId: valueId, value });
    out.values.push({
      id,
      userId,
      propertyId: property.id,
      etsyValueId: valueId == null ? null : String(valueId),
      value,
      rank: property.values.length - 1,
    });
    return id;
  };

  const productValueIds: string[][] = [];
  for (const product of products) {
    const valueIds: string[] = [];
    for (const pv of product.property_values ?? []) {
      if (!properties.has(pv.property_id)) {
        const id = randomUUID();
        properties.set(pv.property_id, { id, values: [] });
        out.properties.push({
          id,
          userId,
          listingRowId,
          etsyPropertyId: String(pv.property_id),
          name: pv.property_name ?? `property #${pv.property_id}`,
          scaleId: idOrNull(pv.scale_id),
          scaleName: textOrNull(pv.scale_name),
          rank: properties.size - 1,
          priceOnProperty: priceOn.has(pv.property_id),
          quantityOnProperty: quantityOn.has(pv.property_id),
          skuOnProperty: skuOn.has(pv.property_id),
        });
      }
      const names = pv.values ?? [];
      for (let i = 0; i < names.length; i++) {
        const id = valueRowFor(pv.property_id, pv.value_ids?.[i] ?? null, names[i]);
        if (!valueIds.includes(id)) valueIds.push(id);
      }
    }
    productValueIds.push(valueIds);
  }

  products.forEach((product, index) => {
    const offering = (product.offerings ?? []).find((o) => !o.is_deleted);
    if (!offering) return;
    const id = randomUUID();
    out.products.push({
      id,
      userId,
      listingRowId,
      etsyProductId: idOrNull(product.product_id),
      etsyOfferingId: idOrNull(offering.offering_id),
      sku: textOrNull(product.sku?.trim()),
      priceAmount: offering.price?.amount ?? listing.priceAmount ?? 0,
      priceDivisor: offering.price?.divisor || listing.priceDivisor || 100,
      currencyCode: offering.price?.currency_code ?? listing.currencyCode ?? "",
      quantity: Math.max(0, Math.trunc(offering.quantity ?? 0)),
      isEnabled: offering.is_enabled !== false,
      readinessStateId: idOrNull(offering.readiness_state_id),
    });
    for (const valueId of productValueIds[index]) {
      out.productValues.push({ userId, productId: id, valueId });
    }
  });
}

/** Replace a batch's grids and mark those listings synced, in one transaction. */
async function saveInventoryBatch(
  tx: Prisma.TransactionClient,
  userId: string,
  shopId: string,
  batch: { row: SyncedListingRow; rowId: string }[],
  inventories: Map<string, RawInventory | null>,
  syncedAt: Date,
): Promise<void> {
  const rowIds = batch.map((b) => b.rowId);
  // Deleting properties cascades to their values and product links.
  await tx.listingInventoryProperty.deleteMany({ where: { userId, listingRowId: { in: rowIds } } });
  await tx.listingInventoryProduct.deleteMany({ where: { userId, listingRowId: { in: rowIds } } });

  const out: InventoryRows = { properties: [], values: [], products: [], productValues: [] };
  for (const { row, rowId } of batch) {
    const inventory = inventories.get(row.listingId);
    if (inventory) inventoryRows(userId, rowId, row, inventory, out);
  }
  if (out.properties.length > 0) await tx.listingInventoryProperty.createMany({ data: out.properties });
  if (out.values.length > 0) await tx.listingInventoryValue.createMany({ data: out.values });
  if (out.products.length > 0) await tx.listingInventoryProduct.createMany({ data: out.products });
  if (out.productValues.length > 0) await tx.listingInventoryProductValue.createMany({ data: out.productValues });

  await tx.listing.updateMany({ where: { userId, shopId, id: { in: rowIds } }, data: { syncedAt } });
}

/**
 * Bring this shop's stored listings in line with Etsy: upsert every fetched
 * listing (fields, images, videos, inventory grid) by `userId` + `shopId` +
 * `listingId`, and mark any stored row not present in this fetch as removed
 * (never deleted, so a listing that comes back later just gets revived).
 */
export async function syncShopListings(
  userId: string,
  shopId: string,
  onEvent: (event: RefreshProgressEvent) => void,
  options: SyncOptions = {},
): Promise<SyncResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  onEvent({ type: "status", stage: "listings", message: "Preparing to refresh" });

  const rows = await fetchAllListingsForSync(shopId, (fetched, total) => {
    onEvent({
      type: "progress",
      stage: "listings",
      fetched,
      total,
      message: `Fetched ${fetched} of ${total} listings`,
    });
  });

  const [existing, connection] = await Promise.all([
    prisma.listing.findMany({
      where: { userId, shopId },
      select: { listingId: true, removedAt: true, syncedAt: true },
    }),
    prisma.etsyShopConnection.findUnique({
      where: { userId_shopId: { userId, shopId } },
      select: { lastSyncedAt: true },
    }),
  ]);
  const existingById = new Map(existing.map((e) => [e.listingId, e]));
  const fetchedIds = rows.map((r) => r.listingId);
  const fetchedIdSet = new Set(fetchedIds);

  const inserted = rows.filter((r) => !existingById.has(r.listingId)).length;
  const updated = rows.length - inserted;
  const removed = existing.filter((e) => !fetchedIdSet.has(e.listingId) && !e.removedAt).length;

  const lastCompletedMs = connection?.lastSyncedAt?.getTime() ?? 0;
  const startedMs = now();
  const alreadySynced = (row: SyncedListingRow): boolean => {
    const syncedMs = existingById.get(row.listingId)?.syncedAt?.getTime();
    if (syncedMs == null) return false;
    if (syncedMs <= lastCompletedMs) return false;
    if (startedMs - syncedMs > RESUME_WINDOW_MS) return false;
    return row.lastModifiedMs == null || row.lastModifiedMs <= syncedMs;
  };

  const rowIdByListingId = new Map<string, string>();
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const ids = await prisma.$transaction((tx) => saveListingBatch(tx, userId, shopId, chunk), {
      timeout: TRANSACTION_TIMEOUT_MS,
    });
    for (const [listingId, rowId] of ids) rowIdByListingId.set(listingId, rowId);
    const saved = Math.min(i + UPSERT_BATCH_SIZE, rows.length);
    onEvent({
      type: "progress",
      stage: "saving",
      fetched: saved,
      total: rows.length,
      message: `Saved ${saved} of ${rows.length} listings`,
    });
  }
  await prisma.listing.updateMany({
    where: { userId, shopId, listingId: { notIn: fetchedIds }, removedAt: null },
    data: { removedAt: new Date(now()) },
  });

  const pending = rows.filter((r) => !alreadySynced(r) && rowIdByListingId.has(r.listingId));
  const resumed = rows.length - pending.length;
  if (resumed > 0) {
    onEvent({
      type: "status",
      stage: "inventory",
      message: `Resuming — ${resumed} of ${rows.length} listings already have their variations`,
    });
  }

  const limit = createRateLimiter(INVENTORY_REQUESTS_PER_SECOND, now, sleep);
  let done = resumed;
  onEvent({
    type: "progress",
    stage: "inventory",
    fetched: done,
    total: rows.length,
    message: `Loaded variations for ${done} of ${rows.length} listings`,
  });
  for (let i = 0; i < pending.length; i += INVENTORY_BATCH_SIZE) {
    const batch = pending
      .slice(i, i + INVENTORY_BATCH_SIZE)
      .map((row) => ({ row, rowId: rowIdByListingId.get(row.listingId) as string }));
    const inventories = await fetchInventoryBatch(
      batch.map((b) => b.row.listingId),
      limit,
    );
    const syncedAt = new Date(now());
    await prisma.$transaction(
      (tx) => saveInventoryBatch(tx, userId, shopId, batch, inventories, syncedAt),
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    done += batch.length;
    onEvent({
      type: "progress",
      stage: "inventory",
      fetched: done,
      total: rows.length,
      message: `Loaded variations for ${done} of ${rows.length} listings`,
    });
  }

  return { inserted, updated, removed, total: rows.length, resumed };
}
