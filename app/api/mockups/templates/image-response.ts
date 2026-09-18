import { NextResponse } from "next/server";
import { templatePreview } from "@/lib/mockup/template-preview";
import { TEMPLATE_HEIGHT_HEADER, TEMPLATE_WIDTH_HEADER } from "@/lib/mockup/template-types";

/**
 * A template image as the caller may see it: the raw file only for an admin
 * who asks for it (`?raw=1`), a watermarked preview for everyone else.
 */
export async function templateImageResponse(
  obj: { body: Buffer; contentType: string },
  opts: { raw: boolean },
): Promise<Response> {
  if (opts.raw) {
    return new NextResponse(new Uint8Array(obj.body), {
      headers: { "Content-Type": obj.contentType, "Cache-Control": "private, no-store" },
    });
  }
  let preview;
  try {
    preview = await templatePreview(obj.body);
  } catch {
    return NextResponse.json({ error: "The template image couldn't be read." }, { status: 500 });
  }
  return new NextResponse(new Uint8Array(preview.body), {
    headers: {
      "Content-Type": preview.contentType,
      "Cache-Control": "private, max-age=300",
      "Content-Disposition": "inline",
      [TEMPLATE_WIDTH_HEADER]: String(preview.width),
      [TEMPLATE_HEIGHT_HEADER]: String(preview.height),
    },
  });
}

export function wantsRaw(request: Request): boolean {
  return new URL(request.url).searchParams.get("raw") === "1";
}
