"use client";

import Link from "next/link";
import { UserRound } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { signOut } from "next-auth/react";

export interface MenuAccount {
  email: string;
  firstName: string | null;
}

const ITEM_CLASS =
  "flex h-9 w-full items-center rounded-lg px-3 text-left text-sm text-text transition-colors hover:bg-black/[.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent dark:hover:bg-white/[.08]";

/**
 * The top bar's avatar button and its popover: Account settings + Sign out
 * when signed in, Sign in when not. Shows only an initial on the avatar — no
 * email or other identifiers in the bar itself.
 */
export default function UserMenu({ account }: { account: MenuAccount | null }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

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

  const initial = (account?.firstName?.trim() || account?.email.trim() || "").charAt(0).toUpperCase();

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-white transition-colors hover:bg-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
      >
        {initial ? <span aria-hidden>{initial}</span> : <UserRound aria-hidden className="h-4 w-4" />}
      </button>

      {open && (
        <div
          id={menuId}
          className="absolute right-0 top-10 z-40 w-48 rounded-2xl border border-surface-border bg-surface p-1.5 shadow-soft backdrop-blur-md"
        >
          <ul className="flex flex-col gap-0.5">
            {account ? (
              <>
                <li>
                  <Link href="/settings" onClick={() => setOpen(false)} className={ITEM_CLASS}>
                    Account settings
                  </Link>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => signOut({ redirect: true, callbackUrl: "/login" })}
                    className={ITEM_CLASS}
                  >
                    Sign out
                  </button>
                </li>
              </>
            ) : (
              <li>
                <Link href="/login" onClick={() => setOpen(false)} className={ITEM_CLASS}>
                  Sign in
                </Link>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
