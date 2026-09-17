"use client";

import Link from "next/link";
import { CalendarClock, CalendarX, ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  addDays,
  FORTNIGHT_DAYS,
  formatRangeHeading,
  fortnightDays,
  localDayKey,
  startOfWeek,
} from "@/lib/scheduling/calendar";
import { utcToWallTime } from "@/lib/scheduling/timezone";
import {
  EDITABLE_STATUSES,
  MAX_PUBLISH_ATTEMPTS,
  type ScheduledListingSummary,
  type ScheduleStatus,
  type ScheduleTimeInput,
} from "@/lib/scheduling/types";
import ScheduleDialog, { browserTimeZone } from "./ScheduleDialog";

/** Re-checks the date once a minute, so TODAY moves at midnight on a page left open. */
function subscribeToClock(onChange: () => void) {
  const timer = setInterval(onChange, 60_000);
  return () => clearInterval(timer);
}

/**
 * Today's local day key — `null` during server rendering, which can't know
 * the viewer's timezone. The strip renders once it's known on the client.
 */
function useTodayKey(): string | null {
  return useSyncExternalStore(subscribeToClock, () => localDayKey(new Date()), () => null);
}

function dateFromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Where clicking an entry goes: its draft in the editor (`null` once the draft is deleted). */
function editorHref(item: ScheduledListingSummary): string | null {
  return item.draftId ? `/mockups?draftId=${encodeURIComponent(item.draftId)}` : null;
}

async function errorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error || `Request failed (${res.status})`;
}

interface Loaded {
  startKey: string;
  items: ScheduledListingSummary[];
  error: string | null;
}

/**
 * The /schedule screen: a two-week strip of the viewer's local days, each
 * listing its scheduled listings. Arrows page a fortnight at a time.
 */
