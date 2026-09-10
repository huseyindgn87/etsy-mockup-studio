"use client";

import { useEffect, useMemo, useRef } from "react";
import { rasterToCanvas } from "@/lib/mockup/client";
import { compose } from "@/lib/mockup/compose";
import { quadList } from "@/lib/mockup/geometry";
import type { Calibration, Overlay, Raster } from "@/lib/mockup/types";

const MAX_PREVIEW = 760;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

interface Props {
  mock: Raster;
  overlays: Overlay[];
  design: Raster | null;
  calibration: Calibration;
  activeArea: number;
  onCorner: (area: number, corner: number, pt: [number, number]) => void;
}

/**
 * Live preview of one mockup + design, composited in the browser with the same
 * `lib/mockup` core the server render uses. Four draggable handles edit the
 * active print area's corners.
 */
export default function MockupCanvas({
  mock,
  overlays,
  design,
  calibration,
  activeArea,
  onCorner,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<number | null>(null);
  const frameRef = useRef(0);

  const [pw, ph] = useMemo(() => {
    const s = Math.min(1, MAX_PREVIEW / Math.max(mock.width, mock.height));
    return [Math.max(1, Math.round(mock.width * s)), Math.max(1, Math.round(mock.height * s))];
  }, [mock.width, mock.height]);

  useEffect(() => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      const out = compose({ mock, design, perArea: null, calibration, overlays }, pw, ph);
      const canvas = canvasRef.current;
      if (canvas) rasterToCanvas(out, canvas);
    });
    return () => cancelAnimationFrame(frameRef.current);
  }, [mock, design, calibration, overlays, pw, ph]);

  const areas = quadList(calibration);
  const area = areas[Math.min(activeArea, areas.length - 1)] ?? areas[0];

  function onPointerMove(e: React.PointerEvent) {
    const corner = dragRef.current;
    const wrap = wrapRef.current;
    if (corner === null || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    onCorner(activeArea, corner, [
      clamp01((e.clientX - rect.left) / rect.width),
      clamp01((e.clientY - rect.top) / rect.height),
    ]);
  }

  return (
    <div
      ref={wrapRef}
      className="relative mx-auto w-full select-none overflow-hidden rounded-lg border border-black/10 bg-[repeating-conic-gradient(#e5e5e5_0_25%,#fff_0_50%)] bg-[length:20px_20px] dark:border-white/15"
      style={{ maxWidth: pw, aspectRatio: `${mock.width} / ${mock.height}` }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      <svg
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
      >
        <polygon
          points={area.map((p) => `${p[0]},${p[1]}`).join(" ")}
          fill="none"
          stroke="#f56400"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          strokeDasharray="5 4"
        />
      </svg>

      {area.map((p, i) => (
        <button
          key={i}
          type="button"
          aria-label={`Köşe ${i + 1}`}
          onPointerDown={(e) => {
            e.preventDefault();
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            dragRef.current = i;
          }}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => {
            dragRef.current = null;
            try {
              (e.target as HTMLElement).releasePointerCapture(e.pointerId);
            } catch {
              /* pointer already released */
            }
          }}
          className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none rounded-full border-2 border-white bg-[#f56400] shadow active:cursor-grabbing"
          style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%` }}
        />
      ))}
    </div>
  );
}
