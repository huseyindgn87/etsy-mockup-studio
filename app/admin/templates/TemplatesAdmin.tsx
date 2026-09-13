"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import MockupCanvas from "@/app/(app)/mockups/MockupCanvas";
import { blobToRaster } from "@/lib/mockup/client";
import { rotateQuad } from "@/lib/mockup/geometry";
import type { TemplateListItem } from "@/lib/mockup/template-types";
import { DEFAULT_QUAD, type Calibration, type Quad, type Raster } from "@/lib/mockup/types";

const cloneQuad = (q: Quad): Quad => q.map((p) => [...p]) as Quad;

/** Slider defaults — mirrors the standalone tool's `ensureCalib` (mockup-atolyesi.html). */
const SHADE_DEFAULT = 15;
const DISP_DEFAULT = 10;
const DISPR_DEFAULT = 12;

/** A calibration wrapping the current quad + the diagnostic sliders — this
 * screen only ever *saves* the quad (see `MockupTemplate`); shade/warp are
 * preview-only aids for judging whether the quad looks right under realistic
 * fabric shading and wrinkle warp, not persisted per template. `rot` is
 * always 0 here — the compositor never reads `Calibration.rot` (see the
 * report above); rotation is instead baked directly into the quad via
 * `rotateQuad` as the dial turns. */
function calibrationFor(quad: Quad, shade: number, disp: number, dispR: number): Calibration {
  return {
    qs: [quad],
    q: quad,
    ai: 0,
    shade,
    disp,
    dispR,
    zoom: 100,
    rot: 0,
    b1: 0,
    b2: 0,
    w1: 255,
    w2: 255,
  };
}

async function errorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error || `Request failed (${res.status})`;
}

interface Props {
  initialTemplates: TemplateListItem[];
}

/** One undoable snapshot — the corner quad plus the three sliders whose
 * effect on the quad/print area a user would want to step back through.
 * Rotation is folded into `quad` already (see `calibrationFor`), but its
 * dial position is tracked alongside so undo restores the slider display too. */
interface HistoryEntry {
  quad: Quad;
  shade: number;
  disp: number;
  dispR: number;
  rot: number;
}

/** A range input paired with a number input — type a value, Enter/blur
 * confirms and clamps it; dragging the slider (or focusing the number box)
 * fires `onDragStart` once, before the value changes, so the caller can
 * snapshot pre-edit state for undo. */
function SliderField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  onDragStart,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onDragStart: () => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    // Reconciling the draft text with the (possibly externally-changed, e.g.
    // undo) numeric value — an intentional synchronous reset.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(String(value));
  }, [value]);

  function commit() {
    const parsed = Number.parseFloat(draft);
    const clamped = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : value;
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  }

  return (
    <div>
      <div className="flex items-center justify-between text-sm text-zinc-600 dark:text-zinc-400">
        <span>{label}</span>
        <input
          type="number"
          min={min}
          max={max}
          value={draft}
          onFocus={onDragStart}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          onBlur={commit}
          className="h-7 w-16 rounded border border-black/10 bg-white px-1.5 text-right text-xs outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-900"
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onDragStart}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full accent-[#f56400]"
      />
    </div>
  );
}

