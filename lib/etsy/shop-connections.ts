/**
 * DB-backed record of every Etsy shop a `User` has connected via OAuth (see
 * prisma/schema.prisma's `EtsyShopConnection`). The live session cookie
 * (lib/etsy/session.ts) always holds the *currently active* shop's tokens;
 * this table is what lets the app remember other shops the user has
 * previously connected so they can switch back without a full OAuth
 * round-trip — the listings page's "Switch shop" refresh control.
 *
 * Server-only — pulls in Prisma; never import from a "use client" file.
 */

import { prisma } from "@/lib/db/prisma";
import { getEtsyConfig } from "./config";
import { decryptToken, encryptToken } from "./token-crypto";

export interface ShopConnectionSummary {
  shopId: string;
  shopName: string;
  shopIconUrl: string | null;
  active: boolean;
}

/**
 * Record (or update) a shop connection after a successful OAuth exchange —
 * called from the callback route and from a shop switch (which rotates the
 * refresh token). Keyed by `userId` + `shopId`, so reconnecting the same
 * shop just refreshes its stored token and metadata instead of duplicating.
 */
export async function upsertShopConnection(params: {
  userId: string;
  etsyUserId: string;
  shopId: string;
  shopName: string;
  shopIconUrl: string | null;
  refreshToken: string;
}): Promise<void> {
  const { sessionSecret } = getEtsyConfig();
  const encryptedRefreshToken = encryptToken(params.refreshToken, sessionSecret);
  await prisma.etsyShopConnection.upsert({
    where: { userId_shopId: { userId: params.userId, shopId: params.shopId } },
    update: {
      etsyUserId: params.etsyUserId,
      shopName: params.shopName,
      shopIconUrl: params.shopIconUrl,
      refreshToken: encryptedRefreshToken,
      lastConnectedAt: new Date(),
    },
    create: {
      userId: params.userId,
      etsyUserId: params.etsyUserId,
      shopId: params.shopId,
      shopName: params.shopName,
      shopIconUrl: params.shopIconUrl,
      refreshToken: encryptedRefreshToken,
    },
  });
}

/**
 * Every shop the user has connected, most recently connected first, flagged
 * with which one is active right now. `activeEtsyUserId` is the current
 * session cookie's `userId` (the Etsy account currently authorized) — pass
 * `null` when not connected at all.
 */
export async function listShopConnections(
  userId: string,
  activeEtsyUserId: string | null,
): Promise<ShopConnectionSummary[]> {
  const rows = await prisma.etsyShopConnection.findMany({
    where: { userId },
    orderBy: { lastConnectedAt: "desc" },
  });
  return rows.map((row) => ({
    shopId: row.shopId,
    shopName: row.shopName,
    shopIconUrl: row.shopIconUrl,
    active: activeEtsyUserId != null && row.etsyUserId === activeEtsyUserId,
  }));
}

/**
 * The shop id of whichever connection matches the session cookie's Etsy
 * user id — i.e. the shop currently active in the browser — without an
 * Etsy API call. `null` when not connected or the connection was never
 * recorded here (shouldn't happen for a session minted after this feature
 * shipped, but a pre-existing cookie from before it did won't have a row).
 */
export async function getActiveShopId(
  userId: string,
  activeEtsyUserId: string | null,
): Promise<string | null> {
  if (!activeEtsyUserId) return null;
  const row = await prisma.etsyShopConnection.findFirst({
    where: { userId, etsyUserId: activeEtsyUserId },
    select: { shopId: true },
  });
  return row?.shopId ?? null;
}

/** Decrypted refresh token for a stored connection, or `null` if it doesn't exist. */
export async function getDecryptedRefreshToken(
  userId: string,
  shopId: string,
): Promise<string | null> {
  const row = await prisma.etsyShopConnection.findUnique({
    where: { userId_shopId: { userId, shopId } },
    select: { refreshToken: true },
  });
  if (!row) return null;
  const { sessionSecret } = getEtsyConfig();
  return decryptToken(row.refreshToken, sessionSecret);
}

/** Etsy rotates the refresh token on every use — persist the new one after a switch. */
export async function updateConnectionRefreshToken(
  userId: string,
  shopId: string,
  refreshToken: string,
): Promise<void> {
  const { sessionSecret } = getEtsyConfig();
  await prisma.etsyShopConnection.update({
    where: { userId_shopId: { userId, shopId } },
    data: {
      refreshToken: encryptToken(refreshToken, sessionSecret),
      lastConnectedAt: new Date(),
    },
  });
}

/**
 * The access token last minted for background work on this connection, while
 * it has more than a minute left; `null` otherwise.
 */
export async function getCachedAccessToken(userId: string, shopId: string, nowMs = Date.now()): Promise<string | null> {
  const row = await prisma.etsyShopConnection.findUnique({
    where: { userId_shopId: { userId, shopId } },
    select: { accessToken: true, accessTokenExpiresAt: true },
  });
  if (!row?.accessToken || !row.accessTokenExpiresAt) return null;
  if (row.accessTokenExpiresAt.getTime() - 60_000 <= nowMs) return null;
  const { sessionSecret } = getEtsyConfig();
  try {
    return decryptToken(row.accessToken, sessionSecret);
  } catch {
    return null;
  }
}

/** Stores a freshly minted token pair: the rotated refresh token and the access token for reuse. */
export async function saveConnectionTokens(
  userId: string,
  shopId: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: number },
): Promise<void> {
  const { sessionSecret } = getEtsyConfig();
  await prisma.etsyShopConnection.update({
    where: { userId_shopId: { userId, shopId } },
    data: {
      refreshToken: encryptToken(tokens.refreshToken, sessionSecret),
      accessToken: encryptToken(tokens.accessToken, sessionSecret),
      accessTokenExpiresAt: new Date(tokens.expiresAt),
      lastConnectedAt: new Date(),
    },
  });
}

export async function markShopSynced(userId: string, shopId: string): Promise<void> {
  await prisma.etsyShopConnection.update({
    where: { userId_shopId: { userId, shopId } },
    data: { lastSyncedAt: new Date() },
  });
}
