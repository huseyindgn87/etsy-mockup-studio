import { NextResponse } from "next/server";
import { etsyFetch } from "@/lib/etsy/auth";

export const dynamic = "force-dynamic";

/**
 * Demo of an authenticated Etsy API v3 call.
 * `GET /v3/application/users/me` returns the connected user id and shop id.
 */
export async function GET() {
  try {
    const res = await etsyFetch("/users/me");
    const body = await res.json();
    if (!res.ok) {
      return NextResponse.json(
        { error: "Etsy API error", status: res.status, body },
        { status: res.status },
      );
    }
    return NextResponse.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Request failed";
    const status = message === "Not connected to Etsy." ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