export default function TemplatesAdmin({ initialTemplates }: Props) {
  const [templates, setTemplates] = useState<TemplateListItem[]>(initialTemplates);
  const [selectedFilename, setSelectedFilename] = useState<string | null>(
    initialTemplates[0]?.filename ?? null,
  );
  const selected = templates.find((t) => t.filename === selectedFilename) ?? null;

  // ---- edit state for the selected template ----
  const [name, setName] = useState("");
  const [productType, setProductType] = useState("");
  const [colour, setColour] = useState("");
  const [dpiHint, setDpiHint] = useState("300");
  const [quad, setQuad] = useState<Quad>(() => cloneQuad(DEFAULT_QUAD));
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  // ---- diagnostic sliders (preview-only — never saved; see calibrationFor) ----
  const [shade, setShade] = useState(SHADE_DEFAULT);
  const [disp, setDisp] = useState(DISP_DEFAULT);
  const [dispR, setDispR] = useState(DISPR_DEFAULT);
  const [rot, setRot] = useState(0);

  // Corner-drag behaviour is a screen-wide preference, not per-template —
  // stays put across template switches, matching the standalone tool.
  const [cornerMode, setCornerMode] = useState<"ratio" | "free">("ratio");

  // ---- test design, for the live preview only — never saved ----
  const [design, setDesign] = useState<Raster | null>(null);
  const designInputRef = useRef<HTMLInputElement>(null);

  // ---- the template image itself, decoded once per selection ----
  const [mockRaster, setMockRaster] = useState<Raster | null>(null);
  const [mockError, setMockError] = useState<string | null>(null);

  // ---- undo / redo: last 60 corner/slider edits, Ctrl+Z / Ctrl+Shift+Z ----
  // The stacks themselves live in refs (snap/undo/redo need to push/pop them
  // from a stable, once-created callback without going stale), mirrored into
  // plain length state so the Undo/Redo buttons' `disabled` can read them
  // during render (reading a ref's `.current` during render is not allowed).
  const pastRef = useRef<HistoryEntry[]>([]);
  const futureRef = useRef<HistoryEntry[]>([]);
  const [pastLen, setPastLen] = useState(0);
  const [futureLen, setFutureLen] = useState(0);

  // Mirrors the live quad/slider values into a ref every render so snap/undo/
  // redo — memoized once, referenced from a global keydown listener — always
  // read the current values instead of a stale closure.
  const liveRef = useRef({ quad, shade, disp, dispR, rot });
  useEffect(() => {
    liveRef.current = { quad, shade, disp, dispR, rot };
  });

  const applyEntry = useCallback((e: HistoryEntry) => {
    setQuad(cloneQuad(e.quad));
    setShade(e.shade);
    setDisp(e.disp);
    setDispR(e.dispR);
    setRot(e.rot);
  }, []);

  const snap = useCallback(() => {
    const { quad, shade, disp, dispR, rot } = liveRef.current;
    pastRef.current.push({ quad: cloneQuad(quad), shade, disp, dispR, rot });
    if (pastRef.current.length > 60) pastRef.current.shift();
    futureRef.current = [];
    setPastLen(pastRef.current.length);
    setFutureLen(0);
  }, []);

  const undo = useCallback(() => {
    const entry = pastRef.current.pop();
    if (!entry) return;
    const { quad, shade, disp, dispR, rot } = liveRef.current;
    futureRef.current.push({ quad: cloneQuad(quad), shade, disp, dispR, rot });
    applyEntry(entry);
    setPastLen(pastRef.current.length);
    setFutureLen(futureRef.current.length);
  }, [applyEntry]);

  const redo = useCallback(() => {
    const entry = futureRef.current.pop();
    if (!entry) return;
    const { quad, shade, disp, dispR, rot } = liveRef.current;
    pastRef.current.push({ quad: cloneQuad(quad), shade, disp, dispR, rot });
    applyEntry(entry);
    setPastLen(pastRef.current.length);
    setFutureLen(futureRef.current.length);
  }, [applyEntry]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isZ = e.key === "z" || e.key === "Z";
      if (!isZ || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo]);

  // Rotation slider: Shift snaps to 15° steps — tracked as a held modifier
  // (not the input's change event, which carries no reliable modifier state
  // for a range drag) exactly like the standalone tool's rotate-drag gesture.
  const shiftHeldRef = useRef(false);
  useEffect(() => {
    function down(e: KeyboardEvent) {
      if (e.key === "Shift") shiftHeldRef.current = true;
    }
    function up(e: KeyboardEvent) {
      if (e.key === "Shift") shiftHeldRef.current = false;
    }
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  /** Rotation only ever exists as quad geometry (see the module-doc report) —
   * turning the dial rotates the quad in-place by the delta since the dial's
   * last position, using the template's real pixel aspect ratio. */
  const applyRotation = useCallback(
    (raw: number) => {
      const v = shiftHeldRef.current ? Math.round(raw / 15) * 15 : raw;
      if (mockRaster) {
        setQuad((q) => rotateQuad(q, v - rot, mockRaster.width, mockRaster.height));
      }
      setRot(v);
    },
    [mockRaster, rot],
  );

  // Reset the edit fields from the selected template's last-saved (or
  // default) state whenever a *different* template is picked. Deliberately
  // not re-run when `templates` changes (e.g. right after a successful save)
  // — that would stomp the fields with what was just saved instead of
  // leaving them as-is.
  useEffect(() => {
    const t = templates.find((x) => x.filename === selectedFilename);
    if (!t) return;
    // Reconciling local edit state against the newly-selected list item, not
    // an external system — an intentional synchronous reset.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(t.name);
    setProductType(t.productType);
    setColour(t.colour);
    setDpiHint(String(t.dpiHint));
    setQuad(cloneQuad(t.quad));
    setShade(SHADE_DEFAULT);
    setDisp(DISP_DEFAULT);
    setDispR(DISPR_DEFAULT);
    setRot(0);
    setSaveStatus("idle");
    setSaveError(null);
    setDesign(null);
    pastRef.current = [];
    futureRef.current = [];
    setPastLen(0);
    setFutureLen(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFilename]);

  useEffect(() => {
    if (!selectedFilename) {
      // Clearing stale state synchronously for the "nothing selected" case.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMockRaster(null);
      return;
    }
    let cancelled = false;
    // Clearing the previous template's raster before the new fetch resolves.
    setMockRaster(null);
    setMockError(null);
    fetch(`/templates/${encodeURIComponent(selectedFilename)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Could not load the template image.");
        return res.blob();
      })
      .then((blob) => blobToRaster(blob, { maxSide: 1600 }))
      .then((raster) => {
        if (!cancelled) setMockRaster(raster);
      })
      .catch((err) => {
        if (!cancelled) setMockError(err instanceof Error ? err.message : "Could not load the template image.");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFilename]);

  const onDesignFile = useCallback(async (file: File | null) => {
    if (!file) {
      setDesign(null);
      return;
    }
    try {
      setDesign(await blobToRaster(file, { maxSide: 1600 }));
    } catch {
      setDesign(null);
    }
  }, []);

  const onAreaChange = useCallback((_area: number, nextQuad: Quad) => {
    setQuad(nextQuad);
  }, []);

  const handleSave = useCallback(async () => {
    if (!selected) return;
    setSaveStatus("saving");
    setSaveError(null);
    try {
      const res = await fetch(`/api/admin/templates/${encodeURIComponent(selected.filename)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          productType,
          colour,
          dpiHint: Number.parseInt(dpiHint, 10),
          quad,
        }),
      });
      if (!res.ok) throw new Error(await errorFrom(res));
      const body = (await res.json()) as { template: TemplateListItem };
      setTemplates((prev) => prev.map((t) => (t.filename === body.template.filename ? body.template : t)));
      setSaveStatus("saved");
    } catch (err) {
      setSaveStatus("error");
      setSaveError(err instanceof Error ? err.message : "Could not save template.");
    }
  }, [selected, name, productType, colour, dpiHint, quad]);

  const handleReset = useCallback(() => {
    if (!selected) return;
    snap();
    setName(selected.name);
    setProductType(selected.productType);
    setColour(selected.colour);
    setDpiHint(String(selected.dpiHint));
    setQuad(cloneQuad(selected.quad));
    setShade(SHADE_DEFAULT);
    setDisp(DISP_DEFAULT);
    setDispR(DISPR_DEFAULT);
    setRot(0);
    setSaveStatus("idle");
    setSaveError(null);
  }, [selected, snap]);

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
            Calibrate the print area for each template in public/templates/.
          </p>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-6 lg:flex-row">
        {/* ---- left: template list ---- */}
        <aside className="w-full flex-shrink-0 lg:w-72">
          {templates.length === 0 ? (
            <p className="rounded-lg border border-dashed border-black/20 p-4 text-sm text-zinc-500 dark:border-white/25 dark:text-zinc-400">
              No templates found. Add JPEG or PNG files to public/templates/ and reload this page.
            </p>
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
                    <img
                      src={`/templates/${t.filename}`}
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

        {/* ---- middle: canvas ---- */}
        {selected && (
          <div className="min-w-0 flex-[2] space-y-3">
            <div className="rounded-lg border border-black/10 bg-white p-4 dark:border-white/15 dark:bg-zinc-950">
              {mockError && <p className="mb-3 text-sm text-red-600">{mockError}</p>}
              {mockRaster ? (
                <MockupCanvas
                  key={selectedFilename}
                  mock={mockRaster}
                  overlays={[]}
                  design={design}
                  calibration={calibrationFor(quad, shade, disp, dispR)}
                  activeArea={0}
                  cornerMode={cornerMode}
                  onAreaChange={onAreaChange}
                  onDragStart={snap}
                  zoomable
                />
              ) : (
                !mockError && (
                  <div className="flex h-64 items-center justify-center text-sm text-zinc-500 dark:text-zinc-400">
                    Loading template…
                  </div>
                )
              )}
              <p className="mt-2 text-center text-xs text-zinc-500">
                Wheel to zoom, drag empty space to pan · Ctrl+Z / Ctrl+Shift+Z to undo/redo
              </p>

              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => designInputRef.current?.click()}
                  className="h-9 rounded-lg border border-dashed border-black/20 px-3 text-sm text-zinc-600 hover:bg-black/[.04] dark:border-white/25 dark:text-zinc-300 dark:hover:bg-white/[.06]"
                >
                  {design ? "Change test design" : "Upload a test design (PNG)"}
                </button>
                {design && (
                  <button
                    type="button"
                    onClick={() => setDesign(null)}
                    className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                  >
                    Clear
                  </button>
                )}
                <input
                  ref={designInputRef}
                  type="file"
                  accept="image/png,image/*"
                  className="hidden"
                  onChange={(e) => onDesignFile(e.target.files?.[0] ?? null)}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 rounded-lg border border-black/10 bg-white p-4 sm:grid-cols-2 dark:border-white/15 dark:bg-zinc-950">
              <label className="block text-sm">
                <span className="text-zinc-600 dark:text-zinc-400">Name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-900"
                />
              </label>
              <label className="block text-sm">
                <span className="text-zinc-600 dark:text-zinc-400">Product type</span>
                <input
                  value={productType}
                  onChange={(e) => setProductType(e.target.value)}
                  placeholder="e.g. T-shirt"
                  className="mt-1 h-9 w-full rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-900"
                />
              </label>
              <label className="block text-sm">
                <span className="text-zinc-600 dark:text-zinc-400">Colour</span>
                <input
                  value={colour}
                  onChange={(e) => setColour(e.target.value)}
                  placeholder="e.g. Heather grey"
                  className="mt-1 h-9 w-full rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-900"
                />
              </label>
              <label className="block text-sm">
                <span className="text-zinc-600 dark:text-zinc-400">Print-area DPI hint</span>
                <input
                  type="number"
                  min={72}
                  max={1200}
                  value={dpiHint}
                  onChange={(e) => setDpiHint(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-900"
                />
              </label>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleSave}
                disabled={!mockRaster || saveStatus === "saving"}
                className="h-9 rounded-full bg-[#f56400] px-4 text-sm font-medium text-white transition-colors hover:bg-[#d95700] disabled:opacity-40"
              >
                {saveStatus === "saving" ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="h-9 rounded-full border border-[#f56400] px-4 text-sm font-medium text-[#f56400] transition-colors hover:bg-[#f56400]/10"
              >
                Reset
              </button>
              {saveStatus === "saved" && <p className="text-xs font-medium text-[#f56400]">Saved ✓</p>}
              {saveStatus === "error" && <p className="text-xs text-red-600">{saveError}</p>}
            </div>
          </div>
        )}

        {/* ---- right: realism controls ---- */}
        {selected && (
          <div className="w-full flex-shrink-0 space-y-4 lg:w-64">
            <div className="rounded-lg border border-black/10 bg-white p-4 dark:border-white/15 dark:bg-zinc-950">
              <span className="mb-1.5 block text-sm text-zinc-600 dark:text-zinc-400">Corners</span>
              <div className="flex gap-1.5">
                {(
                  [
                    ["ratio", "Keep ratio"],
                    ["free", "Free corners"],
                  ] as const
                ).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setCornerMode(m)}
                    className={`h-8 flex-1 rounded-full text-xs font-medium transition-colors ${
                      cornerMode === m
                        ? "bg-black text-white dark:bg-white dark:text-black"
                        : "border border-black/10 text-zinc-600 dark:border-white/15 dark:text-zinc-400"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-zinc-500">
                {cornerMode === "ratio"
                  ? "Drag a corner to scale from the opposite corner. Hold Alt/Option to scale from the centre instead."
                  : "Each corner drags independently, for perspective."}
              </p>

              <div className="mt-2 flex gap-2 border-t border-black/10 pt-3 dark:border-white/15">
                <button
                  type="button"
                  onClick={undo}
                  disabled={pastLen === 0}
                  className="h-8 flex-1 rounded-full border border-black/10 text-xs font-medium text-zinc-600 transition-colors hover:bg-black/[.04] disabled:opacity-40 dark:border-white/15 dark:text-zinc-400 dark:hover:bg-white/[.06]"
                >
                  Undo
                </button>
                <button
                  type="button"
                  onClick={redo}
                  disabled={futureLen === 0}
                  className="h-8 flex-1 rounded-full border border-black/10 text-xs font-medium text-zinc-600 transition-colors hover:bg-black/[.04] disabled:opacity-40 dark:border-white/15 dark:text-zinc-400 dark:hover:bg-white/[.06]"
                >
                  Redo
                </button>
              </div>
            </div>

            <div className="space-y-4 rounded-lg border border-black/10 bg-white p-4 dark:border-white/15 dark:bg-zinc-950">
              <SliderField
                label="Fabric shadow"
                value={shade}
                min={0}
                max={130}
                onChange={setShade}
                onDragStart={snap}
              />
              <SliderField
                label="Warp strength"
                value={disp}
                min={0}
                max={40}
                onChange={setDisp}
                onDragStart={snap}
              />
              <SliderField
                label="Warp scale"
                value={dispR}
                min={2}
                max={48}
                onChange={setDispR}
                onDragStart={snap}
              />
              <SliderField
                label="Rotation °"
                value={rot}
                min={-180}
                max={180}
                step={0.5}
                onChange={applyRotation}
                onDragStart={snap}
              />
              <p className="text-xs text-zinc-500">
                Hold Shift while dragging Rotation to snap to 15° steps. These sliders are a
                realism check only — the print area (quad) is the only thing saved.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
