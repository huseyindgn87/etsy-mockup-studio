"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import ConnectedPill from "./ConnectedPill";
import UserMenu from "./UserMenu";

const NAV_LINKS = [{ href: "/listings", label: "Listings" }] as const;
const LOBBY_ROUTE = "/";

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
        active ? "text-text" : "text-text-muted hover:text-text"
      }`}
    >
      {label}
    </Link>
  );
}

interface Props {
  /** The signed-in app account's email — always present (proxy.ts guarantees
   * a session before this layout renders). */
  email: string;
  /** The connected shop's display name, or `null` if it couldn't be read
   * (an Etsy API hiccup) — the nav still renders, just without it. */
  shopName: string | null;
  /** Present whenever Etsy is connected — used for the Connected status pill. */
  etsySession: { userId: string; expiresAt: number } | null;
}

/** Persistent top navigation — shown on every page (the app account is
 * required to reach any of them; see `proxy.ts` and `(app)/layout.tsx`). */
export default function NavBar({ email, shopName, etsySession }: Props) {
  const pathname = usePathname();
  const isLobby = pathname === LOBBY_ROUTE;

  return (
    <header className="sticky top-0 z-30 border-b border-surface-border bg-surface px-4 backdrop-blur-md sm:px-6">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-2 sm:gap-4">
        <div className="flex min-w-0 items-center gap-4 sm:gap-6">
          {isLobby ? (
            <span className="shrink-0 select-none text-sm font-semibold text-text">
              Etsy Mockup Studio
            </span>
          ) : (
            <Link
              href={LOBBY_ROUTE}
              aria-label="Back to shop selection"
              className="inline-flex shrink-0 items-center gap-1 rounded-md text-sm font-semibold text-text transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
            >
              <ChevronLeft aria-hidden className="h-4 w-4 shrink-0" />
              <span className="truncate">Etsy Mockup Studio</span>
            </Link>
          )}

          {!isLobby && (
            <nav className="flex shrink-0 items-center gap-4 sm:gap-6">
              {NAV_LINKS.map((l) => (
                <NavLink key={l.href} href={l.href} label={l.label} />
              ))}
            </nav>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5 sm:gap-3">
          {!isLobby && shopName && (
            <span className="hidden max-w-[10rem] truncate text-sm text-text-muted md:inline">
              {shopName}
            </span>
          )}
          <UserMenu email={email} />
          {etsySession && (
            <ConnectedPill userId={etsySession.userId} expiresAt={etsySession.expiresAt} />
          )}
          {etsySession && (
            <form action="/api/auth/etsy/logout" method="post">
              <button
                type="submit"
                className="h-8 shrink-0 rounded-full border border-surface-border px-2 text-xs font-medium text-text transition-colors hover:bg-white/40 sm:px-3"
              >
                Disconnect
              </button>
            </form>
          )}
        </div>
      </div>
    </header>
  );
}
