import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { saveUserTemplateCalibration } from "@/lib/mockup/template-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  name?: unknown;
  productType?: unknown;
  colour?: unknown;
  dpiHint?: unknown;
  quad?: unknown;
}

/**
 * `PUT /api/mockups/templates/[id]` — save a user's own uploaded template's
 * name/product type/colour/DPI hint/print-area quad. Same calibration shape as
 * `PUT /api/admin/templates/[filename]`, but scoped to the caller's own
 * uploads — a 404 if `id` doesn't exist or belongs to someone else (or is a
 * library template, which is only ever edited at /admin/templates).
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const { id } = await params;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  try {
    const template = await saveUserTemplateCalibration(session.user.id, id, {
      name: typeof body.name === "string" ? body.name : "",
      productType: typeof body.productType === "string" ? body.productType : "",
      colour: typeof body.colour === "string" ? body.colour : "",
      dpiHint: typeof body.dpiHint === "number" ? body.dpiHint : 300,
      quad: body.quad,
    });
    return NextResponse.json({ template });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save template.";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
