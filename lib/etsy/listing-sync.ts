/**
 * Pulls every listing (every state, fully paginated) for the active shop
 * straight from Etsy and reconciles it into our own `Listing` table — the
 * listings page's on-demand "Refresh" action. Etsy is always the source of
 * truth; this table exists only so the listings page can render instantly
 * instead of live-querying Etsy on every view.
 *
 * Server-only — pulls in Prisma; never import from a "use client" file.
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { etsyFetch } from "@/lib/etsy/auth";
import {
  decodeHtmlEntities,
  ETSY_LISTING_STATES,
  formatPrice,
  pickThumbnail,
  readEtsyResponse,
  type EtsyInventoryBatchResponse,
  type EtsyListingState,
  type EtsyListingsResponse,
  type EtsyRawListing,
} from "@/lib/etsy/listings";

/** Etsy's per-request page cap. */
const MAX_PAGE = 100;
/** How many pages to fetch in parallel — mirrors `fetchAllShopListings`'s own concurrency. */
const SYNC_CONCURRENCY = 4;
/** Etsy's cap on `listing_ids` per `/listings/batch/inventory` call. */
const SKU_BATCH_LIMIT = 100;
/** Defensive cap so a runaway shop/count doesn't loop forever. */
const SAFETY_CAP = 20_000;

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
    includes: "Images",
  });
  return `/shops/${shopId}/listings?${query.toString()}`;
}

async function fetchSkusForSync(listingIds: number[]): Promise<Map<number, string | null>> {
  if (listingIds.length === 0) return new Map();
  const sorted = [...new Set(listingIds)].sort((a, b) => a - b);
  const chunks: number[][] = [];
  for (let i = 0; i < sorted.length; i += SKU_BATCH_LIMIT) {
    chunks.push(sorted.slice(i, i + SKU_BATCH_LIMIT));
  }
  const pages = await Promise.all(
    chunks.map((chunk) =>
      etsyGetJson<EtsyInventoryBatchResponse>(`/listings/batch/inventory?listing_ids=${chunk.join(",")}`),
    ),
  );
  const map = new Map<number, string | null>();
  for (const page of pages) {
    for (const r of page.results ?? []) {
      map.set(r.listing_id, (r.skus ?? []).find((s) => s.trim().length > 0) ?? null);
    }
  }
  return map;
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
}

function mapRawListing(raw: EtsyRawListing, sku: string | null): SyncedListingRow {
  return {
    listingId: String(raw.listing_id),
    title: decodeHtmlEntities(raw.title),
    state: raw.state,
    url: raw.url,
    quantity: raw.quantity ?? 0,
    price: formatPrice(raw.price),
    thumbnailUrl: pickThumbnail(raw.images),
    endingAt: typeof raw.ending_timestamp === "number" ? new Date(raw.ending_timestamp * 1000) : null,
    shopSectionId:
      typeof raw.shop_section_id === "number" && raw.shop_section_id > 0 ? raw.shop_section_id : null,
    sku,
  };
}

/**
 * Fetch every listing across every state for `shopId`, paging until each
 * state's Etsy-reported count is exhausted. Deliberately bypasses
 * `fetchAllShopListings`'s page cache — a manual refresh exists specifically
 * to see past whatever's cached — but every request still goes through
 * `etsyFetch`, so the 429 retry/backoff and quota logging still apply.
 * `onProgress` is called after every page resolves with the running total.
 */
async function fetchAllListingsForSync(
  shopId: string,
  onProgress: (fetched: number, total: number) => void,
): Promise<SyncedListingRow[]> {
  const firstPages = await Promise.all(
    ETSY_LISTING_STATES.map(async (state) => {
      const data = await etsyGetJson<EtsyListingsResponse>(listingsPagePath(shopId, state, 0));
      return { state, count: Math.min(data.count ?? 0, SAFETY_CAP), results: data.results ?? [] };
    }),
  );

  const total = firstPages.reduce((sum, p) => sum + p.count, 0);
  const raw: EtsyRawListing[] = [];
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
      const data = await etsyGetJson<EtsyListingsResponse>(
        listingsPagePath(shopId, job.state, job.offset),
      );
      const results = data.results ?? [];
      raw.push(...results);
      fetched += results.length;
      onProgress(fetched, total);
    }
  }
  await Promise.all(Array.from({ length: Math.min(SYNC_CONCURRENCY, jobs.length) }, worker));

  const skuByListingId = await fetchSkusForSync(raw.map((r) => r.listing_id));
  return raw.map((r) => mapRawListing(r, skuByListingId.get(r.listing_id) ?? null));
}

