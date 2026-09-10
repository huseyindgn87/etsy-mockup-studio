"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface Listing {
  listingId: number;
  title: string;
  state: string;
  url: string;
  quantity: number;
  price: string | null;
  thumbnailUrl: string | null;
}

interface ListingsPage {
  shopId: number;
  count: number;
  limit: number;
  offset: number;
  listings: Listing[];
}

const STATE_TABS = [
  { value: "active", label: "Active" },
  { value: "draft", label: "Draft" },
  { value: "inactive", label: "Inactive" },
  { value: "sold_out", label: "Sold out" },
  { value: "expired", label: "Expired" },
] as const;

const PAGE_SIZE = 24;

const STATE_BADGE: Record<string, string> = {
  active: "bg-green-100 text-green-800 dark:bg-green-950/60 dark:text-green-300",
  draft: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  inactive: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  sold_out: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300",
  expired: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

export default function ListingsPage() {
  const [state, setState] = useState<string>("active");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<ListingsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          state,
          limit: String(PAGE_SIZE),
          offset: String(offset),
        });
        const res = await fetch(`/api/etsy/listings?${params.toString()}`, {
          signal,
        });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          const message =
            (body && typeof body.error === "string" && body.error) ||
            `Request failed (${res.status})`;
          throw new Error(message);
        }
        if (!signal.aborted) setData(body as ListingsPage);
      } catch (err) {
        if (signal.aborted || (err as Error).name === "AbortError") return;
        setError(
          err instanceof Error ? err.message : "Failed to load listings.",
        );
        setData(null);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [state, offset],
  );

  useEffect(() => {
    const controller = new AbortController();
    // `load` flips loading/error state before awaiting; that initial render pass
    // is intentional (it shows the skeleton / clears a stale error).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function selectState(next: string) {
    if (next === state) return;
    setOffset(0);
    setState(next);
  }

  const total = data?.count ?? 0;
  const listings = data?.listings ?? [];
  const showingFrom = total === 0 ? 0 : offset + 1;
  const showingTo = Math.min(offset + PAGE_SIZE, total);
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  return (
    <div className="min-h-screen bg-zinc-50 px-6 py-10 font-sans dark:bg-black">
      <div className="mx-auto w-full max-w-5xl">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link
              href="/"
              className="text-sm text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
            >
              ← Back
            </Link>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
              My Etsy listings
            </h1>
            {data && (
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                Shop #{data.shopId} · {total} {total === 1 ? "listing" : "listings"}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              const controller = new AbortController();
              load(controller.signal);
            }}
            disabled={loading}
            className="h-9 rounded-full border border-black/[.08] px-4 text-sm font-medium transition-colors hover:bg-black/[.04] disabled:opacity-50 dark:border-white/[.145] dark:hover:bg-white/[.06]"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </header>

        <nav className="mt-6 flex flex-wrap gap-2">
          {STATE_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => selectState(tab.value)}
              className={`h-8 rounded-full px-3 text-sm font-medium transition-colors ${
                state === tab.value
                  ? "bg-black text-white dark:bg-white dark:text-black"
                  : "border border-black/[.08] text-zinc-700 hover:bg-black/[.04] dark:border-white/[.145] dark:text-zinc-300 dark:hover:bg-white/[.06]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="mt-6">
          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
              {error}
              {error.includes("Not connected") && (
                <>
                  {" "}
                  <Link href="/" className="underline">
                    Reconnect
                  </Link>
                </>
              )}
            </div>
          )}

          {loading && !data && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="animate-pulse overflow-hidden rounded-xl border border-black/[.06] bg-white dark:border-white/[.1] dark:bg-zinc-950"
                >
                  <div className="aspect-square bg-zinc-100 dark:bg-zinc-900" />
                  <div className="space-y-2 p-3">
                    <div className="h-3 w-full rounded bg-zinc-100 dark:bg-zinc-900" />
                    <div className="h-3 w-2/3 rounded bg-zinc-100 dark:bg-zinc-900" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!loading && !error && listings.length === 0 && (
            <div className="rounded-xl border border-black/[.08] bg-white px-4 py-10 text-center text-sm text-zinc-600 dark:border-white/[.145] dark:bg-zinc-950 dark:text-zinc-400">
              No {STATE_TABS.find((t) => t.value === state)?.label.toLowerCase()}{" "}
              listings found.
            </div>
          )}

          {listings.length > 0 && (
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {listings.map((listing) => (
                <li key={listing.listingId}>
                  <a
                    href={listing.url}
                    target="_blank"
                    rel="noreferrer"
                    className="group flex h-full flex-col overflow-hidden rounded-xl border border-black/[.06] bg-white transition-shadow hover:shadow-md dark:border-white/[.1] dark:bg-zinc-950"
                  >
                    <div className="relative aspect-square overflow-hidden bg-zinc-100 dark:bg-zinc-900">
                      {listing.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={listing.thumbnailUrl}
                          alt=""
                          loading="lazy"
                          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-xs text-zinc-400">
                          No image
                        </div>
                      )}
                      <span
                        className={`absolute left-2 top-2 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${
                          STATE_BADGE[listing.state] ?? STATE_BADGE.draft
                        }`}
                      >
                        {listing.state.replace("_", " ")}
                      </span>
                    </div>
                    <div className="flex flex-1 flex-col p-3">
                      <p className="line-clamp-2 text-sm text-zinc-800 dark:text-zinc-100">
                        {listing.title}
                      </p>
                      <div className="mt-2 flex items-center justify-between text-sm">
                        <span className="font-medium text-black dark:text-zinc-50">
                          {listing.price ?? "—"}
                        </span>
                        <span className="text-zinc-500 dark:text-zinc-400">
                          Qty {listing.quantity}
                        </span>
                      </div>
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>

        {total > PAGE_SIZE && (
          <div className="mt-8 flex items-center justify-between text-sm">
            <span className="text-zinc-500 dark:text-zinc-400">
              {showingFrom}–{showingTo} of {total}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setOffset((o) => Math.max(o - PAGE_SIZE, 0))}
                disabled={!canPrev || loading}
                className="h-9 rounded-full border border-black/[.08] px-4 font-medium transition-colors hover:bg-black/[.04] disabled:opacity-40 dark:border-white/[.145] dark:hover:bg-white/[.06]"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
                disabled={!canNext || loading}
                className="h-9 rounded-full border border-black/[.08] px-4 font-medium transition-colors hover:bg-black/[.04] disabled:opacity-40 dark:border-white/[.145] dark:hover:bg-white/[.06]"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
