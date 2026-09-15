"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeft } from "lucide-react";
import { APP_NAME } from "@/lib/brand";
import { hasSidebar, SIDEBAR_ID, useSidebar } from "./SidebarContext";
import UserMenu, { type MenuAccount } from "./UserMenu";

const WORDMARK = APP_NAME.toUpperCase();
/** The app home — the listings page, which always shows the currently selected shop. */
const HOME_ROUTE = "/listings";
const WORDMARK_CLASS = "rounded-md px-1 text-sm font-semibold tracking-[0.2em] text-text";

interface Props {
  /** The signed-in account, or `null` when signed out (the menu then offers Sign in). */
  account: MenuAccount | null;
}

/**
 * Persistent top bar. Deliberately minimal: the sidebar toggle (only on pages
 * that have a sidebar), the LISTHOUSE wordmark, and the avatar/account menu —
 * nothing else. No page labels, shop name, email, or Etsy connection
 * controls; connection status and Disconnect live only on /settings.
 *
 * The wordmark links home (/listings, the current shop's listings) from every
 * other page — including the shop picker at / — and is inert text (not a
 * link, not focusable) only while on /listings itself.
 */
export default function NavBar({ account }: Props) {
  const pathname = usePathname();
  const { open, toggle } = useSidebar();

  return (
    <header className="sticky top-0 z-30 border-b border-surface-border bg-surface px-4 backdrop-blur-md sm:px-6">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          {hasSidebar(pathname) && (
            <button
              type="button"
              onClick={toggle}
              aria-label="Toggle sidebar"
              aria-expanded={open}
              aria-controls={SIDEBAR_ID}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-black/[.05] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent dark:hover:bg-white/[.08]"
            >
              <PanelLeft aria-hidden className="h-5 w-5" />
            </button>
          )}
          {pathname === HOME_ROUTE ? (
            <span className={`select-none ${WORDMARK_CLASS}`}>{WORDMARK}</span>
          ) : (
            <Link
              href={HOME_ROUTE}
              className={`${WORDMARK_CLASS} transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2`}
            >
              {WORDMARK}
            </Link>
          )}
        </div>
        <UserMenu account={account} />
      </div>
    </header>
  );
}
