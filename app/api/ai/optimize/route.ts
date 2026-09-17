import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { parseAiOptimizeRequest } from "@/lib/ai/listing-ai";
import { AiOptimizeError, optimizeListingField } from "@/lib/ai/listing-optimize";

export const dynamic = "force-dynamic";

/**
 * `POST /api/ai/optimize` — AI Edits for one listing's title, description or
 * tags. Returns the suggested value; nothing is saved or sent to Etsy.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const parsed = parseAiOptimizeRequest(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const value = await optimizeListingField(parsed.value);
    return NextResponse.json({ value });
  } catch (err) {
    if (err instanceof AiOptimizeError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error("[ai] optimize failed", err);
    return NextResponse.json({ error: "AI Edits failed." }, { status: 500 });
  }
}
