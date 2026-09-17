"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { interceptedDestination, unsavedChangesMessage } from "./navigation-intercept";

interface PendingLeave {
  count: number;
  proceed: () => void;
}

/** Marks the extra history entry pushed so the Back button can be held. */
export const HISTORY_SENTINEL = "__unsavedChangesGuard";

interface GuardOptions {
  /** Saves the work; the dialog leaves once it resolves `true`, and stays open with an error on `false`. */
  onSave?: () => Promise<boolean>;
  /** What the Save button says, e.g. "Save draft and leave". */
  saveLabel?: string;
}

/**
 * Warns before unsaved edits are lost while `unsavedCount` is above zero:
 * closing or reloading the tab (`beforeunload`), clicking an in-app link
 * anywhere on the page (held in the capture phase, before Next's `<Link>`
 * sees it), the browser Back button (held by an extra history entry for this
 * same URL, popped for real only once the user says so), and any navigation
 * the page itself routes through `guard`. Render the returned `dialog`; it
 * offers Cancel / Discard / Save.
 */
export function useUnsavedChangesGuard(
  unsavedCount: number,
  options: GuardOptions = {},
): {
  guard: (proceed: () => void) => void;
  dialog: ReactNode;
} {
  const { onSave, saveLabel = "Save and leave" } = options;
  const [pending, setPending] = useState<PendingLeave | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Set while Discard replays the held click, so it isn't held a second time. */
  const replaying = useRef(false);
  /** Set once the user chose to leave — the page is going, so don't ask the browser to warn too. */
  const discarded = useRef(false);
  /** Whether the extra history entry is currently on the stack. */
  const sentinelPushed = useRef(false);
  /** Set while the guard itself pops the sentinel, so that pop isn't treated as a Back press. */
  const poppingSentinel = useRef(false);
  const countRef = useRef(unsavedCount);
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    countRef.current = unsavedCount;
    onSaveRef.current = onSave;
  });

  const dirty = unsavedCount > 0;

  useEffect(() => {
    if (!dirty) return;

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
      setSaveError(null);
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
  }, [dirty, unsavedCount]);

  // ---- the Back button ----
  // The App Router has no navigation-blocking API, so a Back press is held by
  // keeping one extra history entry for this same URL on top of the real one.
  // Pressing Back lands on the real entry: the guard immediately pushes the
  // sentinel again (so the page stays put) and asks. Leaving pops both.
  useEffect(() => {
    function pushSentinel() {
      const state = window.history.state as Record<string, unknown> | null;
      window.history.pushState({ ...state, [HISTORY_SENTINEL]: true }, "", window.location.href);
    }

    function onPopState() {
      if (poppingSentinel.current) {
        poppingSentinel.current = false;
        return;
      }
      if (!sentinelPushed.current || countRef.current === 0) return;
      pushSentinel();
      setSaveError(null);
      setPending({
        count: countRef.current,
        proceed: () => {
          sentinelPushed.current = false;
          window.history.go(-2);
        },
      });
    }

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (dirty) {
      if (sentinelPushed.current) return;
      sentinelPushed.current = true;
      const state = window.history.state as Record<string, unknown> | null;
      window.history.pushState({ ...state, [HISTORY_SENTINEL]: true }, "", window.location.href);
      return;
    }
    // Saved (or the edits were undone): drop the extra entry again so one Back
    // press leaves, exactly as it would on a page that never went dirty.
    if (!sentinelPushed.current) return;
    sentinelPushed.current = false;
    poppingSentinel.current = true;
    window.history.back();
  }, [dirty]);

  const leave = useCallback((proceed: () => void) => {
    setPending(null);
    setSaveError(null);
    discarded.current = true;
    proceed();
  }, []);

  const guard = useCallback(
    (proceed: () => void) => {
      if (unsavedCount === 0) proceed();
      else {
        setSaveError(null);
        setPending({ count: unsavedCount, proceed });
      }
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
      onClick={() => !saving && setPending(null)}
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
        {saveError && (
          <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
            {saveError}
          </p>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            autoFocus
            disabled={saving}
            onClick={() => setPending(null)}
            className="h-9 rounded-full border border-black/[.08] px-4 text-sm font-medium transition-colors hover:bg-black/[.04] disabled:opacity-40 dark:border-white/[.145] dark:hover:bg-white/[.06]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => leave(pending.proceed)}
            className="h-9 rounded-full bg-red-600 px-4 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-40"
          >
            Discard
          </button>
          {onSave && (
            <button
              type="button"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                setSaveError(null);
                try {
                  const ok = await onSaveRef.current?.();
                  if (ok) leave(pending.proceed);
                  else setSaveError("Could not save. Try again, or discard the changes.");
                } catch (err) {
                  setSaveError(err instanceof Error ? err.message : "Could not save.");
                } finally {
                  setSaving(false);
                }
              }}
              className="h-9 rounded-full bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-dark disabled:opacity-40"
            >
              {saving ? "Saving…" : saveLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  ) : null;

  return { guard, dialog };
}
