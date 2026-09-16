/**
 * Read side of the DB-backed listings cache (see prisma/schema.prisma's
 * `Listing`) — what the listings page actually renders from. Etsy itself is
 * only re-queried by an explicit refresh (lib/etsy/listing-sync.ts); every
 * other view of the listings page reads this table so it's instant and
 * doesn't burn Etsy's quota.
 *
 * Server-only — pulls in Prisma; never import from a "use client" file.
 */

import { prisma } from "@/lib/db/prisma";
import { getAccessToken, getEtsySession } from "@/lib/etsy/auth";
import { ETSY_LISTING_STATES, fetchShopInfoForToken, type EtsyListingState } from "@/lib/etsy/listings";
import { getActiveShopId, upsertShopConnection } from "@/lib/etsy/shop-connections";

export class NotConnectedError extends Error {
  constructor() {
    super("Not connected to Etsy.");
    this.name = "NotConnectedError";
  }
}

export interface StoredListing {
  listingId: number;
  title: string;
  state: string;
  url: string;
  quantity: number;
  price: string | null;
  thumbnailUrl: string | null;
  endingTimestampMs: number | null;
  shopSectionId: number | null;
  sku: string | null;
}

export interface StoredListingsPage {
  shopId: number;
  count: number;
  limit: number;
  offset: number;
  listings: StoredListing[];
  /** True when this shop has never completed a refresh — lets the page show a "refresh to load your listings" prompt instead of a bare empty state. */
  neverSynced: boolean;
}

/**
 * Resolve which shop's listings the signed-in user should read right now,
 * bootstrapping an `EtsyShopConnection` row on the fly if one doesn't exist
 * yet — a cookie session from before shop connections were recorded never
 * went through the OAuth callback that now writes one. Throws
 * {@link NotConnectedError} when there's no usable Etsy session at all.
 */
export async function resolveActiveShopId(userId: string): Promise<string> {
  const session = await getEtsySession();
  if (!session) throw new NotConnectedError();

  const existing = await getActiveShopId(userId, session.userId);
  if (existing) return existing;

  const accessToken = await getAccessToken();
  if (!accessToken) throw new NotConnectedError();
  // getAccessToken() may have just rotated the cookie (expired-token refresh) — re-read for the current refresh token.
  const freshSession = await getEtsySession();
  if (!freshSession) throw new NotConnectedError();

  const info = await fetchShopInfoForToken(accessToken);
  await upsertShopConnection({
    userId,
    etsyUserId: info.etsyUserId,
    shopId: info.shopId,
    shopName: info.shopName,
    shopIconUrl: info.shopIconUrl,
    refreshToken: freshSession.refreshToken,
  });
  return info.shopId;
}

