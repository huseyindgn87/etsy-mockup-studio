import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { createUserTemplate, listTemplates, listUserTemplates } from "@/lib/mockup/template-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reject uploads above this before reading them into memory — mirrors `MAX_TEMPLATE_UPLOAD_BYTES`. */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * `GET /api/mockups/templates` — the template picker's data: every curated
 * library template (visible to everyone) plus the caller's own uploads.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const [library, mine] = await Promise.all([
      listTemplates(),
      listUserTemplates(session.user.id),
    ]);
    return NextResponse.json({ library, mine });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not load templates.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * `POST /api/mockups/templates` — upload a new user template, `multipart/form-data`
 * field `file`. Stored uncalibrated (`DEFAULT_QUAD`) — the caller opens the shared
 * calibration UI next and saves the real quad via `PUT /api/mockups/templates/[id]`.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let file: File;
  try {
    const field = (await request.formData()).get("file");
    if (!(field instanceof File)) {
      return NextResponse.json({ error: 'Missing "file" field.' }, { status: 400 });
    }
    file = field;
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data." }, { status: 400 });
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `File too large (max ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB).` },
      { status: 413 },
    );
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const template = await createUserTemplate(session.user.id, {
      bytes,
      originalFilename: file.name || "template",
      contentType: file.type || "application/octet-stream",
    });
    return NextResponse.json({ template });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not upload the template.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
