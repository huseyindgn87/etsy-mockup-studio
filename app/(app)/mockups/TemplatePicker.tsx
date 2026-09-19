"use client";

import { useEffect, useRef, useState } from "react";
import TemplateCalibrator, { type TemplateCalibratorValue } from "./TemplateCalibrator";
import type { TemplateListItem } from "@/lib/mockup/template-types";

async function errorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error || `Request failed (${res.status})`;
}

type Mode = { kind: "browse" } | { kind: "uploading" } | { kind: "calibrating"; template: TemplateListItem };

function valueOf(t: TemplateListItem): TemplateCalibratorValue {
  return { name: t.name, productType: t.productType, colour: t.colour, dpiHint: t.dpiHint, quad: t.quad };
}

function TemplateTile({
  template,
  onSelect,
  onCalibrate,
}: {
  template: TemplateListItem;
  onSelect: () => void;
  onCalibrate?: () => void;
}) {
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full flex-col items-center gap-1.5 rounded-lg border border-black/10 bg-white p-2 text-left transition-colors hover:border-[#f56400] dark:border-white/15 dark:bg-zinc-950"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={template.imageUrl}
          alt=""
          className="h-24 w-full rounded border border-black/10 bg-zinc-50 object-contain dark:border-white/15 dark:bg-zinc-900"
        />
        <span className="w-full truncate text-xs text-zinc-700 dark:text-zinc-300">{template.name}</span>
        {!template.calibrated && (
          <span className="rounded-full bg-zinc-200 px-1.5 py-0.5 text-[13px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            Not calibrated
          </span>
        )}
      </button>
      {onCalibrate && (
        <button
          type="button"
          onClick={onCalibrate}
          title="Calibrate print area"
          className="absolute right-1 top-1 hidden h-6 w-6 items-center justify-center rounded-full bg-black/60 text-xs text-white group-hover:flex"
        >
          ✎
        </button>
      )}
    </div>
  );
}

/**
 * The template picker shown from the mockup studio's "Add from template"
 * action: curated library templates first, then the user's own uploads, then
 * an "Upload template" button that opens the same calibration UI
 * `/admin/templates` uses (see `TemplateCalibrator`) for a freshly uploaded
 * image. Selecting any tile hands the template back to the caller, which adds
 * it to the studio exactly like a parsed PSD.
 */
export default function TemplatePicker({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (template: TemplateListItem) => void;
}) {
  const [library, setLibrary] = useState<TemplateListItem[]>([]);
  const [mine, setMine] = useState<TemplateListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "browse" });
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/mockups/templates");
        if (!res.ok) throw new Error(await errorFrom(res));
        const body = (await res.json()) as { library: TemplateListItem[]; mine: TemplateListItem[] };
        if (cancelled) return;
        setLibrary(body.library);
        setMine(body.mine);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Could not load templates.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onUploadFile(file: File | null) {
    if (!file) return;
    setUploadError(null);
    setMode({ kind: "uploading" });
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch("/api/mockups/templates", { method: "POST", body: fd });
      if (!res.ok) throw new Error(await errorFrom(res));
      const body = (await res.json()) as { template: TemplateListItem };
      setMode({ kind: "calibrating", template: body.template });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Could not upload the template.");
      setMode({ kind: "browse" });
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Choose a mockup template"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-xl dark:bg-zinc-950"
      >
        <div className="flex items-center justify-between border-b border-black/10 px-5 py-3 dark:border-white/15">
          <p className="text-sm font-semibold text-black dark:text-zinc-50">
            {mode.kind === "calibrating" ? "Calibrate template" : "Choose a template"}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            Close
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {mode.kind === "calibrating" ? (
            <TemplateCalibrator
              key={mode.template.id}
              imageUrl={mode.template.imageUrl}
              initial={valueOf(mode.template)}
              saveLabel="Save template"
              onSave={async (value) => {
                const res = await fetch(`/api/mockups/templates/${mode.template.id}`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(value),
                });
                if (!res.ok) throw new Error(await errorFrom(res));
                const body = (await res.json()) as { template: TemplateListItem };
                setMine((prev) => {
                  const exists = prev.some((t) => t.id === body.template.id);
                  return exists
                    ? prev.map((t) => (t.id === body.template.id ? body.template : t))
                    : [body.template, ...prev];
                });
                setMode({ kind: "browse" });
              }}
              extraActions={
                <button
                  type="button"
                  onClick={() => setMode({ kind: "browse" })}
                  className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  Cancel
                </button>
              }
            />
          ) : (
            <div className="space-y-6">
              {loading && <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading templates…</p>}
              {loadError && <p className="text-sm text-red-600">{loadError}</p>}
              {uploadError && <p className="text-sm text-red-600">{uploadError}</p>}

              {!loading && !loadError && (
                <>
                  <section>
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                      Library
                    </h4>
                    {library.length === 0 ? (
                      <p className="text-sm text-zinc-500 dark:text-zinc-400">No library templates yet.</p>
                    ) : (
                      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                        {library.map((t) => (
                          <TemplateTile key={t.filename} template={t} onSelect={() => onSelect(t)} />
                        ))}
                      </div>
                    )}
                  </section>

                  <section>
                    <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                      My templates
                    </h4>
                    <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                      {mine.map((t) => (
                        <TemplateTile
                          key={t.id}
                          template={t}
                          onSelect={() => onSelect(t)}
                          onCalibrate={() => setMode({ kind: "calibrating", template: t })}
                        />
                      ))}
                      <button
                        type="button"
                        onClick={() => fileInput.current?.click()}
                        disabled={mode.kind === "uploading"}
                        className="flex h-full min-h-[104px] flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-black/15 p-2 text-xs text-zinc-500 transition-colors hover:border-[#f56400] disabled:opacity-40 dark:border-white/20 dark:text-zinc-400"
                      >
                        <span className="text-lg leading-none">+</span>
                        <span>{mode.kind === "uploading" ? "Uploading…" : "Upload template"}</span>
                      </button>
                    </div>
                  </section>
                </>
              )}

              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={(e) => onUploadFile(e.target.files?.[0] ?? null)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