export default function ScheduleBoard() {
  const todayKey = useTodayKey();
  const [page, setPage] = useState(0);
  const [reloadTick, setReloadTick] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [rescheduling, setRescheduling] = useState<ScheduledListingSummary | null>(null);
  const [cancelling, setCancelling] = useState<ScheduledListingSummary | null>(null);

  const start = useMemo(
    () => (todayKey ? addDays(startOfWeek(dateFromKey(todayKey)), page * FORTNIGHT_DAYS) : null),
    [todayKey, page],
  );
  const startKey = start ? localDayKey(start) : null;
  const days = useMemo(() => (start ? fortnightDays(start) : []), [start]);

  useEffect(() => {
    if (!start || !startKey) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      from: start.toISOString(),
      to: addDays(start, FORTNIGHT_DAYS).toISOString(),
    });
    fetch(`/api/schedule?${params.toString()}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorFrom(res));
        const body = (await res.json()) as { scheduledListings: ScheduledListingSummary[] };
        if (!controller.signal.aborted) setLoaded({ startKey, items: body.scheduledListings, error: null });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoaded({
          startKey,
          items: [],
          error: err instanceof Error ? err.message : "Failed to load scheduled listings.",
        });
      });
    return () => controller.abort();
  }, [start, startKey, reloadTick]);

  // A reload of the same fortnight keeps showing the old entries until the new ones arrive.
  const current = loaded && loaded.startKey === startKey ? loaded : null;
  const loading = !current;
  const items = useMemo(() => current?.items ?? [], [current]);

  const byDay = useMemo(() => {
    const map = new Map<string, ScheduledListingSummary[]>();
    for (const item of items) {
      const key = localDayKey(new Date(item.scheduledAt));
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return map;
  }, [items]);

  const reload = () => setReloadTick((t) => t + 1);

  async function submitReschedule(input: ScheduleTimeInput): Promise<string | null> {
    if (!rescheduling) return null;
    const res = await fetch(`/api/schedule/${encodeURIComponent(rescheduling.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) return errorFrom(res);
    setRescheduling(null);
    reload();
    return null;
  }

  const gridColumns = { gridTemplateColumns: `repeat(${FORTNIGHT_DAYS}, minmax(5.75rem, 1fr))` };
  const showEmpty = !loading && !current?.error && items.length === 0;

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <div className="mx-auto w-full max-w-[96rem] px-4 py-8 sm:px-6">
        <Link
          href="/listings"
          className="text-sm text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          ← Back to listings
        </Link>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight text-black dark:text-zinc-50">Schedule</h1>
          <div className="flex items-center gap-1">
            {page !== 0 && (
              <button
                type="button"
                onClick={() => setPage(0)}
                className="mr-2 h-8 rounded-full border border-black/10 px-3 text-xs font-medium transition-colors hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
              >
                This week
              </button>
            )}
            <button
              type="button"
              onClick={() => setPage((p) => p - 1)}
              disabled={!start}
              aria-label="Previous two weeks"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 transition-colors hover:bg-black/[.06] disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-white/[.1]"
            >
              <ChevronLeft size={18} aria-hidden />
            </button>
            <h2
              aria-live="polite"
              className="min-w-[12.5rem] text-center text-sm font-medium tabular-nums text-zinc-800 dark:text-zinc-100"
            >
              {start ? formatRangeHeading(start) : "…"}
            </h2>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={!start}
              aria-label="Next two weeks"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 transition-colors hover:bg-black/[.06] disabled:opacity-40 dark:text-zinc-300 dark:hover:bg-white/[.1]"
            >
              <ChevronRight size={18} aria-hidden />
            </button>
          </div>
        </div>

        {current?.error && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
            {current.error}
            {current.error.includes("Not connected") && (
              <>
                {" "}
                <Link href="/" className="underline">
                  Reconnect
                </Link>
              </>
            )}
          </div>
        )}

        <div className="mt-4 overflow-x-auto rounded-xl border border-black/10 bg-white dark:border-white/15 dark:bg-zinc-950">
          <div className="grid" style={gridColumns}>
            {days.map((day, i) => {
              const isToday = localDayKey(day) === todayKey;
              return (
                <div
                  key={localDayKey(day)}
                  aria-current={isToday ? "date" : undefined}
                  className={`border-b border-black/10 px-2 py-2 text-center dark:border-white/15 ${
                    i < FORTNIGHT_DAYS - 1 ? "border-r" : ""
                  } ${isToday ? "bg-primary/[.06]" : ""}`}
                >
                  <div className="text-[11px] uppercase tracking-wide text-zinc-500">
                    {day.toLocaleDateString(undefined, { weekday: "short" })}
                  </div>
                  <div
                    className={`text-lg font-semibold tabular-nums ${
                      isToday ? "text-primary" : "text-zinc-800 dark:text-zinc-100"
                    }`}
                  >
                    {day.getDate()}
                  </div>
                  <div
                    className={`h-4 text-[10px] font-semibold tracking-wider ${isToday ? "text-primary" : ""}`}
                  >
                    {isToday ? "TODAY" : ""}
                  </div>
                </div>
              );
            })}

            {showEmpty ? (
              <div className="col-span-full">
                <div className="sticky left-0 flex w-[min(100%,calc(100vw-2rem))] flex-col items-center justify-center gap-3 py-20 text-zinc-500 dark:text-zinc-400">
                  <Clock size={36} strokeWidth={1.5} aria-hidden />
                  <p className="text-sm font-medium">No scheduled listings</p>
                </div>
              </div>
            ) : (
              days.map((day, i) => (
                <div
                  key={localDayKey(day)}
                  className={`min-h-72 p-1.5 dark:border-white/15 ${
                    i < FORTNIGHT_DAYS - 1 ? "border-r border-black/10" : ""
                  }`}
                >
                  {loading ? (
                    <div className="h-20 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" />
                  ) : (
                    <ul className="space-y-1.5">
                      {(byDay.get(localDayKey(day)) ?? []).map((item) => (
                        <ScheduleEntry
                          key={item.id}
                          item={item}
                          onReschedule={() => setRescheduling(item)}
                          onCancel={() => setCancelling(item)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {rescheduling && (
        <ScheduleDialog
          heading="Reschedule listing"
          description={<span className="line-clamp-2">{rescheduling.title}</span>}
          submitLabel="Reschedule"
          initial={rescheduling}
          onSubmit={submitReschedule}
          onClose={() => setRescheduling(null)}
        />
      )}

      {cancelling && (
        <CancelScheduleModal
          item={cancelling}
          onClose={() => setCancelling(null)}
          onCancelled={() => {
            setCancelling(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

const STATUS_BADGE: Partial<Record<ScheduleStatus, { label: string; className: string }>> = {
  publishing: {
    label: "Publishing…",
    className: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  },
  published: {
    label: "Published",
    className: "bg-green-100 text-green-800 dark:bg-green-950/60 dark:text-green-300",
  },
  failed: { label: "Failed", className: "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300" },
};

function ScheduleEntry({
  item,
  onReschedule,
  onCancel,
}: {
  item: ScheduledListingSummary;
  onReschedule: () => void;
  onCancel: () => void;
}) {
  const instant = new Date(item.scheduledAt);
  const time = instant.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const otherZone = item.timezone !== browserTimeZone();
  const zoneHint = otherZone
    ? (() => {
        const wall = utcToWallTime(instant, item.timezone);
        return `${wall.time} in ${item.timezone.replaceAll("_", " ")}`;
      })()
    : undefined;
  // A pending row that has already failed an attempt is waiting out its backoff.
  const badge =
    item.status === "pending" && item.attemptCount > 0
      ? {
          label: `Retrying (${item.attemptCount}/${MAX_PUBLISH_ATTEMPTS})`,
          className: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
        }
      : STATUS_BADGE[item.status];
  const editable = EDITABLE_STATUSES.includes(item.status);
  const href = editorHref(item);

  const body = (
    <>
      <div className="flex items-center gap-1.5">
        <Thumb url={item.thumbnailUrl} />
        <span
          title={zoneHint}
          className="text-[11px] font-medium tabular-nums text-zinc-600 dark:text-zinc-300"
        >
          {time}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 break-words text-xs text-zinc-800 dark:text-zinc-100">{item.title}</p>
    </>
  );

  return (
    <li className="rounded-lg border border-black/10 bg-zinc-50 p-1.5 dark:border-white/10 dark:bg-zinc-900">
      {href ? (
        <Link
          href={href}
          title={`Edit “${item.title}”`}
          className="block rounded hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {body}
        </Link>
      ) : (
        body
      )}
      {badge && (
        <span
          title={item.lastError ?? undefined}
          className={`mt-1 inline-block rounded px-1 py-px text-[10px] font-medium ${badge.className}`}
        >
          {badge.label}
        </span>
      )}
      {item.kind === "bulk_edit" && item.results.length > 0 && (
        <ul className="mt-1 space-y-px text-[10px] leading-tight text-zinc-600 dark:text-zinc-400">
          {item.results.map((result) => (
            <li
              key={result.listingId}
              title={result.error ?? undefined}
              className={`line-clamp-2 ${result.ok ? "" : "text-red-700 dark:text-red-400"}`}
            >
              {result.ok ? "✓" : "!"} {result.title || result.listingId}
              {result.error ? `: ${result.error}` : ""}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <div className="mt-1 flex justify-end gap-0.5">
          <button
            type="button"
            onClick={onReschedule}
            title="Reschedule"
            aria-label={`Reschedule “${item.title}”`}
            className="rounded p-1 text-zinc-500 transition-colors hover:bg-black/[.06] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[.1] dark:hover:text-zinc-100"
          >
            <CalendarClock size={14} aria-hidden />
          </button>
          <button
            type="button"
            onClick={onCancel}
            title="Cancel"
            aria-label={`Cancel scheduled listing “${item.title}”`}
            className="rounded p-1 text-zinc-500 transition-colors hover:bg-red-100 hover:text-red-700 dark:text-zinc-400 dark:hover:bg-red-950/50 dark:hover:text-red-400"
          >
            <CalendarX size={14} aria-hidden />
          </button>
        </div>
      )}
    </li>
  );
}

function CancelScheduleModal({
  item,
  onClose,
  onCancelled,
}: {
  item: ScheduledListingSummary;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/schedule/${encodeURIComponent(item.id)}/cancel`, { method: "POST" });
      if (!res.ok) throw new Error(await errorFrom(res));
      onCancelled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel.");
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-schedule-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={busy ? undefined : onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl dark:bg-zinc-950"
      >
        <h2 id="cancel-schedule-title" className="text-base font-semibold text-black dark:text-zinc-50">
          Cancel scheduled listing?
        </h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          <span className="line-clamp-2 font-medium text-zinc-800 dark:text-zinc-200">{item.title}</span>{" "}
          won&apos;t be published. The draft stays saved, so you can schedule it again later.
        </p>
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
            Keep
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="h-9 rounded-full bg-red-600 px-4 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-60"
          >
            {busy ? "Cancelling…" : "Cancel schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Thumb({ url }: { url: string | null }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="text-[10px] text-zinc-400">—</span>
      )}
    </span>
  );
}