interface ListingRow {
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

function toStoredListing(row: ListingRow): StoredListing {
  return {
    listingId: Number(row.listingId),
    title: row.title,
    state: row.state,
    url: row.url,
    quantity: row.quantity,
    price: row.price,
    thumbnailUrl: row.thumbnailUrl,
    endingTimestampMs: row.endingAt ? row.endingAt.getTime() : null,
    shopSectionId: row.shopSectionId,
    sku: row.sku,
  };
}

async function hasSynced(userId: string, shopId: string): Promise<boolean> {
  const connection = await prisma.etsyShopConnection.findUnique({
    where: { userId_shopId: { userId, shopId } },
    select: { lastSyncedAt: true },
  });
  return connection?.lastSyncedAt != null;
}

export interface ListStoredListingsOptions {
  userId: string;
  shopId: string;
  state: EtsyListingState;
  limit: number;
  offset: number;
}

/** One page of a shop's stored listings for `state`, newest-created first. */
export async function listStoredListings(options: ListStoredListingsOptions): Promise<StoredListingsPage> {
  const { userId, shopId, state, limit, offset } = options;
  const where = { userId, shopId, state, removedAt: null };

  const [count, rows, synced] = await Promise.all([
    prisma.listing.count({ where }),
    prisma.listing.findMany({ where, orderBy: { createdAt: "desc" }, skip: offset, take: limit }),
    hasSynced(userId, shopId),
  ]);

  return {
    shopId: Number(shopId),
    count,
    limit,
    offset,
    listings: rows.map(toStoredListing),
    neverSynced: !synced,
  };
}

/**
 * Every stored listing for `state`, unpaginated — mirrors the old
 * `fetchAllShopListings`'s `all=true` mode, used for exact client-side
 * section filtering (see the listings page's `load()`).
 */
export async function listAllStoredListings(
  userId: string,
  shopId: string,
  state: EtsyListingState,
): Promise<StoredListingsPage> {
  const where = { userId, shopId, state, removedAt: null };
  const [rows, synced] = await Promise.all([
    prisma.listing.findMany({ where, orderBy: { createdAt: "desc" } }),
    hasSynced(userId, shopId),
  ]);

  return {
    shopId: Number(shopId),
    count: rows.length,
    limit: rows.length,
    offset: 0,
    listings: rows.map(toStoredListing),
    neverSynced: !synced,
  };
}

/**
 * The stored rows for `listingIds` that really belong to this user and shop —
 * the ownership gate every bulk action runs first. An id that isn't the
 * caller's is simply absent from the result (never "forbidden"), so ids can't
 * be probed; the caller reports it as "not found" against that row.
 */
export async function listStoredListingsByIds(
  userId: string,
  shopId: string,
  listingIds: number[],
): Promise<StoredListing[]> {
  if (listingIds.length === 0) return [];
  const rows = await prisma.listing.findMany({
    where: { userId, shopId, listingId: { in: listingIds.map(String) }, removedAt: null },
  });
  const byId = new Map(rows.map((row) => [Number(row.listingId), toStoredListing(row)]));
  // Caller's order — the bulk editor lists rows in the order they were selected.
  return listingIds.map((id) => byId.get(id)).filter((l): l is StoredListing => l != null);
}

/**
 * Mirror a just-saved bulk edit into the cached row, so the listings table
 * reflects it without waiting for a full refresh. Only the columns the table
 * actually shows are written.
 *
 * `price` is deliberately left alone: the cache stores it as a display string
 * ("$19.99") built from Etsy's own currency code, which a bulk edit's bare
 * number can't reproduce — the next refresh picks the new price up.
 */
export async function applyStoredListingPatch(
  userId: string,
  shopId: string,
  listingId: number,
  patch: { title?: string; sku?: string; quantity?: number; shopSectionId?: number },
): Promise<void> {
  const data: { title?: string; sku?: string; quantity?: number; shopSectionId?: number } = {};
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.sku !== undefined) data.sku = patch.sku;
  if (patch.quantity !== undefined) data.quantity = patch.quantity;
  if (patch.shopSectionId !== undefined) data.shopSectionId = patch.shopSectionId;
  if (Object.keys(data).length === 0) return;

  await prisma.listing.updateMany({
    where: { userId, shopId, listingId: String(listingId) },
    data,
  });
}

/**
 * Mark listings deleted on Etsy as removed here too. Rows are never deleted
 * (same as a refresh that no longer finds them), so the history survives.
 */
export async function markStoredListingsRemoved(
  userId: string,
  shopId: string,
  listingIds: number[],
): Promise<void> {
  if (listingIds.length === 0) return;
  await prisma.listing.updateMany({
    where: { userId, shopId, listingId: { in: listingIds.map(String) }, removedAt: null },
    data: { removedAt: new Date() },
  });
}

/** Stored listing count for every state, for the listings page's sidebar filters. */
export async function getStoredListingStateCounts(
  userId: string,
  shopId: string,
): Promise<Record<EtsyListingState, number>> {
  const entries = await Promise.all(
    ETSY_LISTING_STATES.map(async (state) => {
      const count = await prisma.listing.count({ where: { userId, shopId, state, removedAt: null } });
      return [state, count] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<EtsyListingState, number>;
}
