import Link from "next/link";
import type { ReactNode } from "react";
import { auth } from "@/auth";
import { getEtsySession } from "@/lib/etsy/auth";
import { getShopName } from "@/lib/etsy/listings";
import NavBar from "./NavBar";

/**
 * Shared chrome (top nav + footer) for every real app page. `/login` and
 * `/register` live outside this route group (no chrome), as does
 * `/admin/templates` (a maintainer-only screen — see its own back link).
 *
 * The app account (not the Etsy connection) is what gates access here —
 * `proxy.ts` redirects an unauthenticated request to `/login` before this
 * layout ever renders, so `session` below is expected to always be set; the
 * null check is just defense in depth, matching Next's own guidance not to
 * rely on Proxy alone.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) return <>{children}</>;

  const etsySession = await getEtsySession();

  let shopName: string | null = null;
  if (etsySession) {
    try {
      shopName = await getShopName();
    } catch {
      // An Etsy API hiccup shouldn't block the whole app shell from rendering.
    }
  }

  return (
    <>
      <NavBar
        email={session.user.email ?? ""}
        shopName={shopName}
        etsySession={
          etsySession ? { userId: etsySession.userId, expiresAt: etsySession.expiresAt } : null
        }
      />
      <div className="flex-1">{children}</div>
      <footer className="border-t border-black/10 px-6 py-4 text-center dark:border-white/15">
        <Link
          href="/admin/templates"
          className="text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-600 dark:hover:text-zinc-400"
        >
          Templates
        </Link>
      </footer>
    </>
  );
}
