import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { getEtsySession, sessionCookieOptions } from "@/lib/etsy/auth";
import { assertEtsyBudget, withEtsyContext } from "@/lib/etsy/client";
import { getEtsyConfig } from "@/lib/etsy/config";
import { syncShopListings, type RefreshProgressEvent } from "@/lib/etsy/listing-sync";
import { refreshSession } from "@/lib/etsy/oauth";
import {
  getActiveShopId,
  getDecryptedRefreshToken,
  markShopSynced,
  updateConnectionRefreshToken,
} from "@/lib/etsy/shop-connections";
import { sealSession, SESSION_COOKIE, type EtsySession } from "@/lib/etsy/session";

export const dynamic = "force-dynamic";

/**
 * No explicit return type here on purpose: `TextEncoder#encode` returns
 * `Uint8Array<ArrayBuffer>`, and annotating this as the bare `Uint8Array`
 * (which defaults to `Uint8Array<ArrayBufferLike>`) makes the result
 * un-assignable to `BodyInit`'s `ArrayBufferView<ArrayBuffer>` arm under
 * TS 5.7+'s generic typed arrays.
 */
function encodeEvent(event: RefreshProgressEvent) {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

function errorResponse(message: string, status: number): Response {
  return new Response(encodeEvent({ type: "error", message }), {
    status,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}

/**
 * Refresh the active (or a chosen) shop's listings from Etsy and stream
 * progress back as newline-delimited JSON `RefreshProgressEvent`s — the
 * listings page's refresh modal reads this as it arrives to drive its live
 * status line. `POST { shopId? }`: omit `shopId` to refresh the shop that's
 * currently active in the session; pass a different one (from the modal's
 * "Switch shop" dropdown) to switch to it first, using that connection's
 * stored refresh token — this is how the modal changes shop without the
 * user leaving it or re-authorizing.
 *
 * Strictly read-only against Etsy: only ever issues GET requests to it. All
 * DB writes are handled by {@link syncShopListings}, which only touches the
 * database after every page has been fetched successfully.
 */
export async function POST(request: NextRequest) {
  const appSession = await auth();
  if (!appSession?.user?.id) return errorResponse("Not signed in.", 401);
  const userId = appSession.user.id;

  const body = (await request.json().catch(() => ({}))) as { shopId?: unknown };
  const requestedShopId = typeof body.shopId === "string" && body.shopId ? body.shopId : null;

  const etsySession = await getEtsySession();
  let shopId = await getActiveShopId(userId, etsySession?.userId ?? null);

  if (requestedShopId && requestedShopId !== shopId) {
    const storedRefreshToken = await getDecryptedRefreshToken(userId, requestedShopId);
    if (!storedRefreshToken) return errorResponse("That shop isn't connected.", 404);

    try {
      const tokens = await refreshSession(storedRefreshToken);
      const session: EtsySession = { ...tokens, ownerUserId: userId };
      const { sessionSecret } = getEtsyConfig();
      // Written via `cookies()` (not a `NextResponse` we build ourselves) so
      // the switched session is visible to `etsyFetch` for the rest of *this*
      // request — the same pattern `getAccessToken` uses for its own
      // in-request token refresh — while Next still attaches the resulting
      // Set-Cookie to whatever response this handler returns.
      (await cookies()).set(SESSION_COOKIE, sealSession(session, sessionSecret), sessionCookieOptions());
      await updateConnectionRefreshToken(userId, requestedShopId, tokens.refreshToken);
      shopId = requestedShopId;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to switch shop.";
      return errorResponse(message, 502);
    }
  }

  if (!shopId) return errorResponse("Not connected to Etsy.", 401);
  const activeShopId = shopId;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: RefreshProgressEvent) => controller.enqueue(encodeEvent(event));
      try {
        const result = await withEtsyContext({ userId, priority: "background" }, async () => {
          await assertEtsyBudget();
          return syncShopListings(userId, activeShopId, emit);
        });
        await markShopSynced(userId, activeShopId);
        emit({ type: "done", ...result });
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : "Refresh failed." });
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}
