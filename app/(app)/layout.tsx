import Link from "next/link";
import type { ReactNode } from "react";
import { getCurrentUser } from "@/lib/account/current-user";
import SiteFooter from "@/app/components/SiteFooter";
import { ToastProvider } from "@/app/components/toast/ToastProvider";
import NavBar from "./NavBar";
import { SidebarProvider } from "./SidebarContext";

/**
 * Shared chrome (top nav + footer) for every real app page. `/login` and
 * `/register` live outside this route group (no chrome), as does
 * `/admin/templates` (a maintainer-only screen — see its own back link).
 *
 * The app account (not the Etsy connection) is what gates access here —
 * `proxy.ts` redirects an unauthenticated request to `/login` before this
 * layout ever renders, so `user` below is expected to always be set; the
 * null check is just defense in depth, matching Next's own guidance not to
 * rely on Proxy alone.
 *
 * No Etsy lookups here: the top bar carries no shop name or connection
 * status any more (those live only on /settings).
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  // From the DB, not the session JWT — the JWT's email is frozen at sign-in
  // and would go stale after a change on /settings.
  const user = await getCurrentUser();
  if (!user) return <>{children}</>;

  return (
    <SidebarProvider>
      <ToastProvider>
        <NavBar account={{ email: user.email, firstName: user.firstName }} />
        <div className="flex-1">{children}</div>
        <SiteFooter>
          <Link
            href="/admin/templates"
            className="text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-400"
          >
            Templates
          </Link>
        </SiteFooter>
      </ToastProvider>
    </SidebarProvider>
  );
}
