"use client";

import { useEffect, useMemo, useRef } from "react";
import { rasterToCanvas } from "@/lib/mockup/client";
import { compose } from "@/lib/mockup/compose";
import {
  moveCornerFree,
  quadList,
  scaleQuadFromCorner,
  translateQuad,
} from "@/lib/mockup/geometry";
import type { Calibration, Overlay, Pt, Quad, Raster } from "@/lib/mockup/types";

const MAX_PREVIEW = 760;
const cloneQuad = (q: Quad): Quad => q.map((p) => [...p]) as Quad;

type Drag =
  | { kind: "corner"; corner: number; startQuad: Quad }
  | { kind: "move"; startQuad: Quad; startPt: Pt };

interface Props {
  mock: Raster;
  overlays: Overlay[];
  design: Raster | null;
  calibration: Calibration;
  activeArea: number;
  /** "free" = independent corners (perspective); "ratio" = uniform scale from the opposite corner. */
  cornerMode: "free" | "ratio";
  onAreaChange: (area: number, quad: Quad) => void;
}

/**
 * Live preview of one mockup + design, composited in the browser with the same
 * `lib/mockup` core the server render uses. Drag a corner handle to reshape the
 * active print area (mode-dependent), or drag inside it to move the whole area.
 */
export default function MockupCanvas({
  mock,
  overlays,
  design,
  calibration,
  activeArea,
  cornerMode,
  onAreaChange,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
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

  function pointerToNorm(e: React.PointerEvent): Pt {
    const rect = wrapRef.current!.getBoundingClientRect();
    return [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height];
  }

  function onDragMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const pt = pointerToNorm(e);
    if (d.kind === "corner") {
      const quad =
        cornerMode === "ratio"
          ? scaleQuadFromCorner(d.startQuad, d.corner, pt)
          : moveCornerFree(d.startQuad, d.corner, pt);
      onAreaChange(activeArea, quad);
    } else {
      onAreaChange(
        activeArea,
        translateQuad(d.startQuad, pt[0] - d.startPt[0], pt[1] - d.startPt[1]),
      );
    }
  }

  function endDrag(e: React.PointerEvent) {
    dragRef.current = null;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }

  return (
    <div
      ref={wrapRef}
      onPointerMove={onDragMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className="relative mx-auto w-full select-none overflow-hidden rounded-lg border border-black/10 bg-[repeating-conic-gradient(#e5e5e5_0_25%,#fff_0_50%)] bg-[length:20px_20px] dark:border-white/15"
      style={{ maxWidth: pw, aspectRatio: `${mock.width} / ${mock.height}` }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      <svg
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
      >
        <polygon
          points={area.map((p) => `${p[0]},${p[1]}`).join(" ")}
          fill="#f56400"
          fillOpacity={0.08}
          stroke="#f56400"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          strokeDasharray="5 4"
          className="pointer-events-auto cursor-move touch-none"
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            dragRef.current = { kind: "move", startQuad: cloneQuad(area), startPt: pointerToNorm(e) };
          }}
        />
      </svg>

      {area.map((p, i) => (
        <button
          key={i}
          type="button"
          aria-label={`Corner ${i + 1}`}
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            dragRef.current = { kind: "corner", corner: i, startQuad: cloneQuad(area) };
          }}
          className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none rounded-full border-2 border-white bg-[#f56400] shadow active:cursor-grabbing"
          style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%` }}
        />
      ))}
    </div>
  );
}
