import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdminUserId } from "@/lib/auth/admin";
import { getUserTemplateImage } from "@/lib/mockup/template-store";
import { templateImageResponse, wantsRaw } from "../../image-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/mockups/templates/[id]/image` — a user's own uploaded template,
 * read from R2, as a watermarked preview like every template (the raw file,
 * `?raw=1`, only for an admin). 404s for someone else's upload, a missing id,
 * or a library template id — no cross-user leakage of designs.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const raw = wantsRaw(request);
  if (raw && !isAdminUserId(session.user.id)) {
    return NextResponse.json({ error: "Template not found." }, { status: 404 });
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
  return templateImageResponse(obj, { raw });
}
