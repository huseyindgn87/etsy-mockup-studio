"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { interceptedDestination, unsavedChangesMessage } from "./navigation-intercept";

interface PendingLeave {
  count: number;
  proceed: () => void;
}

/**
 * Warns before unsaved edits are lost while `unsavedCount` is above zero:
 * closing or reloading the tab (`beforeunload`), clicking an in-app link
 * anywhere on the page (held in the capture phase, before Next's `<Link>`
 * sees it), and any navigation the page itself routes through `guard`.
 * Render the returned `dialog`; it offers Stay / Discard.
 */
export function useUnsavedChangesGuard(unsavedCount: number): {
  guard: (proceed: () => void) => void;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<PendingLeave | null>(null);
  /** Set while Discard replays the held click, so it isn't held a second time. */
  const replaying = useRef(false);
  /** Set once the user chose Discard — the page is leaving, so don't ask the browser to warn too. */
  const discarded = useRef(false);

  useEffect(() => {
    if (unsavedCount === 0) return;

    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (discarded.current) return;
      e.preventDefault();
      e.returnValue = "";
    }

    function onClick(e: MouseEvent) {
      if (replaying.current || e.defaultPrevented || !(e.target instanceof Element)) return;
      const anchor = e.target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const destination = interceptedDestination({
        href: anchor.href,
        target: anchor.target,
        download: anchor.hasAttribute("download"),
        button: e.button,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        currentHref: window.location.href,
      });
      if (destination == null) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setPending({
        count: unsavedCount,
        proceed: () => {
          if (!anchor.isConnected) {
            window.location.assign(destination);
            return;
          }
          replaying.current = true;
          try {
            anchor.click();
          } finally {
            replaying.current = false;
          }
        },
      });
    }

    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("click", onClick, true);
    };
  }, [unsavedCount]);

  const guard = useCallback(
    (proceed: () => void) => {
      if (unsavedCount === 0) proceed();
      else setPending({ count: unsavedCount, proceed });
    },
    [unsavedCount],
  );

  const dialog = pending ? (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="unsaved-changes-title"
      aria-describedby="unsaved-changes-message"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={() => setPending(null)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl dark:bg-zinc-950"
      >
        <h2 id="unsaved-changes-title" className="text-base font-semibold text-black dark:text-zinc-50">
          Unsaved changes
        </h2>
        <p id="unsaved-changes-message" className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {unsavedChangesMessage(pending.count)}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            onClick={() => setPending(null)}
            className="h-9 rounded-full border border-black/[.08] px-4 text-sm font-medium transition-colors hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-white/[.06]"
          >
            Stay
          </button>
          <button
            type="button"
            onClick={() => {
              setPending(null);
              discarded.current = true;
              pending.proceed();
            }}
            className="h-9 rounded-full bg-red-600 px-4 text-sm font-medium text-white transition-colors hover:bg-red-700"
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { guard, dialog };
}
