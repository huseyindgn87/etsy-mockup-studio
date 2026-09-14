"use client";

import { useEffect, useRef, useState } from "react";
import { signOut } from "next-auth/react";

interface Props {
  email: string;
}

/** Header account menu: the signed-in email behind a popover, with Sign out. */
export default function UserMenu({ email }: Props) {
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

  const initial = email.trim().charAt(0).toUpperCase() || "?";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="inline-flex h-7 items-center gap-1.5 rounded-full border border-surface-border bg-surface px-2 text-xs font-medium text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:px-2.5"
      >
        <span
          aria-hidden
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-white"
        >
          {initial}
        </span>
        <span className="hidden max-w-[12rem] truncate sm:inline">{email}</span>
        <span className="sr-only sm:hidden">Account menu for {email}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Account"
          className="absolute right-0 top-9 z-40 w-64 rounded-2xl border border-surface-border bg-surface p-3 text-xs text-text shadow-soft backdrop-blur-md"
        >
          <p className="truncate text-text-muted">{email}</p>
          <button
            type="button"
            onClick={() => signOut({ redirect: true, callbackUrl: "/login" })}
            className="mt-2 h-8 w-full rounded-full border border-surface-border text-xs font-medium text-text transition-colors hover:bg-white/40"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
