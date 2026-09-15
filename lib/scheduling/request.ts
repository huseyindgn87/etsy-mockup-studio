/**
 * The auth + shop resolution every scheduling route starts with. Server-only.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { NotConnectedError, resolveActiveShopId } from "@/lib/etsy/listing-store";
import { EtsyApiError } from "@/lib/etsy/listings";
import type { Scope, StoreResult } from "./store";

export type ScopeResult = { ok: true; scope: Scope } | { ok: false; response: NextResponse };

/**
 * The signed-in user and their currently active Etsy shop — the scope every
 * scheduled-listing read and write is limited to. Responds 401 when signed
 * out or not connected to Etsy.
 */
export async function resolveScheduleScope(): Promise<ScopeResult> {
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

/** A store result as a response: 200/201 with `{ scheduledListing }`, or 404/409 with `{ error }`. */
export function storeResultResponse<T>(result: StoreResult<T>, successStatus = 200): NextResponse {
  if (result.ok) return NextResponse.json({ scheduledListing: result.value }, { status: successStatus });
  return NextResponse.json({ error: result.error }, { status: result.code === "not_found" ? 404 : 409 });
}
