/**
 * Brings the active shop's cached listings in line with Etsy — the listings
 * page's on-demand "Refresh" action. Etsy is always the source of truth; these
 * tables exist only so the app can render instantly instead of live-querying
 * Etsy on every view.
 *
 * Incremental. Strictly read-only against Etsy: every request here is a GET.
 *
 * Two stages, each reported to `onEvent`:
 *  1. `listings` — the lightweight index: every page of every state (100
 *     listings per call, no associations). Each listing's
 *     `last_modified_timestamp` is compared with the one stored with its row;
 *     a listing is re-fetched only when it's new, its timestamp differs (or
 *     either side has none), its state or quantity differs, it was marked
 *     removed, or it never finished syncing. Stored rows the index no longer
 *     lists are marked removed. Nothing is written until the whole index has
 *     arrived, so a failure here leaves the database untouched.
 *  2. `changes` — only the changed listings, 100 at a time: one
 *     `/listings/batch` call (fields, images, videos, personalization) and one
 *     `/listings/batch/inventory` call, falling back to a rate-limited
 *     `getListingInventory` per listing when the batch can't answer for one.
 *     Each chunk — fields, media, grid, `syncedAt` and the Etsy timestamp — is
 *     written in one transaction, so a run that dies resumes by itself: the
 *     next run finds the finished chunks unchanged.
 *
 * A shop with no changes costs only its index pages.
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
/** How many index pages to fetch in parallel — mirrors `fetchAllShopListings`'s own concurrency. */
const SYNC_CONCURRENCY = 4;
/** Defensive cap so a runaway shop/count doesn't loop forever. */
const SAFETY_CAP = 20_000;

/**
 * Per-listing inventory calls per second (the fallback when the batch
 * inventory call can't answer). Etsy's per-app quota is 5/s; staying under it
 * leaves room for the rest of the app while a sync runs.
 */
export const INVENTORY_REQUESTS_PER_SECOND = 4;
const INVENTORY_CONCURRENCY = 4;
/** Changed listings fetched (one batch call + one batch inventory call) and committed together — Etsy's batch cap. */
export const DETAIL_BATCH_SIZE = 100;

export type SyncStage = "listings" | "changes";

export type RefreshProgressEvent =
  | { type: "status"; stage?: SyncStage; message: string }
  | { type: "progress"; stage: SyncStage; fetched: number; total: number; message: string }
  | ({ type: "done" } & SyncResult)
  | { type: "error"; message: string };

export interface SyncResult {
  inserted: number;
  updated: number;
  removed: number;
  /** Listings the index listed (checked). */
  total: number;
  /** Listings re-fetched because they were new or changed. */
  changed: number;
  /** Listings whose stored copy already matched Etsy's timestamp — not fetched. */
  unchanged: number;
}

export const changedMessage = (changed: number, checked: number): string =>
  `${changed} changed of ${checked} checked`;

export interface SyncOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

async function etsyGetJson<T>(path: string): Promise<T> {
  const res = await etsyFetch(path);
  return (await readEtsyResponse(res, `GET ${path}`)) as T;
}

/** An index page: listing fields only, no associations. */
function listingsPagePath(shopId: string, state: EtsyListingState, offset: number): string {
  const query = new URLSearchParams({
    state,
    limit: String(MAX_PAGE),
    offset: String(offset),
    sort_on: "created",
    sort_order: "desc",
  });
  return `/shops/${shopId}/listings?${query.toString()}`;
}

function detailsPath(listingIds: string[]): string {
  const query = new URLSearchParams({
    listing_ids: listingIds.join(","),
    includes: "Images,Videos,Personalization",
  });
  return `/listings/batch?${query.toString()}`;
}

function batchInventoryPath(listingIds: string[]): string {
  return `/listings/batch/inventory?${new URLSearchParams({ listing_ids: listingIds.join(",") }).toString()}`;
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
  inventory?: RawInventory | null;
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
  /** Etsy's last-modified time in ms, stored as `etsyLastModifiedAt`. */
  lastModifiedMs: number | null;
}

/** What the index tells us about a listing — enough to decide whether it changed. */
export interface ListingIndexEntry {
  listingId: string;
  state: string;
  quantity: number;
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

function lastModifiedMs(raw: SyncRawListing): number | null {
  const modified = raw.last_modified_timestamp ?? raw.updated_timestamp;
  return typeof modified === "number" ? modified * 1000 : null;
}

function mapRawListing(raw: SyncRawListing): SyncedListingRow {
  const questions = raw.personalization?.personalization_questions ?? [];
  const isPersonalizable = raw.is_personalizable === true || questions.length > 0;
  const first = questions[0];

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
    lastModifiedMs: lastModifiedMs(raw),
  };
}

