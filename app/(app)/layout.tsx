import Link from "next/link";
import type { ReactNode } from "react";
import { getEtsySession } from "@/lib/etsy/auth";
import { getShopName } from "@/lib/etsy/listings";
import NavBar from "./NavBar";

/**
 * Shared chrome (top nav + footer) for every real app page — everything
 * except the sign-in screen (this is the home page, `/`, while signed out —
 * there's no session yet, so nothing to navigate to or disconnect) and
 * `/admin/templates` (a maintainer-only screen, deliberately outside this
 * route group so it doesn't inherit this chrome — see its own back link).
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getEtsySession();
  if (!session) return <>{children}</>;

  let shopName: string | null = null;
  try {
    shopName = await getShopName();
  } catch {
    // An Etsy API hiccup shouldn't block the whole app shell from rendering.
  }

  return (
    <>
      <NavBar
        shopName={shopName}
        session={{ userId: session.userId, expiresAt: session.expiresAt }}
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
