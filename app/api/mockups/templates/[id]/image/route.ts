import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getUserTemplateImage } from "@/lib/mockup/template-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/mockups/templates/[id]/image` — streams a user's own uploaded
 * template image back from R2. Library templates never hit this route; they're
 * served statically from `/templates/...`. 404s for someone else's upload, a
 * missing id, or a library template id — no cross-user leakage of designs.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { id } = await params;

  let obj;
  try {
    obj = await getUserTemplateImage(session.user.id, id);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not load the template image.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
  if (!obj) {
    return NextResponse.json({ error: "Template not found." }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(obj.body), { headers: { "Content-Type": obj.contentType } });
}
