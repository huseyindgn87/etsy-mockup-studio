import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isRenderSetId, renderSetPrefix } from "@/lib/scheduling/render-keys";
import { isRenderSetInUse } from "@/lib/scheduling/store";
import { deletePrefix, isR2Configured } from "@/lib/storage/r2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `DELETE /api/schedule/renders/[setId]` — discards images uploaded for a
 * schedule that never got created (the editor calls it when scheduling
 * fails part-way). Refused once a schedule uses the set. Only ever touches
 * `scheduled/{userId}/{setId}/`.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ setId: string }> }) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { setId } = await params;
  if (!isRenderSetId(setId)) return NextResponse.json({ error: "Invalid render set." }, { status: 400 });
  if (await isRenderSetInUse(userId, setId)) {
    return NextResponse.json({ error: "These images belong to a scheduled listing." }, { status: 409 });
  }
  if (isR2Configured()) await deletePrefix(renderSetPrefix(userId, setId));
  return NextResponse.json({ ok: true });
}
