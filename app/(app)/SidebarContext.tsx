"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/** Routes whose page renders a collapsible left sidebar — the top bar shows its toggle only there. */
const SIDEBAR_ROUTES = ["/listings"] as const;

/** The `id` a page gives its sidebar element, so the toggle can point at it via `aria-controls`. */
export const SIDEBAR_ID = "app-sidebar";

/** Fired by the wordmark on the listings page itself: go back to its home view (Active, not My drafts). */
export const LISTINGS_HOME_EVENT = "listhouse:listings-home";

export function hasSidebar(pathname: string): boolean {
  return SIDEBAR_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

interface SidebarState {
  open: boolean;
  toggle: () => void;
}

const SidebarContext = createContext<SidebarState>({ open: true, toggle: () => {} });

/**
 * Open/collapsed state for the current page's left sidebar, shared between
 * the top bar's toggle (NavBar) and the page that owns the sidebar. Lives in
 * `(app)/layout.tsx`, so the choice survives client-side navigation.
 */
export function SidebarProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const value = useMemo(() => ({ open, toggle: () => setOpen((o) => !o) }), [open]);
  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarState {
  return useContext(SidebarContext);
}