/**
 * The index: every listing across every state for `shopId`, paging until each
 * state's Etsy-reported count is exhausted, without associations. Deliberately
 * bypasses `fetchAllShopListings`'s page cache — a manual refresh exists
 * specifically to see past whatever's cached.
 */
async function fetchListingIndex(
  shopId: string,
  onProgress: (fetched: number, total: number) => void,
): Promise<ListingIndexEntry[]> {
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
  const byId = new Map<string, ListingIndexEntry>();
  for (const r of raw) {
    byId.set(String(r.listing_id), {
      listingId: String(r.listing_id),
      state: r.state,
      quantity: r.quantity ?? 0,
      lastModifiedMs: lastModifiedMs(r),
    });
  }
  return [...byId.values()];
}

interface StoredListingState {
  listingId: string;
  state: string;
  quantity: number;
  removedAt: Date | null;
  syncedAt: Date | null;
  etsyLastModifiedAt: Date | null;
}

/**
 * Whether the stored copy of a listing may differ from Etsy's. A missing
 * timestamp on either side (first run, rows from before timestamps were
 * stored) counts as changed.
 */
export function listingChanged(entry: ListingIndexEntry, stored: StoredListingState | undefined): boolean {
  if (!stored || stored.removedAt || !stored.syncedAt) return true;
  if (entry.lastModifiedMs == null || stored.etsyLastModifiedAt == null) return true;
  if (stored.etsyLastModifiedAt.getTime() !== entry.lastModifiedMs) return true;
  return stored.state !== entry.state || stored.quantity !== entry.quantity;
}

/**
 * Full details for up to {@link DETAIL_BATCH_SIZE} changed listings: one
 * batch call for fields and media, one for their inventory. A listing the
 * batch no longer returns (deleted since the index) is left out.
 */
