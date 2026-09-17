"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  EDITOR_SECTIONS,
  sectionAnchor,
  sectionFromHash,
  topmostVisibleSection,
  type EditorSection,
} from "./editor-sections";

/** Space kept between the sticky header and a section scrolled to the top. */
const SECTION_GAP_PX = 16;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Sidebar navigation for the single scrolling listing form: `goTo` scrolls to
 * a section and focuses its heading, and `active` follows whichever section is
 * topmost in view (an IntersectionObserver below the sticky header). Once
 * `ready`, a `#section` hash in the URL — or else `restoreTo` — is scrolled to.
 */
export function useSectionNav({
  ready,
  headerRef,
}: {
  ready: boolean;
  headerRef: RefObject<HTMLElement | null>;
}) {
  const [active, setActive] = useState<EditorSection>("photos");
  const [headerHeight, setHeaderHeight] = useState(0);
  const restoreTo = useRef<EditorSection | null>(null);
  const initialJumpDone = useRef(false);

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const measure = () => setHeaderHeight(header.offsetHeight);
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(header);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [headerRef]);

  const scrollOffset = headerHeight + SECTION_GAP_PX;

  useEffect(() => {
    if (typeof IntersectionObserver !== "function") return;
    const visible = new Set<EditorSection>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.editorSection as EditorSection;
          if (entry.isIntersecting) visible.add(key);
          else visible.delete(key);
        }
        const top = topmostVisibleSection(visible);
        if (top) setActive(top);
      },
      // Everything hidden behind the sticky header (plus the gap above a
      // scrolled-to section) doesn't count as in view.
      { rootMargin: `-${scrollOffset + SECTION_GAP_PX / 2}px 0px 0px 0px` },
    );
    for (const { key } of EDITOR_SECTIONS) {
      const el = document.getElementById(sectionAnchor(key));
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [ready, scrollOffset]);

  const goTo = useCallback((key: EditorSection, { updateHash = true }: { updateHash?: boolean } = {}): boolean => {
    const el = document.getElementById(sectionAnchor(key));
    if (!el) return false;
    el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    el.querySelector<HTMLElement>("[data-section-heading]")?.focus({ preventScroll: true });
    if (updateHash) window.history.replaceState(window.history.state, "", `#${sectionAnchor(key)}`);
    setActive(key);
    return true;
  }, []);

  useEffect(() => {
    if (!ready || initialJumpDone.current) return;
    initialJumpDone.current = true;
    const target = sectionFromHash(window.location.hash) ?? restoreTo.current;
    if (target && target !== "photos") goTo(target, { updateHash: false });
  }, [ready, goTo]);

  useEffect(() => {
    const onHashChange = () => {
      const target = sectionFromHash(window.location.hash);
      if (target) goTo(target, { updateHash: false });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [goTo]);

  /** Remembers a restored draft's section, scrolled to once ready unless the URL names one. */
  const setRestoreTarget = useCallback((key: EditorSection | null) => {
    restoreTo.current = key;
  }, []);

  return { active, goTo, scrollOffset, setRestoreTarget };
}
