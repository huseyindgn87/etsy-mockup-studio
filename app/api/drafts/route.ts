import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { createDraft, listDrafts, sweepExpiredDrafts } from "@/lib/drafts/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/drafts` — the signed-in user's saved drafts, for the listings
 * page's "My drafts" filter. Opportunistically sweeps expired drafts first
 * (see lib/drafts/store.ts) so cleanup happens without needing an external
 * cron wired up; a sweep failure never blocks the list itself.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  await sweepExpiredDrafts().catch(() => {
    /* best-effort — a stuck sweep shouldn't block the list */
  });
  const drafts = await listDrafts(session.user.id);
  return NextResponse.json({ drafts });
}

/** `POST /api/drafts` — starts a new empty draft. Returns `{ id }`. */
export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { id } = await createDraft(session.user.id);
  return NextResponse.json({ id });
}
