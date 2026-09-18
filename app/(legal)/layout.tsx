import Link from "next/link";
import type { ReactNode } from "react";
import SiteFooter from "@/app/components/SiteFooter";
import { APP_NAME } from "@/lib/brand";

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bg-page-gradient flex min-h-screen flex-col font-sans">
      <header className="border-b border-black/10 px-6 py-4 dark:border-white/15">
        <Link href="/listings" className="text-sm font-semibold tracking-widest text-text">
          {APP_NAME.toUpperCase()}
        </Link>
      </header>
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