export type RefreshProgressEvent =
  | { type: "status"; message: string }
  | { type: "progress"; fetched: number; total: number; message: string }
  | { type: "done"; inserted: number; updated: number; removed: number; total: number }
  | { type: "error"; message: string };

export interface SyncResult {
  inserted: number;
  updated: number;
  removed: number;
  total: number;
}

const TRANSACTION_TIMEOUT_MS = 120_000;

/**
 * How many `Listing` rows go into one `INSERT ... ON CONFLICT DO UPDATE`
 * statement. A row-at-a-time upsert loop (~700 round trips for a mid-size
 * shop) was measured taking well over a minute against Neon and blowing the
 * transaction timeout — batching keeps a full-shop reconciliation to a
 * handful of statements regardless of whether a row is new or changed.
 */
const UPSERT_BATCH_SIZE = 200;

/**
 * Reconcile `rows` into the `listings` table: insert what's new, overwrite
 * what already exists (by `userId`+`shopId`+`listingId`), in batches of
 * {@link UPSERT_BATCH_SIZE}. `id` is generated per row here since raw SQL
 * bypasses Prisma's `@default(cuid())` — a plain UUID is fine, it's just a
 * primary key; on a conflict the generated value is simply discarded in
 * favor of the existing row's own id (the `DO UPDATE` never touches `id`).
 */
async function batchUpsertListings(
  tx: Prisma.TransactionClient,
  userId: string,
  shopId: string,
  rows: SyncedListingRow[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const valueRows = chunk.map(
      (row) =>
        Prisma.sql`(${randomUUID()}, ${userId}, ${shopId}, ${row.listingId}, ${row.title}, ${row.state}, ${row.url}, ${row.quantity}, ${row.price}, ${row.thumbnailUrl}, ${row.endingAt}, ${row.shopSectionId}, ${row.sku}, NULL, NOW(), NOW())`,
    );
    await tx.$executeRaw`
      INSERT INTO "listings"
        ("id", "userId", "shopId", "listingId", "title", "state", "url", "quantity", "price", "thumbnailUrl", "endingAt", "shopSectionId", "sku", "removedAt", "createdAt", "updatedAt")
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
        "removedAt" = NULL,
        "updatedAt" = NOW()
    `;
  }
}

/**
 * Replace this shop's stored listings with what Etsy has right now: upsert
 * every fetched listing by `userId` + `shopId` + `listingId`, and mark any
 * stored row not present in this fetch as removed (never deleted, so a
 * listing that comes back later just gets revived).
 *
 * All DB writes happen only *after* every page across every state has been
 * fetched successfully, in one transaction — a fetch failure partway through
 * throws before touching the database at all, so previously stored data is
 * always left intact for a Retry, and a write failure mid-transaction rolls
 * back rather than leaving a half-applied sync.
 */
export async function syncShopListings(
  userId: string,
  shopId: string,
  onEvent: (event: RefreshProgressEvent) => void,
): Promise<SyncResult> {
  onEvent({ type: "status", message: "Preparing to refresh" });

  const rows = await fetchAllListingsForSync(shopId, (fetched, total) => {
    onEvent({ type: "progress", fetched, total, message: `Fetched ${fetched} of ${total} listings` });
  });

  const existing = await prisma.listing.findMany({
    where: { userId, shopId },
    select: { listingId: true, removedAt: true },
  });
  const existingIds = new Set(existing.map((e) => e.listingId));
  const fetchedIds = rows.map((r) => r.listingId);
  const fetchedIdSet = new Set(fetchedIds);

  const inserted = rows.filter((r) => !existingIds.has(r.listingId)).length;
  const updated = rows.length - inserted;
  const removed = existing.filter((e) => !fetchedIdSet.has(e.listingId) && !e.removedAt).length;

  await prisma.$transaction(
    async (tx) => {
      if (rows.length > 0) await batchUpsertListings(tx, userId, shopId, rows);
      await tx.listing.updateMany({
        where: { userId, shopId, listingId: { notIn: fetchedIds }, removedAt: null },
        data: { removedAt: new Date() },
      });
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  );

  return { inserted, updated, removed, total: rows.length };
}
