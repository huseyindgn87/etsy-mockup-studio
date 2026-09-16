/**
 * The auth + active-shop resolution every bulk listing route starts with —
 * the listings-side twin of lib/scheduling/request.ts's `resolveScheduleScope`.
 *
 * Server-only.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { NotConnectedError, resolveActiveShopId } from "@/lib/etsy/listing-store";
import { EtsyApiError } from "@/lib/etsy/listings";

export interface ListingScope {
  userId: string;
  /** The Etsy shop id, as stored (a string) — `Number(shopId)` for Etsy calls. */
  shopId: string;
}

export type ListingScopeResult =
  | { ok: true; scope: ListingScope }
  | { ok: false; response: NextResponse };

/**
 * The signed-in user and the Etsy shop they currently have active — the scope
 * every bulk read and write is limited to. 401 when signed out or not
 * connected to Etsy.
 */
export async function resolveListingScope(): Promise<ListingScopeResult> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) };
  }
  try {
    const shopId = await resolveActiveShopId(userId);
    return { ok: true, scope: { userId, shopId } };
  } catch (err) {
    if (err instanceof NotConnectedError) {
      return { ok: false, response: NextResponse.json({ error: err.message }, { status: 401 }) };
    }
    if (err instanceof EtsyApiError) {
      return { ok: false, response: NextResponse.json({ error: err.message }, { status: 502 }) };
    }
    throw err;
  }
}

/** Reads `?ids=1,2,3` (or a JSON body's `listingIds`) into positive integers, de-duplicated. */
export function parseListingIds(raw: unknown): number[] {
  const values = typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : [];
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    const id = typeof value === "number" ? value : Number.parseInt(String(value).trim(), 10);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
