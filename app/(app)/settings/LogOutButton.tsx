"use client";

import { signOut } from "next-auth/react";

/** Single-click sign-out of the app account — no confirmation step. */
export default function LogOutButton() {
  return (
    <button
      type="button"
      onClick={() => signOut({ redirect: true, callbackUrl: "/login" })}
      className="inline-flex h-9 shrink-0 items-center rounded-full border border-black/10 px-4 text-sm font-medium text-text transition-colors hover:bg-black/[.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent dark:border-white/15 dark:hover:bg-white/[.06]"
    >
      Log out
    </button>
  );
}
