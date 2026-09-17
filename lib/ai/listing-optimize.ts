/**
 * AI Edits: one call to Claude that rewrites a listing's title, description
 * or tags. Server-only — it holds the Anthropic credentials.
 */

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import { MAX_TAGS, MAX_TAG_LENGTH, MAX_TITLE_LENGTH } from "@/lib/etsy/bulk-edit";
import { AI_PRESETS, cleanAiResult, type AiField, type AiOptimizeRequest } from "./listing-ai";

export class AiOptimizeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const SCHEMAS = {
  title: z.object({ title: z.string() }),
  description: z.object({ description: z.string() }),
  tags: z.object({ tags: z.array(z.string()) }),
};

const FIELD_RULES: Record<AiField, string> = {
  title: `Write a new title of at most ${MAX_TITLE_LENGTH} characters. No emoji, no all-caps words, no repeated phrases.`,
  description:
    "Write a new description as plain text with blank lines between paragraphs — no HTML or Markdown. Keep every material fact (sizes, materials, care, shipping or personalization details) the current description gives, and don't invent new ones.",
  tags: `Write up to ${MAX_TAGS} tags, each at most ${MAX_TAG_LENGTH} characters, using only letters, numbers and spaces. Each tag should be a phrase a shopper would search for; no duplicates.`,
};

const SYSTEM =
  "You rewrite Etsy listing text for the shop that owns the listing. Stay truthful to the listing as given, and follow Etsy's rules for the field you are asked to write.";

/** Claude Opus 5 re-runs a declined request on Anthropic's recommended fallback. */
const FALLBACK_MODELS = new Set<string>(["claude-opus-5"]);

function userMessage(req: AiOptimizeRequest): string {
  const preset = AI_PRESETS.find((p) => p.key === req.preset);
  const instructions = [preset?.instruction, req.prompt.trim()].filter(Boolean).join("\n\n");
  return [
    `<listing>\n${JSON.stringify(req.listing, null, 2)}\n</listing>`,
    `Rewrite the listing's ${req.field}.`,
    FIELD_RULES[req.field],
    `<instructions>\n${instructions}\n</instructions>`,
  ].join("\n\n");
}

/** Rewrites one field of one listing. Throws {@link AiOptimizeError} with an HTTP status for the route. */
export async function optimizeListingField(
  req: AiOptimizeRequest,
  client: Anthropic = new Anthropic(),
): Promise<string | string[]> {
  let response;
  try {
    response = await client.beta.messages.parse({
      model: req.model,
      max_tokens: 16000,
      ...(FALLBACK_MODELS.has(req.model)
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
        : {}),
      system: SYSTEM,
      messages: [{ role: "user", content: userMessage(req) }],
      output_config: { format: betaZodOutputFormat(SCHEMAS[req.field]) },
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new AiOptimizeError("AI Edits isn't set up: the server's Anthropic API key is missing or invalid.", 503);
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new AiOptimizeError("Claude is rate limited right now — try again in a moment.", 429);
    }
    if (err instanceof Anthropic.APIError) {
      throw new AiOptimizeError(`Claude couldn't answer (${err.status ?? "network"}): ${err.message}`, 502);
    }
    if (err instanceof Anthropic.AnthropicError) {
      throw new AiOptimizeError(`AI Edits isn't set up: ${err.message}`, 503);
    }
    throw err;
  }

  if (response.stop_reason === "refusal") {
    throw new AiOptimizeError("Claude declined to rewrite this listing.", 422);
  }
  if (response.stop_reason === "max_tokens" || !response.parsed_output) {
    throw new AiOptimizeError("Claude's answer was incomplete — try again.", 502);
  }
  const output = response.parsed_output as Record<AiField, string | string[]>;
  return cleanAiResult(req.field, output[req.field]);
}
