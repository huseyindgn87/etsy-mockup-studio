"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import MockupCanvas from "./MockupCanvas";
import { blobToRaster } from "@/lib/mockup/client";
import { rotateQuad } from "@/lib/mockup/geometry";
import type { Calibration, Quad, Raster } from "@/lib/mockup/types";

const cloneQuad = (q: Quad): Quad => q.map((p) => [...p]) as Quad;

/** Slider defaults — mirrors the standalone tool's `ensureCalib` (mockup-atolyesi.html). */
const SHADE_DEFAULT = 15;
const DISP_DEFAULT = 10;
const DISPR_DEFAULT = 12;

/** A calibration wrapping the current quad + the diagnostic sliders — this
 * screen only ever *saves* the quad (see `MockupTemplate`); shade/warp are
 * preview-only aids for judging whether the quad looks right under realistic
 * fabric shading and wrinkle warp, not persisted per template. `rot` is
 * always 0 here — the compositor never reads `Calibration.rot`; rotation is
 * instead baked directly into the quad via `rotateQuad` as the dial turns. */
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

export interface TemplateCalibratorValue {
  name: string;
  productType: string;
  colour: string;
  dpiHint: number;
  quad: Quad;
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

interface Props {
  /** Where to fetch the raw template image bytes from. */
  imageUrl: string;
  /** The template's current saved (or default) fields — this component is
   * mount-initialized from these; pass a `key` on the identity that changes
   * (filename/id) so switching templates remounts it fresh. */
  initial: TemplateCalibratorValue;
  /** Persists the calibration. Rejecting shows its message as a save error. */
  onSave: (value: TemplateCalibratorValue) => Promise<void>;
  /** Label for the primary action button. Defaults to "Save". */
  saveLabel?: string;
  /** Extra buttons/links rendered alongside Save/Reset (e.g. a "Cancel" for an upload flow). */
  extraActions?: React.ReactNode;
}

/**
 * The print-area calibration screen: canvas with draggable corners, a test
 * design overlay, realism sliders, and the template's name/product/colour/DPI
 * fields. Shared between the curated library's admin screen and a user's own
 * template upload — the two differ only in where the image comes from and
 * what `onSave` does with the result.
 */
export default function TemplateCalibrator({ imageUrl, initial, onSave, saveLabel, extraActions }: Props) {
  const [name, setName] = useState(initial.name);
  const [productType, setProductType] = useState(initial.productType);
  const [colour, setColour] = useState(initial.colour);
  const [dpiHint, setDpiHint] = useState(String(initial.dpiHint));
  const [quad, setQuad] = useState<Quad>(() => cloneQuad(initial.quad));
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  // ---- diagnostic sliders (preview-only — never saved; see calibrationFor) ----
  const [shade, setShade] = useState(SHADE_DEFAULT);
  const [disp, setDisp] = useState(DISP_DEFAULT);
  const [dispR, setDispR] = useState(DISPR_DEFAULT);
  const [rot, setRot] = useState(0);

  // Corner-drag behaviour is a screen-wide preference, not per-template.
  const [cornerMode, setCornerMode] = useState<"ratio" | "free">("ratio");

  // ---- test design, for the live preview only — never saved ----
  const [design, setDesign] = useState<Raster | null>(null);
  const designInputRef = useRef<HTMLInputElement>(null);

  // ---- the template image itself, decoded once ----
  const [mockRaster, setMockRaster] = useState<Raster | null>(null);
  const [mockError, setMockError] = useState<string | null>(null);

  // ---- undo / redo: last 60 corner/slider edits, Ctrl+Z / Ctrl+Shift+Z ----
  const pastRef = useRef<HistoryEntry[]>([]);
  const futureRef = useRef<HistoryEntry[]>([]);
  const [pastLen, setPastLen] = useState(0);
  const [futureLen, setFutureLen] = useState(0);

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

  /** Rotation only ever exists as quad geometry — turning the dial rotates the
   * quad in-place by the delta since the dial's last position, using the
   * template's real pixel aspect ratio. */
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

  useEffect(() => {
    let cancelled = false;
    // Clearing the previous image before the new fetch resolves — an
    // intentional synchronous reset, not syncing from an external system.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMockRaster(null);
    setMockError(null);
    fetch(imageUrl)
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
  }, [imageUrl]);

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
    setSaveStatus("saving");
    setSaveError(null);
    try {
      await onSave({
        name,
        productType,
        colour,
        dpiHint: Number.parseInt(dpiHint, 10),
        quad,
      });
      setSaveStatus("saved");
    } catch (err) {
      setSaveStatus("error");
      setSaveError(err instanceof Error ? err.message : "Could not save template.");
    }
  }, [onSave, name, productType, colour, dpiHint, quad]);

  const handleReset = useCallback(() => {
    snap();
    setName(initial.name);
    setProductType(initial.productType);
    setColour(initial.colour);
    setDpiHint(String(initial.dpiHint));
    setQuad(cloneQuad(initial.quad));
    setShade(SHADE_DEFAULT);
    setDisp(DISP_DEFAULT);
    setDispR(DISPR_DEFAULT);
    setRot(0);
    setSaveStatus("idle");
    setSaveError(null);
  }, [initial, snap]);

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      {/* ---- middle: canvas ---- */}
      <div className="min-w-0 flex-[2] space-y-3">
        <div className="rounded-lg border border-black/10 bg-white p-4 dark:border-white/15 dark:bg-zinc-950">
          {mockError && <p className="mb-3 text-sm text-red-600">{mockError}</p>}
          {mockRaster ? (
            <MockupCanvas
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
            {saveStatus === "saving" ? "Saving…" : (saveLabel ?? "Save")}
          </button>
          <button
            type="button"
            onClick={handleReset}
            className="h-9 rounded-full border border-[#f56400] px-4 text-sm font-medium text-[#f56400] transition-colors hover:bg-[#f56400]/10"
          >
            Reset
          </button>
          {extraActions}
          {saveStatus === "saved" && <p className="text-xs font-medium text-[#f56400]">Saved ✓</p>}
          {saveStatus === "error" && <p className="text-xs text-red-600">{saveError}</p>}
        </div>
      </div>

      {/* ---- right: realism controls ---- */}
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
          <SliderField label="Fabric shadow" value={shade} min={0} max={130} onChange={setShade} onDragStart={snap} />
          <SliderField label="Warp strength" value={disp} min={0} max={40} onChange={setDisp} onDragStart={snap} />
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
    </div>
  );
}
