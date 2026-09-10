"use client";

import Link from "next/link";
import { useCallback, useMemo, useRef, useState } from "react";
import { blobToRaster, dataUrlToBlob } from "@/lib/mockup/client";
import { quadList } from "@/lib/mockup/geometry";
import type { Calibration, Overlay, Quad, Raster } from "@/lib/mockup/types";
import { normalizeBlendMode } from "@/lib/mockup/validate";
import MockupCanvas from "./MockupCanvas";

/** Longest edge of the browser-side preview rasters (the server renders full-res). */
const PREVIEW_MAX = 1400;

interface OverlayMeta {
  file: File;
  raster: Raster; // decoded at the mockup's previewScale
  x: number; // PSD-native px
  y: number;
  blend: string;
  alpha: number;
  clip: boolean;
  name: string;
}

interface MockupItem {
  id: string;
  name: string;
  file: File; // composite PNG, native res, for the batch upload
  psdW: number;
  psdH: number;
  previewScale: number;
  mockRaster: Raster; // scaled by previewScale
  overlays: OverlayMeta[];
  areaNames: string[];
  calibration: Calibration;
  include: boolean;
  tone: string | null;
}

interface DesignItem {
  id: string;
  name: string;
  file: File;
  raster: Raster;
  url: string;
}

const SLIDERS = [
  { key: "shade", label: "Kumaş gölgesi", min: 0, max: 130 },
  { key: "disp", label: "Kırışıklık", min: 0, max: 40 },
  { key: "dispR", label: "Kırışıklık yumuşatma", min: 2, max: 48 },
  { key: "zoom", label: "Baskı boyutu", min: 40, max: 120 },
  { key: "rot", label: "Döndürme", min: -180, max: 180 },
] as const;
type SliderKey = (typeof SLIDERS)[number]["key"];

const uid = () => Math.random().toString(36).slice(2, 10);
const stripExt = (s: string) => s.replace(/\.[^.]+$/, "");

async function errorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (res.status === 401) return "Etsy bağlantısı yok — ana sayfadan tekrar bağlan.";
  return body?.error || `İstek başarısız (${res.status})`;
}

