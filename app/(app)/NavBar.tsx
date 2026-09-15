"use client";

import { usePathname } from "next/navigation";
import { PanelLeft } from "lucide-react";
import { hasSidebar, SIDEBAR_ID, useSidebar } from "./SidebarContext";
import UserMenu, { type MenuAccount } from "./UserMenu";

interface Props {
  /** The signed-in account, or `null` when signed out (the menu then offers Sign in). */
  account: MenuAccount | null;
}

/**
 * Persistent top bar. Deliberately minimal: the sidebar toggle (only on pages
 * that have a sidebar) and the avatar/account menu — nothing else. No
 * wordmark, page labels, shop name, email, or Etsy connection controls;
 * connection status and Disconnect live only on /settings.
 */
export default function NavBar({ account }: Props) {
  const pathname = usePathname();
  const { open, toggle } = useSidebar();

  return (
    <header className="sticky top-0 z-30 border-b border-surface-border bg-surface px-4 backdrop-blur-md sm:px-6">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between gap-2">
        <div>
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
        </div>
        <UserMenu account={account} />
      </div>
    </header>
  );
}
