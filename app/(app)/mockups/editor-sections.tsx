import type { ReactNode } from "react";
import type { ListingFormTab } from "./ListingForm";

/** One section of the listing editor's single scrolling form, in sidebar order. */
export type EditorSection = ListingFormTab | "photos";

export const EDITOR_SECTIONS: readonly { key: EditorSection; label: string; anchor: string }[] = [
  { key: "photos", label: "Photos", anchor: "photos" },
  { key: "title", label: "Title", anchor: "title" },
  { key: "description", label: "Description", anchor: "description" },
  { key: "tags", label: "Tags", anchor: "tags" },
  { key: "details", label: "Details", anchor: "details" },
  { key: "howMade", label: "How it's made", anchor: "how-its-made" },
  { key: "price", label: "Price", anchor: "price" },
  { key: "inventory", label: "Inventory", anchor: "inventory" },
  { key: "variations", label: "Variations", anchor: "variations" },
  { key: "personalization", label: "Personalization", anchor: "personalization" },
  { key: "shipping", label: "Shipping", anchor: "shipping" },
  { key: "settings", label: "Settings", anchor: "settings" },
];

export function sectionAnchor(key: EditorSection): string {
  return EDITOR_SECTIONS.find((s) => s.key === key)?.anchor ?? key;
}

export function sectionHeadingId(key: EditorSection): string {
  return `${sectionAnchor(key)}-heading`;
}

/** `#how-its-made` → `"howMade"`; anything that isn't a section → `null`. */
export function sectionFromHash(hash: string): EditorSection | null {
  const anchor = decodeURIComponent(hash.replace(/^#/, ""));
  return EDITOR_SECTIONS.find((s) => s.anchor === anchor)?.key ?? null;
}

export function isEditorSection(value: unknown): value is EditorSection {
  return EDITOR_SECTIONS.some((s) => s.key === value);
}

/** The first of `visible` in sidebar order — the section the highlight follows. */
export function topmostVisibleSection(visible: ReadonlySet<EditorSection>): EditorSection | null {
  return EDITOR_SECTIONS.find((s) => visible.has(s.key))?.key ?? null;
}

/** Sorts by sidebar order; entries with no section (page-wide errors) come first. */
export function compareSections(a: EditorSection | null, b: EditorSection | null): number {
  const rank = (k: EditorSection | null) => (k == null ? -1 : EDITOR_SECTIONS.findIndex((s) => s.key === k));
  return rank(a) - rank(b);
}

export const SECTION_SCROLL_OFFSET_VAR = "--editor-scroll-offset";

export function EditorSectionCard({
  section,
  className,
  aside,
  children,
}: {
  section: EditorSection;
  className?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const label = EDITOR_SECTIONS.find((s) => s.key === section)?.label ?? section;
  return (
    <section
      id={sectionAnchor(section)}
      data-editor-section={section}
      aria-labelledby={sectionHeadingId(section)}
      style={{ scrollMarginTop: `var(${SECTION_SCROLL_OFFSET_VAR}, 1rem)` }}
      className="rounded-xl border border-black/10 bg-white p-4 dark:border-white/15 dark:bg-zinc-950 md:p-6"
    >
      <div className={className}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3
            id={sectionHeadingId(section)}
            tabIndex={-1}
            data-section-heading
            className="text-base font-bold text-zinc-900 focus:outline-none dark:text-zinc-50"
          >
            {label}
          </h3>
          {aside}
        </div>
        {children}
      </div>
    </section>
  );
}
