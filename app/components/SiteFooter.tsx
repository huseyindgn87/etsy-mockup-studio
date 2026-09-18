import Link from "next/link";
import type { ReactNode } from "react";
import { ETSY_TRADEMARK_NOTICE, LEGAL_PAGES } from "@/lib/legal";

export default function SiteFooter({ children }: { children?: ReactNode }) {
  return (
    <footer className="border-t border-black/10 px-6 py-4 text-center text-xs text-zinc-500 dark:border-white/15 dark:text-zinc-400">
      <nav aria-label="Legal" className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
        {LEGAL_PAGES.map((page) => (
          <Link key={page.href} href={page.href} className="hover:text-zinc-700 hover:underline dark:hover:text-zinc-200">
            {page.label}
          </Link>
        ))}
        {children}
      </nav>
      <p className="mx-auto mt-2 max-w-2xl">{ETSY_TRADEMARK_NOTICE}</p>
    </footer>
  );
}
