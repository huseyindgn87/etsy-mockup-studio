import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { isAdminUserId } from "@/lib/auth/admin";
import { getLibraryTemplateImage } from "@/lib/mockup/template-store";
import { templateImageResponse, wantsRaw } from "../../../image-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /api/mockups/templates/library/[filename]/image` — a curated template
 * as a watermarked preview. The unwatermarked file (`?raw=1`) is for admins
 * only; anyone else asking for it gets a 404.
 */
export async function GET(request: Request, { params }: { params: Promise<{ filename: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const raw = wantsRaw(request);
  if (raw && !isAdminUserId(session.user.id)) {
    return NextResponse.json({ error: "Template not found." }, { status: 404 });
  }
  const { filename } = await params;
  const obj = await getLibraryTemplateImage(decodeURIComponent(filename));
  if (!obj) {
    return NextResponse.json({ error: "Template not found." }, { status: 404 });
  }
  return templateImageResponse(obj, { raw });
}
