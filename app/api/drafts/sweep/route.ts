import { NextResponse } from "next/server";
import { sweepExpiredDrafts } from "@/lib/drafts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `POST /api/drafts/sweep` — deletes every draft untouched for
 * `DRAFT_TTL_DAYS` (lib/drafts/constants.ts) and its R2 files. `GET /api/drafts`
 * already does this opportunistically, so no cron is required for the feature
 * to work — this route exists for anyone who wants a scheduled sweep anyway
 * (Vercel Cron, cron-job.org, ...) independent of listings-page traffic.
 *
 * Guarded by `DRAFT_SWEEP_SECRET` when set (`Authorization: Bearer <secret>`);
 * open when unset, since a sweep only ever removes rows already past their TTL.
 */
export async function POST(request: Request) {
  const secret = process.env.DRAFT_SWEEP_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
  }
  const deleted = await sweepExpiredDrafts();
  return NextResponse.json({ deleted });
}
