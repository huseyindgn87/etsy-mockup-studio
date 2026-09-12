"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

interface Listing {
  listingId: number;
  title: string;
  state: string;
  url: string;
  quantity: number;
  price: string | null;
  thumbnailUrl: string | null;
  endingTimestampMs: number | null;
  shopSectionId: number | null;
}

interface ListingsPage {
  shopId: number;
  count: number;
  limit: number;
  offset: number;
  listings: Listing[];
}

interface SectionOption {
  shopSectionId: number;
  title: string;
}

const STATE_TABS = [
  { value: "active", label: "Active" },
  { value: "draft", label: "Draft" },
  { value: "expired", label: "Expired" },
  { value: "inactive", label: "Inactive" },
  { value: "sold_out", label: "Sold out" },
] as const;
type ListingState = (typeof STATE_TABS)[number]["value"];

const PAGE_SIZE = 24;

/** Etsy's shop-section titles come back HTML-escaped (e.g. "&gt;&gt;HALLOWEEN&lt;&lt;"). */
function decodeHtmlEntities(s: string): string {
  if (typeof document === "undefined") return s;
  const el = document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}

function formatDate(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Builds the editor URL for a row action — the listing's display fields ride along so the editor never needs a refetch just to show them. */
function editorUrl(mode: "copy" | "new" | "existing", listing?: Listing): string {
  const params = new URLSearchParams({ mode });
  if (listing) {
    params.set("listingId", String(listing.listingId));
    params.set("title", listing.title);
    if (listing.thumbnailUrl) params.set("thumbnailUrl", listing.thumbnailUrl);
  }
  return `/mockups?${params.toString()}`;
}

export default function ListingsPage() {
  const [state, setState] = useState<ListingState>("active");
  const [sectionId, setSectionId] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<ListingsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [sections, setSections] = useState<SectionOption[] | null>(null);

  useEffect(() => {
    fetch("/api/etsy/listings/counts")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { counts?: Record<string, number> } | null) => setCounts(body?.counts ?? null))
      .catch(() => {
        /* sidebar counts just stay as "…" */
      });
  }, []);

  useEffect(() => {
    fetch("/api/etsy/sections")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { sections?: SectionOption[] } | null) => {
        const decoded = (body?.sections ?? []).map((s) => ({
          ...s,
          title: decodeHtmlEntities(s.title),
        }));
        setSections(decoded);
      })
      .catch(() => setSections([]));
  }, []);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        // Etsy's listings endpoint has no combined state+section filter (checked
        // directly against getListingsByShop's params) — with a section chosen,
        // fetch every listing for the state (cached) and filter/paginate here.
        if (sectionId != null) {
          const params = new URLSearchParams({ state, all: "true" });
          const res = await fetch(`/api/etsy/listings?${params.toString()}`, { signal });
          const body = await res.json().catch(() => null);
          if (!res.ok) {
            throw new Error((body && body.error) || `Request failed (${res.status})`);
          }
          const whole = body as ListingsPage;
          const filtered = whole.listings.filter((l) => l.shopSectionId === sectionId);
          if (!signal.aborted) {
            setData({
              shopId: whole.shopId,
              count: filtered.length,
              limit: PAGE_SIZE,
              offset,
              listings: filtered.slice(offset, offset + PAGE_SIZE),
            });
          }
        } else {
          const params = new URLSearchParams({
            state,
            limit: String(PAGE_SIZE),
            offset: String(offset),
          });
          const res = await fetch(`/api/etsy/listings?${params.toString()}`, { signal });
          const body = await res.json().catch(() => null);
          if (!res.ok) {
            throw new Error((body && body.error) || `Request failed (${res.status})`);
          }
          if (!signal.aborted) setData(body as ListingsPage);
        }
      } catch (err) {
        if (signal.aborted || (err as Error).name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load listings.");
        setData(null);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [state, sectionId, offset],
  );

  useEffect(() => {
    const controller = new AbortController();
    // `load` flips loading/error state before awaiting; that initial render pass
    // is intentional (it shows the skeleton / clears a stale error).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function selectState(next: ListingState) {
    if (next === state) return;
    setOffset(0);
    setState(next);
  }
  function selectSection(next: number | null) {
    if (next === sectionId) return;
    setOffset(0);
    setSectionId(next);
  }

  const total = data?.count ?? 0;
  const listings = data?.listings ?? [];
  const showingFrom = total === 0 ? 0 : offset + 1;
  const showingTo = Math.min(offset + PAGE_SIZE, total);
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  const sectionTitleById = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of sections ?? []) m.set(s.shopSectionId, s.title);
    return m;
  }, [sections]);

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8 lg:flex-row">
        {/* ---- left sidebar: state + section filters ---- */}
        <aside className="lg:w-56 lg:shrink-0">
          <Link
            href="/"
            className="text-sm text-zinc-500 transition-colors hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            ← Back
          </Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Listings
          </h1>

          <Link
            href={editorUrl("new")}
            className="mt-4 flex h-10 w-full items-center justify-center rounded-full bg-[#f56400] text-sm font-medium text-white transition-colors hover:bg-[#d95700]"
          >
            + Create listing
          </Link>

          <nav className="mt-6 space-y-0.5">
            {STATE_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => selectState(tab.value)}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  state === tab.value
                    ? "bg-black text-white dark:bg-white dark:text-black"
                    : "text-zinc-600 hover:bg-black/[.04] dark:text-zinc-400 dark:hover:bg-white/[.06]"
                }`}
              >
                <span>{tab.label}</span>
                <span className={state === tab.value ? "opacity-80" : "text-zinc-400"}>
                  {counts ? (counts[tab.value] ?? 0) : "…"}
                </span>
              </button>
            ))}
          </nav>

          <label className="mt-6 block text-sm">
            <span className="text-xs text-zinc-500">Section</span>
            <select
              value={sectionId ?? ""}
              onChange={(e) => selectSection(e.target.value ? Number(e.target.value) : null)}
              className="mt-1 h-9 w-full rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-[#f56400] dark:border-white/15 dark:bg-zinc-950"
            >
              <option value="">All sections</option>
              {(sections ?? []).map((s) => (
                <option key={s.shopSectionId} value={s.shopSectionId}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
        </aside>

        {/* ---- main: table + pagination ---- */}
        <div className="min-w-0 flex-1">
          {error && (
            <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
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

          <div className="overflow-x-auto rounded-xl border border-black/10 bg-white dark:border-white/15 dark:bg-zinc-950">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-black/10 text-xs text-zinc-500 dark:border-white/15">
                  <th className="px-4 py-3 font-medium">Listing</th>
                  <th className="px-4 py-3 font-medium">Stock</th>
                  <th className="px-4 py-3 font-medium">Price</th>
                  <th className="px-4 py-3 font-medium">Expires</th>
                  <th className="px-4 py-3 font-medium">Section</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && !data &&
                  Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i} className="border-b border-black/5 last:border-0 dark:border-white/10">
                      <td colSpan={6} className="px-4 py-4">
                        <div className="h-8 w-full animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
                      </td>
                    </tr>
                  ))}

                {!loading && !error && listings.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-sm text-zinc-500">
                      No {STATE_TABS.find((t) => t.value === state)?.label.toLowerCase()} listings
                      found.
                    </td>
                  </tr>
                )}

                {listings.map((listing) => (
                  <tr
                    key={listing.listingId}
                    className="border-b border-black/5 last:border-0 dark:border-white/10"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <ListingThumb url={listing.thumbnailUrl} size={40} />
                        <a
                          href={listing.url}
                          target="_blank"
                          rel="noreferrer"
                          className="line-clamp-2 max-w-xs text-zinc-800 hover:underline dark:text-zinc-100"
                        >
                          {listing.title}
                        </a>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{listing.quantity}</td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      {listing.price ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      {formatDate(listing.endingTimestampMs)}
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      {listing.shopSectionId != null
                        ? (sectionTitleById.get(listing.shopSectionId) ?? "—")
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1.5">
                        <Link
                          href={editorUrl("copy", listing)}
                          className="h-7 whitespace-nowrap rounded-full border border-black/10 px-2.5 text-xs font-medium leading-7 transition-colors hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
                        >
                          Copy to a copy
                        </Link>
                        <Link
                          href={editorUrl("new", listing)}
                          className="h-7 whitespace-nowrap rounded-full border border-black/10 px-2.5 text-xs font-medium leading-7 transition-colors hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
                        >
                          New draft from it
                        </Link>
                        <Link
                          href={editorUrl("existing", listing)}
                          className="h-7 whitespace-nowrap rounded-full border border-black/10 px-2.5 text-xs font-medium leading-7 transition-colors hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
                        >
                          Add to it
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
            <span className="text-zinc-500 dark:text-zinc-400">
              {total === 0 ? "No listings" : `Viewing ${showingFrom}-${showingTo} of ${total}`}
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
        </div>
      </div>
    </div>
  );
}

/** Small square thumbnail with a placeholder for listings with no image yet. */
function ListingThumb({ url, size }: { url: string | null; size: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800"
      style={{ width: size, height: size }}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <span className="text-[10px] text-zinc-400">—</span>
      )}
    </span>
  );
}
