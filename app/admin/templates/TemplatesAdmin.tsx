"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import TemplateCalibrator, { type TemplateCalibratorValue } from "@/app/(app)/mockups/TemplateCalibrator";
import type { TemplateListItem } from "@/lib/mockup/template-types";

async function errorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error || `Request failed (${res.status})`;
}

interface Props {
  initialTemplates: TemplateListItem[];
  /** Set when the server couldn't load the library (e.g. the DB is unreachable
   * or the Prisma client is stale) — shown instead of crashing the page. */
  loadError?: string | null;
}

export default function TemplatesAdmin({ initialTemplates, loadError }: Props) {
  const router = useRouter();
  const [templates, setTemplates] = useState<TemplateListItem[]>(initialTemplates);
  const [selectedFilename, setSelectedFilename] = useState<string | null>(
    initialTemplates[0]?.filename ?? null,
  );
  const selected = templates.find((t) => t.filename === selectedFilename) ?? null;

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <header className="sticky top-0 z-20 border-b border-black/10 bg-zinc-50/95 px-6 py-3 backdrop-blur dark:border-white/15 dark:bg-black/95">
        <div className="mx-auto w-full max-w-6xl">
          <Link
            href="/"
            className="text-xs text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            ← Back to home
          </Link>
          <p className="mt-1 text-sm font-semibold text-black dark:text-zinc-50">Mockup templates</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Calibrate the print area for each library template.
          </p>
        </div>
      </header>

      {loadError && (
        <div className="mx-auto mt-6 w-full max-w-6xl px-6">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
            <span>Couldn&apos;t load templates: {loadError}</span>
            <button
              type="button"
              onClick={() => router.refresh()}
              className="h-8 rounded-full border border-red-300 px-3 text-xs font-medium transition-colors hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900/40"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-6 lg:flex-row">
        {/* ---- left: template list ---- */}
        <aside className="w-full flex-shrink-0 lg:w-72">
          {templates.length === 0 ? (
            !loadError && (
              <p className="rounded-lg border border-dashed border-black/20 p-4 text-sm text-zinc-500 dark:border-white/25 dark:text-zinc-400">
                No templates found. Add JPEG or PNG files with npm run templates:import and reload this page.
              </p>
            )
          ) : (
            <ul className="space-y-1.5">
              {templates.map((t) => (
                <li key={t.filename}>
                  <button
                    type="button"
                    onClick={() => setSelectedFilename(t.filename)}
                    className={`flex w-full items-center gap-3 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                      t.filename === selectedFilename
                        ? "border-[#f56400] bg-[#f56400]/5"
                        : "border-black/10 hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={t.imageUrl}
                      alt=""
                      className="h-11 w-11 flex-shrink-0 rounded border border-black/10 bg-white object-contain dark:border-white/15"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-black dark:text-zinc-50">
                        {t.filename}
                      </span>
                      <span
                        className={`mt-0.5 inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                          t.calibrated
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                            : "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                        }`}
                      >
                        {t.calibrated ? "Calibrated" : "Not calibrated"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* ---- calibration screen for the selected template ---- */}
        {selected && (
          <div className="min-w-0 flex-1">
            <TemplateCalibrator
              key={selected.filename}
              imageUrl={`${selected.imageUrl}?raw=1`}
              initial={{
                name: selected.name,
                productType: selected.productType,
                colour: selected.colour,
                dpiHint: selected.dpiHint,
                quad: selected.quad,
              }}
              onSave={async (value: TemplateCalibratorValue) => {
                const res = await fetch(`/api/admin/templates/${encodeURIComponent(selected.filename)}`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(value),
                });
                if (!res.ok) throw new Error(await errorFrom(res));
                const body = (await res.json()) as { template: TemplateListItem };
                setTemplates((prev) =>
                  prev.map((t) => (t.filename === body.template.filename ? body.template : t)),
                );
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
