"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { utcToWallTime, wallTimeToUtc, type WallTime } from "@/lib/scheduling/timezone";
import type { ScheduleTimeInput } from "@/lib/scheduling/types";
import { parseScheduleTime } from "@/lib/scheduling/validate";

/** The viewer's own IANA timezone — the picker's default. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function timeZoneOptions(mustInclude: string[]): string[] {
  const supported = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [...new Set([...supported, ...mustInclude])].sort();
}

/** A sensible first suggestion: the top of the hour, at least half an hour from now. */
function suggestedWallTime(timeZone: string): WallTime {
  const wall = utcToWallTime(new Date(Date.now() + 90 * 60 * 1000), timeZone);
  return { date: wall.date, time: `${wall.time.slice(0, 2)}:00` };
}

interface Props {
  heading: string;
  description?: ReactNode;
  submitLabel: string;
  /** An existing schedule to edit — the picker opens on its time, in its timezone. */
  initial?: { scheduledAt: string; timezone: string } | null;
  /** Resolves to an error message to show, or `null` once saved (the caller then closes the dialog). */
  onSubmit: (input: ScheduleTimeInput) => Promise<string | null>;
  onClose: () => void;
  /**
   * Render as a popover hanging under the button that opened it, instead of a
   * centred modal. The caller puts it inside a `relative` wrapper next to that
   * button (the editor's "Schedule for later", which lives in the sticky
   * header — whose `backdrop-filter` makes it the containing block for any
   * `position: fixed` child, which is why a modal there came out over the
   * header rather than over the page).
   */
  anchored?: boolean;
}

/**
 * Date + time + timezone picker, shared by the editor's "Schedule for later"
 * and the /schedule screen's Reschedule. The time is a wall time in the
 * chosen zone; the server turns it into a UTC instant and is the authority
 * on rejecting past times — the check here just answers sooner.
 */
export default function ScheduleDialog({
  heading,
  description,
  submitLabel,
  initial,
  onSubmit,
  onClose,
  anchored = false,
}: Props) {
  const [localZone] = useState(browserTimeZone);
  const [timezone, setTimezone] = useState(() => initial?.timezone ?? localZone);
  const [wall, setWall] = useState<WallTime>(() =>
    initial ? utcToWallTime(new Date(initial.scheduledAt), initial.timezone) : suggestedWallTime(localZone),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const popover = useRef<HTMLDivElement>(null);

  // A popover has no backdrop to click, so a press anywhere else closes it.
  useEffect(() => {
    if (!anchored || busy) return;
    const onPointerDown = (event: PointerEvent | MouseEvent) => {
      const target = event.target as Node | null;
      if (target && !popover.current?.contains(target)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [anchored, busy, onClose]);

  const zones = useMemo(() => timeZoneOptions([localZone, timezone]), [localZone, timezone]);
  const today = utcToWallTime(new Date(), timezone).date;

  // When the chosen zone isn't the viewer's, show what the time means locally.
  const localEquivalent = useMemo(() => {
    if (timezone === localZone) return null;
    const result = wallTimeToUtc(wall.date, wall.time, timezone);
    if (!result.ok) return null;
    return result.instant.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }, [wall, timezone, localZone]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const input: ScheduleTimeInput = { ...wall, timezone };
    const check = parseScheduleTime(input);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await onSubmit(input).catch((err: unknown) =>
      err instanceof Error ? err.message : "Could not save the schedule.",
    );
    if (failure) {
      setError(failure);
      setBusy(false);
    }
  }

  const field =
    "mt-1 h-9 w-full rounded-lg border border-black/10 bg-white px-2 text-sm text-zinc-900 outline-none focus:border-primary dark:border-white/15 dark:bg-zinc-900 dark:text-zinc-100";

  const form = (
    <form
      onSubmit={submit}
      onClick={(e) => e.stopPropagation()}
      className={anchored ? "" : "w-full max-w-sm rounded-xl bg-white p-5 shadow-xl dark:bg-zinc-950"}
    >
      <h2 id="schedule-dialog-title" className="text-base font-semibold text-black dark:text-zinc-50">
        {heading}
      </h2>
      {description && <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{description}</div>}

      <div className="mt-4 grid grid-cols-2 gap-3">
        <label className="block text-xs text-zinc-500">
          Date
          <input
            type="date"
            required
            autoFocus
            min={today}
            value={wall.date}
            onChange={(e) => setWall((w) => ({ ...w, date: e.target.value }))}
            className={field}
          />
        </label>
        <label className="block text-xs text-zinc-500">
          Time
          <input
            type="time"
            required
            value={wall.time}
            onChange={(e) => setWall((w) => ({ ...w, time: e.target.value }))}
            className={field}
          />
        </label>
      </div>
      <label className="mt-3 block text-xs text-zinc-500">
        Timezone
        <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className={field}>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replaceAll("_", " ")}
              {zone === localZone ? " (your timezone)" : ""}
            </option>
          ))}
        </select>
      </label>
      {localEquivalent && (
        <p className="mt-2 text-xs text-zinc-500">That&apos;s {localEquivalent} your time.</p>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="h-9 rounded-full border border-black/[.08] px-4 text-sm font-medium transition-colors hover:bg-black/[.04] disabled:opacity-40 dark:border-white/[.145] dark:hover:bg-white/[.06]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="h-9 rounded-full bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-dark disabled:opacity-60"
        >
          {busy ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );

  const escape = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && !busy) onClose();
  };

  // Anchored: hanging under the button that opened it, aligned to its right
  // edge. It only ever grows downwards — with no room left it scrolls inside
  // itself rather than flipping up, where the sticky header would clip it —
  // and sits above the header's own stacking level.
  if (anchored) {
    return (
      <div
        ref={popover}
        role="dialog"
        aria-labelledby="schedule-dialog-title"
        data-placement="below"
        onKeyDown={escape}
        className="absolute right-0 top-full z-50 mt-2 max-h-[min(70vh,34rem)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-xl border border-black/10 bg-white p-5 text-left shadow-xl dark:border-white/15 dark:bg-zinc-950"
      >
        {form}
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="schedule-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={busy ? undefined : onClose}
      onKeyDown={escape}
    >
      {form}
    </div>
  );
}
