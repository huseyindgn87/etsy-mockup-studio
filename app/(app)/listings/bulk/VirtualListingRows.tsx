"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/** Extra height rendered above and below the viewport, so fast scrolling doesn't show gaps. */
const OVERSCAN_PX = 1200;

/**
 * The bulk editor's listing rows, window-scrolled and virtualized: only rows
 * in (or near) the viewport are mounted, with spacers standing in for the
 * rest. Row heights vary by field, so each mounted row reports its measured
 * height and the estimate is only used for rows never seen.
 */
export default function VirtualListingRows<T>({
  items,
  getKey,
  estimate,
  renderRow,
}: {
  items: readonly T[];
  getKey: (item: T) => number;
  /** Assumed height of a row that hasn't been measured yet, in px. */
  estimate: number;
  renderRow: (item: T) => ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState<ReadonlyMap<number, number>>(() => new Map());
  const [viewport, setViewport] = useState(() => ({
    top: 0,
    height: typeof window === "undefined" ? 800 : window.innerHeight,
  }));

  useEffect(() => {
    const update = () => {
      const el = containerRef.current;
      if (!el) return;
      setViewport({ top: Math.max(0, -el.getBoundingClientRect().top), height: window.innerHeight });
    };
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  const onHeight = useCallback((key: number, height: number) => {
    setHeights((prev) => (prev.get(key) === height ? prev : new Map(prev).set(key, height)));
  }, []);

  const heightOf = (item: T) => heights.get(getKey(item)) ?? estimate;
  let start = 0;
  let offset = 0;
  while (start < items.length && offset + heightOf(items[start]) < viewport.top - OVERSCAN_PX) {
    offset += heightOf(items[start]);
    start++;
  }
  const before = offset;
  let end = start;
  while (end < items.length && offset <= viewport.top + viewport.height + OVERSCAN_PX) {
    offset += heightOf(items[end]);
    end++;
  }
  let after = 0;
  for (let i = end; i < items.length; i++) after += heightOf(items[i]);

  return (
    <div ref={containerRef}>
      <div style={{ height: before }} aria-hidden="true" />
      {items.slice(start, end).map((item) => {
        const key = getKey(item);
        return (
          <MeasuredRow key={key} rowKey={key} onHeight={onHeight}>
            {renderRow(item)}
          </MeasuredRow>
        );
      })}
      <div style={{ height: after }} aria-hidden="true" />
    </div>
  );
}

function MeasuredRow({
  rowKey,
  onHeight,
  children,
}: {
  rowKey: number;
  onHeight: (key: number, height: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (el.offsetHeight > 0) onHeight(rowKey, el.offsetHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [rowKey, onHeight]);
  return (
    <div ref={ref} data-row-key={rowKey} className="pb-3">
      {children}
    </div>
  );
}
