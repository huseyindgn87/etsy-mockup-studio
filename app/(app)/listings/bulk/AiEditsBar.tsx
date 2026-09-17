"use client";

import {
  AI_MODELS,
  AI_PRESETS,
  MAX_AI_PROMPT_LENGTH,
  isUsableAiSettings,
  type AiModel,
  type AiPreset,
} from "@/lib/ai/listing-ai";
import { INPUT_CLS } from "./helpers";

export interface AiSettings {
  preset: AiPreset | "";
  model: AiModel;
  prompt: string;
}

/**
 * The AI Edits bar: a prompt preset, a model and a free-text prompt, and
 * Optimize, which asks Claude for a new value for every ticked row. The same
 * settings drive each row's own Regenerate button. A suggestion only fills the
 * row's control — nothing reaches Etsy until Sync updates.
 */
export default function AiEditsBar({
  fieldLabel,
  settings,
  onChange,
  onOptimize,
  running,
  targetedCount,
}: {
  fieldLabel: string;
  settings: AiSettings;
  onChange: (settings: AiSettings) => void;
  onOptimize: () => void;
  /** Rows still waiting on Claude. */
  running: number;
  targetedCount: number;
}) {
  const usable = isUsableAiSettings(settings);
  return (
    <section
      aria-label={`AI Edits — ${fieldLabel}`}
      className="mt-4 rounded-xl border border-dashed border-primary/30 bg-white p-4 dark:bg-zinc-950"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-primary">AI Edits</h2>
        <span className="text-xs text-zinc-500">
          {running > 0 ? `Optimizing ${running}…` : `${targetedCount} listing${targetedCount === 1 ? "" : "s"} ticked`}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="block text-xs text-zinc-500">Prompt</span>
          <select
            aria-label="Prompt preset"
            value={settings.preset}
            onChange={(e) => onChange({ ...settings, preset: e.target.value as AiPreset | "" })}
            className={`${INPUT_CLS} mt-1 h-9 w-52`}
          >
            <option value="">Choose a preset</option>
            {AI_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-xs text-zinc-500">Model</span>
          <select
            aria-label="Model"
            value={settings.model}
            onChange={(e) => onChange({ ...settings, model: e.target.value as AiModel })}
            className={`${INPUT_CLS} mt-1 h-9 w-44`}
          >
            {AI_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={onOptimize}
          disabled={!usable || targetedCount === 0 || running > 0}
          className="h-9 shrink-0 rounded-full bg-primary px-4 text-xs font-medium text-white transition-colors hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-40"
        >
          Optimize
        </button>
      </div>
      <label className="mt-2 block text-sm">
        <span className="block text-xs text-zinc-500">Instructions</span>
        <textarea
          aria-label="AI prompt"
          rows={2}
          maxLength={MAX_AI_PROMPT_LENGTH}
          value={settings.prompt}
          onChange={(e) => onChange({ ...settings, prompt: e.target.value })}
          placeholder={`Anything else Claude should know when rewriting the ${fieldLabel.toLowerCase()}…`}
          className={`${INPUT_CLS} mt-1 resize-y py-2`}
        />
      </label>
    </section>
  );
}
