"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const cloneQuad = (q: Quad): Quad => q.map((p) => [...p]) as Quad;

type Drag =
  | { kind: "corner"; corner: number; startQuad: Quad; anchorMode: "opposite" | "center" }
  | { kind: "move"; startQuad: Quad; startPt: Pt };

type PanDrag = { startClientX: number; startClientY: number; startPan: { x: number; y: number } };

interface Props {
  mock: Raster;
  overlays: Overlay[];
  design: Raster | null;
  calibration: Calibration;
  activeArea: number;
  /** "free" = independent corners (perspective); "ratio" = uniform scale from the opposite corner. */
  cornerMode: "free" | "ratio";
  onAreaChange: (area: number, quad: Quad) => void;
  /** Fired once, right when a corner/move-area drag begins (before the first
   * `onAreaChange`) — lets a caller snapshot pre-drag state for undo. */
  onDragStart?: () => void;
  /** Opt-in fixed-size viewport with wheel-zoom (100–800%) and drag-to-pan on
   * empty space, re-rendering the compositor at the zoomed resolution instead
   * of upscaling a fixed bitmap. Off by default — callers that don't pass this
   * keep the plain fixed-max-width preview. */
  zoomable?: boolean;
}

/**
 * Live preview of one mockup + design, composited in the browser with the same
 * `lib/mockup` core the server render uses. Drag a corner handle to reshape the
 * active print area (mode-dependent — "ratio" pivots on the opposite corner,
 * or the centroid with Alt/Option held), or drag inside it to move the whole
 * area.
 */
export default function MockupCanvas({
  mock,
  overlays,
  design,
  calibration,
  activeArea,
  cornerMode,
  onAreaChange,
  onDragStart,
  zoomable = false,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const panDragRef = useRef<PanDrag | null>(null);
  const frameRef = useRef(0);

  // ---- zoom/pan viewport (only meaningful when `zoomable`) ----
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    if (!zoomable) return;
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setViewportSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [zoomable]);

  const [pw, ph] = useMemo(() => {
    if (zoomable) {
      if (!viewportSize.w || !viewportSize.h) return [1, 1];
      const fit = Math.min(viewportSize.w / mock.width, viewportSize.h / mock.height);
      return [
        Math.max(1, Math.round(mock.width * fit * zoom)),
        Math.max(1, Math.round(mock.height * fit * zoom)),
      ];
    }
    const s = Math.min(1, MAX_PREVIEW / Math.max(mock.width, mock.height));
    return [Math.max(1, Math.round(mock.width * s)), Math.max(1, Math.round(mock.height * s))];
  }, [zoomable, viewportSize.w, viewportSize.h, mock.width, mock.height, zoom]);

  function clampPan(p: { x: number; y: number }, w: number, h: number, cw: number, ch: number) {
    let x = p.x;
    let y = p.y;
    if (w <= cw) x = (cw - w) / 2;
    else x = Math.min(0, Math.max(cw - w, x));
    if (h <= ch) y = (ch - h) / 2;
    else y = Math.min(0, Math.max(ch - h, y));
    return { x, y };
  }

  useEffect(() => {
    if (!zoomable) return;
    // Re-clamping pan against the newly-sized content/viewport, not a sync
    // with an external system — an intentional synchronous adjustment.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPan((prev) => clampPan(prev, pw, ph, viewportSize.w, viewportSize.h));
  }, [zoomable, pw, ph, viewportSize.w, viewportSize.h]);

  function setZoomAt(target: number, cx: number, cy: number) {
    const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, target));
    if (nz === zoom) return;
    const r = nz / zoom;
    setPan((prev) => clampPan(
      { x: cx - (cx - prev.x) * r, y: cy - (cy - prev.y) * r },
      Math.round(pw * r),
      Math.round(ph * r),
      viewportSize.w,
      viewportSize.h,
    ));
    setZoom(nz);
  }

  function onWheel(e: React.WheelEvent) {
    if (!zoomable) return;
    e.preventDefault();
    const rect = viewportRef.current!.getBoundingClientRect();
    setZoomAt(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX - rect.left, e.clientY - rect.top);
  }

  function onViewportPointerDown(e: React.PointerEvent) {
    if (!zoomable) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    panDragRef.current = { startClientX: e.clientX, startClientY: e.clientY, startPan: pan };
  }
  function onViewportPointerMove(e: React.PointerEvent) {
    const pd = panDragRef.current;
    if (!pd) return;
    const next = {
      x: pd.startPan.x + (e.clientX - pd.startClientX),
      y: pd.startPan.y + (e.clientY - pd.startClientY),
    };
    setPan(clampPan(next, pw, ph, viewportSize.w, viewportSize.h));
  }
  function endPan(e: React.PointerEvent) {
    panDragRef.current = null;
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }

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
          ? scaleQuadFromCorner(d.startQuad, d.corner, pt, d.anchorMode)
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

  const image = (
    <div
      ref={wrapRef}
      onPointerMove={onDragMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={
        zoomable
          ? "absolute select-none"
          : "relative mx-auto w-full select-none overflow-hidden rounded-lg border border-black/10 bg-[repeating-conic-gradient(#e5e5e5_0_25%,#fff_0_50%)] bg-[length:20px_20px] dark:border-white/15"
      }
      style={
        zoomable
          ? { left: pan.x, top: pan.y, width: pw, height: ph }
          : { maxWidth: pw, aspectRatio: `${mock.width} / ${mock.height}` }
      }
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
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            onDragStart?.();
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
            onDragStart?.();
            dragRef.current = {
              kind: "corner",
              corner: i,
              startQuad: cloneQuad(area),
              anchorMode: cornerMode === "ratio" && e.altKey ? "center" : "opposite",
            };
          }}
          className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none rounded-full border-2 border-white bg-[#f56400] shadow active:cursor-grabbing"
          style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%` }}
        />
      ))}
    </div>
  );

  if (!zoomable) return image;

  return (
    <div
      ref={viewportRef}
      onWheel={onWheel}
      onPointerDown={onViewportPointerDown}
      onPointerMove={onViewportPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      className="relative h-[min(70vh,720px)] min-h-[380px] w-full touch-none select-none overflow-hidden rounded-lg border border-black/10 bg-[repeating-conic-gradient(#e5e5e5_0_25%,#fff_0_50%)] bg-[length:20px_20px] dark:border-white/15"
    >
      {image}

      <div className="absolute left-2 top-2 z-10 flex items-center gap-1 rounded-full bg-black/60 px-1.5 py-1 text-xs text-white">
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setZoomAt(zoom / 1.4, viewportSize.w / 2, viewportSize.h / 2)}
          className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-white/20"
        >
          −
        </button>
        <span className="w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setZoomAt(zoom * 1.4, viewportSize.w / 2, viewportSize.h / 2)}
          className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-white/20"
        >
          +
        </button>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            setZoom(1);
            setPan({ x: 0, y: 0 });
          }}
          className="rounded-full px-1.5 hover:bg-white/20"
        >
          Fit
        </button>
      </div>
    </div>
  );
}
