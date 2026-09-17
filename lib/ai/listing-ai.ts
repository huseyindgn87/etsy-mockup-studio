/**
 * What the bulk editor's AI Edits bar offers and what `POST /api/ai/optimize`
 * accepts: the fields it rewrites, the models and prompt presets to choose
 * from, and validation of one request. Dependency-free so the screen and the
 * route share one definition.
 */

import { MAX_TITLE_LENGTH, normalizeTags } from "@/lib/etsy/bulk-edit";

export const AI_FIELDS = ["title", "description", "tags"] as const;
export type AiField = (typeof AI_FIELDS)[number];

export const AI_MODELS = [
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
] as const;
export type AiModel = (typeof AI_MODELS)[number]["id"];
export const DEFAULT_AI_MODEL: AiModel = "claude-opus-5";

export const AI_PRESETS = [
  {
    key: "seo",
    label: "Optimize for Etsy search",
    instruction:
      "Rewrite it so shoppers searching Etsy find it: lead with the words a buyer would type, keep it accurate to the listing, and avoid keyword stuffing.",
  },
  {
    key: "clarity",
    label: "Make it clearer",
    instruction: "Rewrite it to be clear and easy to scan, keeping every fact the listing states.",
  },
  {
    key: "shorten",
    label: "Shorten",
    instruction: "Make it noticeably shorter while keeping the most important information.",
  },
  {
    key: "gift",
    label: "Gift-focused",
    instruction: "Rewrite it to appeal to someone buying this as a gift, without inventing occasions the listing doesn't support.",
  },
] as const;
export type AiPreset = (typeof AI_PRESETS)[number]["key"];

/** The most free-text a user can add to a request. */
export const MAX_AI_PROMPT_LENGTH = 2000;

export interface AiListingInput {
  title: string;
  description: string;
  tags: string[];
}

export interface AiOptimizeRequest {
  field: AiField;
  model: AiModel;
  /** Empty when only the free-text prompt is used. */
  preset: AiPreset | "";
  prompt: string;
  listing: AiListingInput;
}

/** The bar's settings are usable once a preset is chosen or a prompt typed. */
export function isUsableAiSettings(settings: { preset: string; prompt: string }): boolean {
  return settings.preset !== "" || settings.prompt.trim() !== "";
}

const isString = (v: unknown): v is string => typeof v === "string";

export function parseAiOptimizeRequest(raw: unknown): { ok: true; value: AiOptimizeRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "Send a JSON body." };
  const r = raw as Record<string, unknown>;
  if (!AI_FIELDS.includes(r.field as AiField)) return { ok: false, error: "Choose title, description or tags." };
  if (!AI_MODELS.some((m) => m.id === r.model)) return { ok: false, error: "Unknown model." };
  const preset = r.preset ?? "";
  if (preset !== "" && !AI_PRESETS.some((p) => p.key === preset)) return { ok: false, error: "Unknown preset." };
  const prompt = isString(r.prompt) ? r.prompt : "";
  if (prompt.length > MAX_AI_PROMPT_LENGTH) {
    return { ok: false, error: `The prompt is longer than ${MAX_AI_PROMPT_LENGTH} characters.` };
  }
  if (!isUsableAiSettings({ preset: preset as string, prompt })) {
    return { ok: false, error: "Choose a preset or write a prompt." };
  }
  const l = (r.listing ?? {}) as Record<string, unknown>;
  if (!isString(l.title) || !isString(l.description) || !Array.isArray(l.tags) || !l.tags.every(isString)) {
    return { ok: false, error: "The listing's title, description and tags are required." };
  }
  return {
    ok: true,
    value: {
      field: r.field as AiField,
      model: r.model as AiModel,
      preset: preset as AiPreset | "",
      prompt,
      listing: { title: l.title, description: l.description, tags: l.tags },
    },
  };
}

/** The model's answer, held to Etsy's limits for the field. */
export function cleanAiResult(field: AiField, value: string | string[]): string | string[] {
  if (field === "tags") return normalizeTags(Array.isArray(value) ? value : [value]);
  const text = (Array.isArray(value) ? value.join(" ") : value).trim();
  return field === "title" ? text.slice(0, MAX_TITLE_LENGTH).trim() : text;
}
