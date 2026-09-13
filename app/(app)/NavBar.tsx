"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const NAV_LINKS = [
  { href: "/listings", label: "Listings" },
  { href: "/mockups", label: "Mockups" },
] as const;

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({ href, label }: { href: string; label: string }): ReactNode {
  const pathname = usePathname();
  const active = isActive(pathname, href);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`text-sm font-medium transition-colors ${
        active
          ? "text-black dark:text-zinc-50"
          : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
      }`}
    >
      {label}
    </Link>
  );
}

interface Props {
  /** The connected shop's display name, or `null` if it couldn't be read
   * (an Etsy API hiccup) — the nav still renders, just without it. */
  shopName: string | null;
}

/** Persistent top navigation — shown on every page except the sign-in
 * screen (see `(app)/layout.tsx`, which only mounts this when connected). */
export default function NavBar({ shopName }: Props) {
  return (
    <header className="sticky top-0 z-30 border-b border-black/10 bg-zinc-50/95 px-6 backdrop-blur dark:border-white/15 dark:bg-black/95">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4">
        <Link href="/" className="shrink-0 text-sm font-semibold text-black dark:text-zinc-50">
          Etsy Mockup Studio
        </Link>

        <nav className="flex items-center gap-6">
          {NAV_LINKS.map((l) => (
            <NavLink key={l.href} href={l.href} label={l.label} />
          ))}
        </nav>

        <div className="flex min-w-0 items-center gap-3">
          {shopName && (
            <span className="hidden truncate text-sm text-zinc-600 dark:text-zinc-400 sm:inline">
              {shopName}
            </span>
          )}
          <form action="/api/auth/etsy/logout" method="post">
            <button
              type="submit"
              className="h-8 shrink-0 rounded-full border border-black/10 px-3 text-xs font-medium transition-colors hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
            >
              Disconnect
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
