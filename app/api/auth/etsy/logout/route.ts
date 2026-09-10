import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/etsy/session";

export const dynamic = "force-dynamic";

/** Clear the Etsy session cookie and return home. */
export function POST(req: NextRequest) {
  const res = NextResponse.redirect(new URL("/", req.nextUrl.origin));
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
