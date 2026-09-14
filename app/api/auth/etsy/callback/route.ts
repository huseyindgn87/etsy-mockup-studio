import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { sessionCookieOptions } from "@/lib/etsy/auth";
import { getEtsyConfig } from "@/lib/etsy/config";
import { fetchShopInfoForToken } from "@/lib/etsy/listings";
import { exchangeCodeForSession } from "@/lib/etsy/oauth";
import { upsertShopConnection } from "@/lib/etsy/shop-connections";
import {
  sealSession,
  SESSION_COOKIE,
  STATE_COOKIE,
  VERIFIER_COOKIE,
  type EtsySession,
} from "@/lib/etsy/session";

export const dynamic = "force-dynamic";

function redirectHome(req: NextRequest, params: Record<string, string>) {
  const url = new URL("/", req.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

/**
 * Etsy redirects here with `?code=...&state=...` (or `?error=...`).
 * Validate state, exchange the code for tokens, and persist the sealed session.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const oauthError = searchParams.get("error");
  if (oauthError) {
    return redirectHome(req, {
      etsy_error: searchParams.get("error_description") ?? oauthError,
    });
  }

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const expectedState = req.cookies.get(STATE_COOKIE)?.value;
  const verifier = req.cookies.get(VERIFIER_COOKIE)?.value;

  if (!code || !state || !verifier || state !== expectedState) {
    return redirectHome(req, {
      etsy_error: "Invalid OAuth callback (state mismatch or expired). Try again.",
    });
  }

  const appSession = await auth();
  if (!appSession?.user?.id) {
    return redirectHome(req, { etsy_error: "You must be signed in to connect an Etsy shop." });
  }

  try {
    const tokens = await exchangeCodeForSession(code, verifier);
    const shopInfo = await fetchShopInfoForToken(tokens.accessToken);
    await upsertShopConnection({
      userId: appSession.user.id,
      etsyUserId: shopInfo.etsyUserId,
      shopId: shopInfo.shopId,
      shopName: shopInfo.shopName,
      shopIconUrl: shopInfo.shopIconUrl,
      refreshToken: tokens.refreshToken,
    });

    const session: EtsySession = { ...tokens, ownerUserId: appSession.user.id };
    const { sessionSecret } = getEtsyConfig();

    const res = redirectHome(req, { etsy_connected: "1" });
    res.cookies.set(
      SESSION_COOKIE,
      sealSession(session, sessionSecret),
      sessionCookieOptions(),
    );
    res.cookies.delete(STATE_COOKIE);
    res.cookies.delete(VERIFIER_COOKIE);
    return res;
  } catch (err) {
    return redirectHome(req, {
      etsy_error: err instanceof Error ? err.message : "Token exchange failed.",
    });
  }
}