async function fetchDetails(
  listingIds: string[],
  limit: () => Promise<void>,
): Promise<{ rows: SyncedListingRow[]; inventories: Map<string, RawInventory | null> }> {
  const [details, batchInventory] = await Promise.all([
    etsyGetJson<EtsySyncListingsResponse>(detailsPath(listingIds)),
    // All-or-nothing on Etsy's side: one id it can't find 404s the whole call.
    etsyGetJson<EtsySyncListingsResponse>(batchInventoryPath(listingIds)).catch((err) => {
      if (err instanceof EtsyApiError && err.status === 404) return { count: 0, results: [] };
      throw err;
    }),
  ]);
  const rows = (details.results ?? []).map(mapRawListing);

  const inventories = new Map<string, RawInventory | null>();
  for (const r of batchInventory.results ?? []) {
    if (r.inventory && Array.isArray(r.inventory.products)) inventories.set(String(r.listing_id), r.inventory);
  }
  const missing = rows.map((r) => r.listingId).filter((id) => !inventories.has(id));
  for (const [id, inventory] of await fetchInventoryBatch(missing, limit)) inventories.set(id, inventory);
  return { rows, inventories };
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
 * Upsert `rows` by `userId`+`shopId`+`listingId` and replace their images and
 * videos. `id` is generated here since raw SQL bypasses Prisma's
 * `@default(cuid())`; on a conflict it's discarded in favour of the existing
 * row's id (the `DO UPDATE` never touches `id`). Called in the same
 * transaction as the rows' grids, so `syncedAt` and the Etsy timestamp are
 * written with them. Returns listingId → row id.
 */
async function saveListingBatch(
  tx: Prisma.TransactionClient,
  userId: string,
  shopId: string,
  rows: SyncedListingRow[],
  syncedAt: Date,
): Promise<Map<string, string>> {
  const valueRows = rows.map(
    (row) =>
      Prisma.sql`(${randomUUID()}, ${userId}, ${shopId}, ${row.listingId}, ${row.title}, ${row.state}, ${row.url}, ${row.quantity}, ${row.price}, ${row.thumbnailUrl}, ${row.endingAt}, ${row.shopSectionId}, ${row.sku}, ${row.description}, ${row.tags}::text[], ${row.materials}::text[], ${row.listingType}, ${row.whoMade}, ${row.whenMade}, ${row.isSupply}, ${row.priceAmount}, ${row.priceDivisor}, ${row.currencyCode}, ${row.shippingProfileId}, ${row.returnPolicyId}, ${row.itemWeight}, ${row.itemWeightUnit}, ${row.itemLength}, ${row.itemWidth}, ${row.itemHeight}, ${row.itemDimensionsUnit}, ${row.processingMin}, ${row.processingMax}, ${row.isPersonalizable}, ${row.personalizationIsRequired}, ${row.personalizationInstructions}, ${row.personalizationCharCountMax}, ${row.lastModifiedMs == null ? null : new Date(row.lastModifiedMs)}, ${syncedAt}, NULL, NOW(), NOW())`,
  );
  await tx.$executeRaw`
    INSERT INTO "listings"
      ("id", "userId", "shopId", "listingId", "title", "state", "url", "quantity", "price", "thumbnailUrl", "endingAt", "shopSectionId", "sku", "description", "tags", "materials", "listingType", "whoMade", "whenMade", "isSupply", "priceAmount", "priceDivisor", "currencyCode", "shippingProfileId", "returnPolicyId", "itemWeight", "itemWeightUnit", "itemLength", "itemWidth", "itemHeight", "itemDimensionsUnit", "processingMin", "processingMax", "isPersonalizable", "personalizationIsRequired", "personalizationInstructions", "personalizationCharCountMax", "etsyLastModifiedAt", "syncedAt", "removedAt", "createdAt", "updatedAt")
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
      "etsyLastModifiedAt" = EXCLUDED."etsyLastModifiedAt",
      "syncedAt" = EXCLUDED."syncedAt",
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

/** Replace a batch's grids. */
async function saveInventoryBatch(
  tx: Prisma.TransactionClient,
  userId: string,
  batch: { row: SyncedListingRow; rowId: string }[],
  inventories: Map<string, RawInventory | null>,
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
}

/**
 * Bring this shop's stored listings in line with Etsy: read the index, mark
 * stored rows it no longer lists as removed (never deleted, so a listing that
 * comes back later just gets revived), then fetch and upsert — fields, images,
 * videos, inventory grid, by `userId` + `shopId` + `listingId` — only the
 * listings that are new or changed.
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

  const index = await fetchListingIndex(shopId, (fetched, total) => {
    onEvent({
      type: "progress",
      stage: "listings",
      fetched,
      total,
      message: `Checked ${fetched} of ${total} listings`,
    });
  });

  const existing = await prisma.listing.findMany({
    where: { userId, shopId },
    select: { listingId: true, state: true, quantity: true, removedAt: true, syncedAt: true, etsyLastModifiedAt: true },
  });
  const existingById = new Map(existing.map((e) => [e.listingId, e]));
  const indexIds = index.map((e) => e.listingId);
  const indexIdSet = new Set(indexIds);

  const removed = existing.filter((e) => !indexIdSet.has(e.listingId) && !e.removedAt).length;
  if (removed > 0) {
    await prisma.listing.updateMany({
      where: { userId, shopId, listingId: { notIn: indexIds }, removedAt: null },
      data: { removedAt: new Date(now()) },
    });
  }

  const changedIds = index.filter((e) => listingChanged(e, existingById.get(e.listingId))).map((e) => e.listingId);
  const checked = index.length;
  const changed = changedIds.length;
  const summary = changedMessage(changed, checked);
  onEvent({ type: "progress", stage: "changes", fetched: 0, total: changed, message: summary });

  const limit = createRateLimiter(INVENTORY_REQUESTS_PER_SECOND, now, sleep);
  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < changedIds.length; i += DETAIL_BATCH_SIZE) {
    const { rows, inventories } = await fetchDetails(changedIds.slice(i, i + DETAIL_BATCH_SIZE), limit);
    if (rows.length > 0) {
      const syncedAt = new Date(now());
      await prisma.$transaction(
        async (tx) => {
          const rowIds = await saveListingBatch(tx, userId, shopId, rows, syncedAt);
          const batch = rows
            .filter((row) => rowIds.has(row.listingId))
            .map((row) => ({ row, rowId: rowIds.get(row.listingId) as string }));
          await saveInventoryBatch(tx, userId, batch, inventories);
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
      for (const row of rows) {
        if (existingById.has(row.listingId)) updated++;
        else inserted++;
      }
    }
    const done = Math.min(i + DETAIL_BATCH_SIZE, changed);
    onEvent({
      type: "progress",
      stage: "changes",
      fetched: done,
      total: changed,
      message: `${summary} — updated ${done} of ${changed}`,
    });
  }

  return { inserted, updated, removed, total: checked, changed, unchanged: checked - changed };
}
