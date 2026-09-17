import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { cleanAiResult, parseAiOptimizeRequest, type AiOptimizeRequest } from "@/lib/ai/listing-ai";
import { AiOptimizeError, optimizeListingField } from "@/lib/ai/listing-optimize";

const REQUEST: AiOptimizeRequest = {
  field: "title",
  model: "claude-opus-5",
  preset: "seo",
  prompt: "Mention it's a gift for dad",
  listing: { title: "Mug", description: "A ceramic mug.", tags: ["mug"] },
};

/** A stand-in client whose `beta.messages.parse` answers with `response`. */
function fakeClient(response: unknown) {
  const parse = vi.fn(async () => response);
  return { client: { beta: { messages: { parse } } } as unknown as Anthropic, parse };
}

describe("AI Edits request validation", () => {
  it("accepts a preset, a prompt, or both — and nothing else", () => {
    expect(parseAiOptimizeRequest(REQUEST)).toEqual({ ok: true, value: REQUEST });
    expect(parseAiOptimizeRequest({ ...REQUEST, preset: "", prompt: "  " })).toMatchObject({ ok: false });
    expect(parseAiOptimizeRequest({ ...REQUEST, preset: "", prompt: "Shorter" })).toMatchObject({ ok: true });
    expect(parseAiOptimizeRequest({ ...REQUEST, model: "gpt-4" })).toMatchObject({ ok: false, error: "Unknown model." });
    expect(parseAiOptimizeRequest({ ...REQUEST, field: "price" })).toMatchObject({ ok: false });
    expect(parseAiOptimizeRequest({ ...REQUEST, listing: { title: "Mug" } })).toMatchObject({ ok: false });
  });

  it("holds answers to Etsy's limits", () => {
    expect(cleanAiResult("title", ` ${"x".repeat(200)} `)).toHaveLength(140);
    const tags = cleanAiResult("tags", ["Coffee Mug", "coffee mug", " ", "a very long tag that keeps going", ...Array.from({ length: 20 }, (_, i) => `t${i}`)]);
    expect(tags).toHaveLength(13);
    expect((tags as string[]).slice(0, 2)).toEqual(["Coffee Mug", "a very long tag that"]);
  });
});

describe("optimizeListingField", () => {
  it("asks Claude for structured output with the listing, the preset and the prompt, and Opus 5's default fallbacks", async () => {
    const { client, parse } = fakeClient({ stop_reason: "end_turn", parsed_output: { title: "Dad's Coffee Mug" } });
    await expect(optimizeListingField(REQUEST, client)).resolves.toBe("Dad's Coffee Mug");

    const params = (parse.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(params).toMatchObject({
      model: "claude-opus-5",
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    expect((params.output_config as { format: { type: string } }).format.type).toBe("json_schema");
    const content = (params.messages as { content: string }[])[0].content;
    expect(content).toContain('"title": "Mug"');
    expect(content).toContain("Mention it's a gift for dad");
    expect(content).toContain("lead with the words a buyer would type");
  });

  it("sends no fallbacks for other models, and cleans tags", async () => {
    const { client, parse } = fakeClient({ stop_reason: "end_turn", parsed_output: { tags: ["Mug", "mug", "gift"] } });
    await expect(optimizeListingField({ ...REQUEST, field: "tags", model: "claude-haiku-4-5" }, client)).resolves.toEqual([
      "Mug",
      "gift",
    ]);
    const params = (parse.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(params).not.toHaveProperty("fallbacks");
    expect(params).not.toHaveProperty("betas");
  });

  it("reports a refusal and an incomplete answer instead of saving them", async () => {
    await expect(optimizeListingField(REQUEST, fakeClient({ stop_reason: "refusal", parsed_output: null }).client)).rejects.toMatchObject({
      status: 422,
    });
    await expect(optimizeListingField(REQUEST, fakeClient({ stop_reason: "max_tokens", parsed_output: null }).client)).rejects.toBeInstanceOf(
      AiOptimizeError,
    );
  });

  it("maps missing credentials and rate limits to messages the screen can show", async () => {
    const failing = (err: Error) =>
      ({ beta: { messages: { parse: vi.fn(async () => Promise.reject(err)) } } }) as unknown as Anthropic;
    await expect(
      optimizeListingField(REQUEST, failing(new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", new Headers()))),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      optimizeListingField(REQUEST, failing(new Anthropic.RateLimitError(429, undefined, "rate limited", new Headers()))),
    ).rejects.toMatchObject({ status: 429 });
  });
});
