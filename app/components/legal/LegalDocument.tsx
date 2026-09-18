import type { ReactNode } from "react";
import { LEGAL_LAST_UPDATED } from "@/lib/legal";

/** A `[FILL: …]` placeholder the owner must replace before launch. */
export function Fill({ children }: { children: string }) {
  return <mark className="rounded bg-amber-100 px-1 text-amber-900">[FILL: {children}]</mark>;
}

export default function LegalDocument({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="mx-auto w-full max-w-3xl px-6 py-10 text-sm leading-6 text-text [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-5 [&_h3]:font-semibold [&_li]:mt-1 [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-6 [&_a]:text-primary [&_a]:underline">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-text-muted">Last updated: {LEGAL_LAST_UPDATED}</p>
      {children}
    </article>
  );
}
