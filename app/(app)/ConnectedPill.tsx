"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  userId: string;
  expiresAt: number;
}

/**
 * Header status indicator: a teal dot + "Connected". The raw Etsy user id
 * and token expiry live behind this popover instead of on the entry card —
 * a seller should never see them by default.
 */
export default function ConnectedPill({ userId, expiresAt }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="inline-flex h-7 items-center gap-1.5 rounded-full border border-surface-border bg-surface px-2 text-xs font-medium text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:px-2.5"
      >
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
        <span className="hidden sm:inline">Connected</span>
        <span className="sr-only sm:hidden">Connected</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Connection details"
          className="absolute right-0 top-9 z-40 w-64 rounded-2xl border border-surface-border bg-surface p-3 text-xs text-text shadow-soft backdrop-blur-md"
        >
          <dl className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-text-muted">Etsy user id</dt>
              <dd className="font-mono">{userId}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-text-muted">Token expires</dt>
              <dd className="font-mono">{new Date(expiresAt).toLocaleTimeString()}</dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}
