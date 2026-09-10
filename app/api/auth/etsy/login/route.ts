import { NextResponse } from "next/server";
import { getAuthorizationUrl } from "@/lib/etsy/oauth";
import { createPkcePair, createState } from "@/lib/etsy/pkce";
import { STATE_COOKIE, VERIFIER_COOKIE } from "@/lib/etsy/session";

export const dynamic = "force-dynamic";

/**
 * Start the Etsy OAuth flow: mint a PKCE pair + state, stash them in
 * short-lived httpOnly cookies, and redirect to Etsy's consent screen.
 */
export function GET() {
  const { verifier, challenge } = createPkcePair();
  const state = createState();

  const res = NextResponse.redirect(getAuthorizationUrl(challenge, state));

  const temp = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600, // 10 minutes to complete consent
  };
  res.cookies.set(VERIFIER_COOKIE, verifier, temp);
  res.cookies.set(STATE_COOKIE, state, temp);

  return res;
}
