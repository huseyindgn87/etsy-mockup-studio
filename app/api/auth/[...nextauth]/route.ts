import type { NextRequest } from "next/server";
import { handlers } from "@/auth";
import { applyRememberMeCookiePolicy } from "@/lib/auth/session-cookie";

export async function GET(req: NextRequest) {
  return applyRememberMeCookiePolicy(await handlers.GET(req));
}

export async function POST(req: NextRequest) {
  return applyRememberMeCookiePolicy(await handlers.POST(req));
}
