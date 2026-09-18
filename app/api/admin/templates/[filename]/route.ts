import { NextResponse } from "next/server";
import { isCurrentUserAdmin } from "@/lib/auth/admin";
import { saveTemplate } from "@/lib/mockup/template-store";

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
 * `PUT /api/admin/templates/[filename]` — upsert a curated template's name,
 * product type, colour, DPI hint, and print-area quad, keyed by its library filename. No Etsy session required: this is the
 * maintainer's own template library, not per-shop data.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ filename: string }> }) {
  if (!(await isCurrentUserAdmin())) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const { filename } = await params;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  try {
    const template = await saveTemplate(decodeURIComponent(filename), {
      name: typeof body.name === "string" ? body.name : "",
      productType: typeof body.productType === "string" ? body.productType : "",
      colour: typeof body.colour === "string" ? body.colour : "",
      dpiHint: typeof body.dpiHint === "number" ? body.dpiHint : 300,
      quad: body.quad,
    });
    return NextResponse.json({ template });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save template.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