export default function MockupsPage() {
  const [mockups, setMockups] = useState<MockupItem[]>([]);
  const [designs, setDesigns] = useState<DesignItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeArea, setActiveArea] = useState(0);
  const [previewDesignId, setPreviewDesignId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const psdInput = useRef<HTMLInputElement>(null);
  const designInput = useRef<HTMLInputElement>(null);

  const active = mockups.find((m) => m.id === activeId) ?? null;
  const previewDesign =
    designs.find((d) => d.id === previewDesignId) ?? designs[0] ?? null;

  const previewOverlays = useMemo<Overlay[]>(() => {
    if (!active) return [];
    const k = active.previewScale;
    return active.overlays.map((o) => ({
      data: o.raster.data,
      x: Math.round(o.x * k),
      y: Math.round(o.y * k),
      w: o.raster.width,
      h: o.raster.height,
      blend: normalizeBlendMode(o.blend),
      alpha: o.alpha,
      clip: o.clip,
      name: o.name,
    }));
  }, [active]);

  const addPsds = useCallback(async (files: File[]) => {
    const psds = files.filter((f) => /\.psd$/i.test(f.name));
    if (!psds.length) return;
    setError(null);
    const added: MockupItem[] = [];
    for (let i = 0; i < psds.length; i++) {
      setBusy(`PSD okunuyor (${i + 1}/${psds.length})`);
      const file = psds[i];
      try {
        const fd = new FormData();
        fd.set("psd", file);
        const res = await fetch("/api/mockups/psd", { method: "POST", body: fd });
        if (!res.ok) throw new Error(await errorFrom(res));
        const body = (await res.json()) as {
          psd: { width: number; height: number };
          composite: string;
          areaNames: string[];
          overlays: {
            image: string;
            x: number;
            y: number;
            blend: string;
            alpha: number;
            clip: boolean;
            name: string;
          }[];
          tone: { tone: string | null };
          suggestedCalibration: Calibration;
        };

        const scale = Math.min(
          1,
          PREVIEW_MAX / Math.max(body.psd.width, body.psd.height),
        );
        const compositeBlob = dataUrlToBlob(body.composite);
        const compositeFile = new File(
          [compositeBlob],
          `${stripExt(file.name)}.png`,
          { type: "image/png" },
        );
        const mockRaster = await blobToRaster(compositeBlob, { scale });
        const overlays: OverlayMeta[] = await Promise.all(
          body.overlays.map(async (ov) => {
            const blob = dataUrlToBlob(ov.image);
            return {
              file: new File([blob], `${ov.name || "overlay"}.png`, {
                type: "image/png",
              }),
              raster: await blobToRaster(blob, { scale }),
              x: ov.x,
              y: ov.y,
              blend: ov.blend,
              alpha: ov.alpha,
              clip: ov.clip,
              name: ov.name,
            };
          }),
        );

        added.push({
          id: uid(),
          name: stripExt(file.name),
          file: compositeFile,
          psdW: body.psd.width,
          psdH: body.psd.height,
          previewScale: scale,
          mockRaster,
          overlays,
          areaNames: body.areaNames ?? [],
          calibration: body.suggestedCalibration,
          include: true,
          tone: body.tone?.tone ?? null,
        });
      } catch (err) {
        setError(`${file.name}: ${err instanceof Error ? err.message : "okunamadı"}`);
      }
    }
    if (added.length) {
      setMockups((prev) => [...prev, ...added]);
      setActiveId((cur) => cur ?? added[0].id);
    }
    setBusy(null);
  }, []);

  const addDesigns = useCallback(async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    const added: DesignItem[] = [];
    for (let i = 0; i < imgs.length; i++) {
      setBusy(`Tasarım okunuyor (${i + 1}/${imgs.length})`);
      const file = imgs[i];
      try {
        added.push({
          id: uid(),
          name: stripExt(file.name),
          file,
          raster: await blobToRaster(file, { maxSide: 1600 }),
          url: URL.createObjectURL(file),
        });
      } catch {
        setError(`${file.name}: görsel okunamadı`);
      }
    }
    if (added.length) {
      setDesigns((prev) => [...prev, ...added]);
      setPreviewDesignId((cur) => cur ?? added[0].id);
    }
    setBusy(null);
  }, []);

  const patchCalibration = useCallback(
    (id: string, fn: (c: Calibration) => Calibration) => {
      setMockups((prev) =>
        prev.map((m) => (m.id === id ? { ...m, calibration: fn(m.calibration) } : m)),
      );
    },
    [],
  );

  const onCorner = useCallback(
    (area: number, corner: number, pt: [number, number]) => {
      if (!activeId) return;
      patchCalibration(activeId, (c) => {
        const qs = quadList(c).map((q) => q.map((p) => [...p]) as Quad);
        qs[area][corner] = pt;
        return { ...c, qs, q: qs[0] };
      });
    },
    [activeId, patchCalibration],
  );

  const onSlider = useCallback(
    (key: SliderKey, value: number) => {
      if (!activeId) return;
      patchCalibration(activeId, (c) => ({ ...c, [key]: value }));
    },
    [activeId, patchCalibration],
  );

  const included = useMemo(() => mockups.filter((m) => m.include), [mockups]);
  const jobCount = included.length * designs.length;

  const runBatch = useCallback(async () => {
    if (!included.length || !designs.length) return;
    setError(null);
    try {
      const fd = new FormData();
      const overlayBase: number[] = [];
      let flat = 0;
      for (const m of included) {
        overlayBase.push(flat);
        for (const ov of m.overlays) {
          fd.append("overlay", ov.file);
          flat++;
        }
      }
      for (const m of included) fd.append("mockup", m.file);
      for (const d of designs) fd.append("design", d.file);

      const payload = {
        format: "jpeg" as const,
        targetMB: [1.2, 1.7] as [number, number],
        namePattern: "{design}_{mockup}",
        mockups: included.map((m, i) => ({
          name: m.name,
          width: m.psdW,
          height: m.psdH,
          calibration: m.calibration,
          overlays: m.overlays.map((o, j) => ({
            file: overlayBase[i] + j,
            x: o.x,
            y: o.y,
            blend: o.blend,
            alpha: o.alpha,
            clip: o.clip,
            name: o.name,
          })),
        })),
        designs: designs.map((d) => ({ name: d.name })),
        jobs: included.flatMap((_, i) =>
          designs.map((__, k) => ({ mockup: i, design: k })),
        ),
      };
      fd.set("payload", JSON.stringify(payload));

      setBusy(`${jobCount} görsel render ediliyor…`);
      const res = await fetch("/api/mockups/render", { method: "POST", body: fd });
      if (!res.ok) throw new Error(await errorFrom(res));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mockups.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Render başarısız.");
    } finally {
      setBusy(null);
    }
  }, [included, designs, jobCount]);

  const areaCount = active ? quadList(active.calibration).length : 0;
  const areaIndex = Math.min(activeArea, Math.max(0, areaCount - 1));

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-10 font-sans dark:bg-black">
      <div className="mx-auto w-full max-w-6xl">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link
              href="/"
              className="text-sm text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
            >
              ← Geri
            </Link>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
              Mockup atölyesi
            </h1>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              PSD şablonları ve tasarımları yükle, köşeleri ve kaydırıcıları
              ayarla, toplu üret.
            </p>
          </div>
          <button
            type="button"
            onClick={runBatch}
            disabled={!!busy || jobCount === 0}
            className="h-10 rounded-full bg-[#f56400] px-5 text-sm font-medium text-white transition-colors hover:bg-[#d95700] disabled:opacity-40"
          >
            {busy ?? `Toplu üret (${jobCount})`}
          </button>
        </header>

        {error && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
            {error}
          </div>
        )}

        <div className="mt-6 grid gap-6 lg:grid-cols-[260px_1fr_260px]">
          {/* ---- left: lists ---- */}
          <div className="space-y-6">
            <Dropzone
              label="Mockup PSD'leri"
              accept=".psd"
              inputRef={psdInput}
              onFiles={addPsds}
            />
            {mockups.length > 0 && (
              <ul className="space-y-1">
                {mockups.map((m) => (
                  <li key={m.id}>
                    <div
                      className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm ${
                        m.id === activeId
                          ? "border-[#f56400] bg-[#f56400]/5"
                          : "border-black/10 hover:bg-black/[.03] dark:border-white/15 dark:hover:bg-white/[.05]"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={m.include}
                        onChange={(e) =>
                          setMockups((prev) =>
                            prev.map((x) =>
                              x.id === m.id
                                ? { ...x, include: e.target.checked }
                                : x,
                            ),
                          )
                        }
                        className="accent-[#f56400]"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setActiveId(m.id);
                          setActiveArea(0);
                        }}
                        className="flex-1 truncate text-left"
                      >
                        {m.name}
                      </button>
                      {m.tone && <ToneBadge tone={m.tone} />}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <Dropzone
              label="Tasarımlar"
              accept="image/*"
              inputRef={designInput}
              onFiles={addDesigns}
            />
            {designs.length > 0 && (
              <ul className="grid grid-cols-3 gap-2">
                {designs.map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => setPreviewDesignId(d.id)}
                      title={d.name}
                      className={`block aspect-square w-full overflow-hidden rounded-lg border ${
                        d.id === previewDesign?.id
                          ? "border-[#f56400] ring-2 ring-[#f56400]/40"
                          : "border-black/10 dark:border-white/15"
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={d.url}
                        alt={d.name}
                        className="h-full w-full object-contain"
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ---- center: editor ---- */}
          <div>
            {active ? (
              <>
                {areaCount > 1 && (
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {Array.from({ length: areaCount }).map((_, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setActiveArea(i)}
                        className={`h-7 rounded-full px-2.5 text-xs font-medium ${
                          i === areaIndex
                            ? "bg-black text-white dark:bg-white dark:text-black"
                            : "border border-black/10 dark:border-white/15"
                        }`}
                      >
                        {active.areaNames[i] || `Alan ${i + 1}`}
                      </button>
                    ))}
                  </div>
                )}
                <MockupCanvas
                  key={active.id}
                  mock={active.mockRaster}
                  overlays={previewOverlays}
                  design={previewDesign?.raster ?? null}
                  calibration={active.calibration}
                  activeArea={areaIndex}
                  onCorner={onCorner}
                />
                <p className="mt-2 text-center text-xs text-zinc-500">
                  {active.psdW}×{active.psdH}px · turuncu köşeleri sürükle
                </p>
              </>
            ) : (
              <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-black/15 text-sm text-zinc-500 dark:border-white/20">
                Bir PSD yükle ve listeden seç.
              </div>
            )}
          </div>

          {/* ---- right: controls ---- */}
          <div className="space-y-4">
            {active ? (
              SLIDERS.map((s) => {
                const value = Number(active.calibration[s.key] ?? s.min);
                return (
                  <label key={s.key} className="block text-sm">
                    <span className="flex justify-between text-zinc-600 dark:text-zinc-400">
                      <span>{s.label}</span>
                      <span className="font-mono">{Math.round(value)}</span>
                    </span>
                    <input
                      type="range"
                      min={s.min}
                      max={s.max}
                      value={value}
                      onChange={(e) => onSlider(s.key, Number(e.target.value))}
                      className="mt-1 w-full accent-[#f56400]"
                    />
                  </label>
                );
              })
            ) : (
              <p className="text-sm text-zinc-500">Ayarlar için bir mockup seç.</p>
            )}
          </div>
        </div>

        <p className="mt-8 text-sm text-zinc-500 dark:text-zinc-400">
          {mockups.length} şablon ({included.length} işaretli) × {designs.length}{" "}
          tasarım = <span className="font-medium">{jobCount}</span> görsel.
          Önizleme tarayıcıda, toplu üretim sunucuda — aynı çekirdek.
        </p>
      </div>
    </div>
  );
}

function Dropzone({
  label,
  accept,
  inputRef,
  onFiles,
}: {
  label: string;
  accept: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onFiles: (files: File[]) => void;
}) {
  const [hot, setHot] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setHot(true);
        }}
        onDragLeave={() => setHot(false)}
        onDrop={(e) => {
          e.preventDefault();
          setHot(false);
          onFiles([...e.dataTransfer.files]);
        }}
        className={`flex w-full flex-col items-center gap-1 rounded-xl border-2 border-dashed px-4 py-6 text-sm transition-colors ${
          hot
            ? "border-[#f56400] bg-[#f56400]/5"
            : "border-black/15 text-zinc-500 hover:border-black/30 dark:border-white/20 dark:hover:border-white/40"
        }`}
      >
        <span className="font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
        <span>tıkla ya da sürükle</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        hidden
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function ToneBadge({ tone }: { tone: string }) {
  const dark = tone === "dark";
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
        dark ? "bg-zinc-800 text-zinc-100" : "bg-zinc-200 text-zinc-700"
      }`}
    >
      {dark ? "KOYU" : "AÇIK"}
    </span>
  );
}
