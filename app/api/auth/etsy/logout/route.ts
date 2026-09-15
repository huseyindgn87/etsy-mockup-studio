import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/etsy/session";

export const dynamic = "force-dynamic";

/** Where a Disconnect form may ask to land afterward — an allowlist, so this can never become an open redirect. */
const RETURN_PATHS = new Set(["/", "/settings"]);

/** Clear the Etsy session cookie and return home (or to an allowlisted `returnTo` form field, e.g. /settings). */
export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const returnTo = form?.get("returnTo");
  const path = typeof returnTo === "string" && RETURN_PATHS.has(returnTo) ? returnTo : "/";

  const res = NextResponse.redirect(new URL(path, req.nextUrl.origin), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
