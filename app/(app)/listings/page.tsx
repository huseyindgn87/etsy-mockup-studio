"use client";

import Link from "next/link";
import { Copy, Merge, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DraftSummary } from "@/lib/drafts/types";

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
  sku: string | null;
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

/** Draft "last saved" needs same-day resolution too, unlike a listing's expiry date. */
function formatSavedAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
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
  const [viewingDrafts, setViewingDrafts] = useState(false);
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [draftsLoading, setDraftsLoading] = useState(false);
  const [draftsError, setDraftsError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Listing | null>(null);

  const loadDrafts = useCallback(async () => {
    setDraftsLoading(true);
    setDraftsError(null);
    try {
      const res = await fetch("/api/drafts");
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
      setDrafts((body as { drafts: DraftSummary[] }).drafts);
    } catch (err) {
      setDraftsError(err instanceof Error ? err.message : "Failed to load drafts.");
    } finally {
      setDraftsLoading(false);
    }
  }, []);

  useEffect(() => {
    // Same pattern as `load` below — flips loading state before awaiting, an
    // intentional initial render pass (shows the skeleton).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadDrafts();
  }, [loadDrafts]);

  async function removeDraft(id: string) {
    const prev = drafts;
    setDrafts((d) => (d ? d.filter((x) => x.id !== id) : d));
    try {
      const res = await fetch(`/api/drafts/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
    } catch {
      setDrafts(prev); // revert — the delete didn't actually happen
    }
  }

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
    setViewingDrafts(false);
    if (next === state) return;
    setOffset(0);
    setState(next);
  }
  function selectSection(next: number | null) {
    if (next === sectionId) return;
    setOffset(0);
    setSectionId(next);
  }

  // TODO(merge): no merge-listings flow exists yet anywhere in this app —
  // wire this up once there's a spec for what "merge" should do.
  function handleMerge(listing: Listing) {
    console.warn("[listings] Merge is not implemented yet.", listing.listingId);
  }

  // TODO(delete): no endpoint deletes a *live* Etsy listing yet — per
  // memory `live-listing-never-auto-modified`, that needs an explicit,
  // separate opt-in before it's wired up to actually call Etsy.
  function confirmDelete() {
    console.warn("[listings] Delete is not implemented yet.", deleteTarget?.listingId);
    setDeleteTarget(null);
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
            className="mt-4 flex h-10 w-full items-center justify-center rounded-full bg-primary text-sm font-medium text-white transition-colors hover:bg-primary-dark"
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

          <nav className="mt-2 space-y-0.5 border-t border-black/10 pt-2 dark:border-white/15">
            <button
              type="button"
              onClick={() => setViewingDrafts(true)}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                viewingDrafts
                  ? "bg-black text-white dark:bg-white dark:text-black"
                  : "text-zinc-600 hover:bg-black/[.04] dark:text-zinc-400 dark:hover:bg-white/[.06]"
              }`}
            >
              <span>My drafts</span>
              <span className={viewingDrafts ? "opacity-80" : "text-zinc-400"}>
                {drafts ? drafts.length : "…"}
              </span>
            </button>
          </nav>

          {!viewingDrafts && (
            <label className="mt-6 block text-sm">
              <span className="text-xs text-zinc-500">Section</span>
              <select
                value={sectionId ?? ""}
                onChange={(e) => selectSection(e.target.value ? Number(e.target.value) : null)}
                className="mt-1 h-9 w-full rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-primary dark:border-white/15 dark:bg-zinc-950"
              >
                <option value="">All sections</option>
                {(sections ?? []).map((s) => (
                  <option key={s.shopSectionId} value={s.shopSectionId}>
                    {s.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </aside>

        {/* ---- main: table + pagination ---- */}
        <div className="min-w-0 flex-1">
          {viewingDrafts && (
            <>
              {draftsError && (
                <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
                  {draftsError}
                </div>
              )}
              <div className="overflow-x-auto rounded-xl border border-black/10 bg-white dark:border-white/15 dark:bg-zinc-950">
                <table className="w-full min-w-[520px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-black/10 text-xs text-zinc-500 dark:border-white/15">
                      <th className="px-4 py-3 font-medium">Draft</th>
                      <th className="px-4 py-3 font-medium">Last saved</th>
                      <th className="px-4 py-3 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {draftsLoading && !drafts &&
                      Array.from({ length: 3 }).map((_, i) => (
                        <tr key={i} className="border-b border-black/5 last:border-0 dark:border-white/10">
                          <td colSpan={3} className="px-4 py-4">
                            <div className="h-8 w-full animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
                          </td>
                        </tr>
                      ))}

                    {!draftsLoading && !draftsError && (drafts?.length ?? 0) === 0 && (
                      <tr>
                        <td colSpan={3} className="px-4 py-10 text-center text-sm text-zinc-500">
                          No saved drafts. Autosave keeps a copy while you edit a listing — it
                          shows up here.
                        </td>
                      </tr>
                    )}

                    {(drafts ?? []).map((draft) => (
                      <tr key={draft.id} className="border-b border-black/5 last:border-0 dark:border-white/10">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <ListingThumb url={draft.thumbnailUrl} size={40} />
                            <Link
                              href={`/mockups?draftId=${draft.id}`}
                              className="line-clamp-2 max-w-xs text-zinc-800 hover:underline dark:text-zinc-100"
                            >
                              {draft.title}
                            </Link>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                          {formatSavedAt(draft.updatedAt)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1.5">
                            <Link
                              href={`/mockups?draftId=${draft.id}`}
                              className="h-7 whitespace-nowrap rounded-full border border-black/10 px-2.5 text-xs font-medium leading-7 transition-colors hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
                            >
                              Resume editing
                            </Link>
                            <button
                              type="button"
                              onClick={() => removeDraft(draft.id)}
                              className="h-7 whitespace-nowrap rounded-full border border-black/10 px-2.5 text-xs font-medium leading-7 text-red-600 transition-colors hover:bg-red-50 dark:border-white/15 dark:text-red-400 dark:hover:bg-red-950/40"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!viewingDrafts && error && (
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

          {!viewingDrafts && (
          <>
          <div className="overflow-x-auto rounded-xl border border-black/10 bg-white dark:border-white/15 dark:bg-zinc-950">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-black/10 text-xs text-zinc-500 dark:border-white/15">
                  <th className="px-4 py-3 font-medium">Title</th>
                  <th className="px-4 py-3 font-medium">SKU</th>
                  <th className="px-4 py-3 font-medium">Stock</th>
                  <th className="px-4 py-3 font-medium">Price</th>
                  <th className="px-4 py-3 font-medium">Expires on</th>
                  <th className="px-4 py-3 font-medium">Section</th>
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
                    className="group border-b border-black/5 last:border-0 transition-colors hover:bg-zinc-100 dark:border-white/10 dark:hover:bg-white/[.06]"
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
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      <span className="group-hover:invisible">{listing.sku ?? "—"}</span>
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      <span className="group-hover:invisible">{listing.quantity}</span>
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      <span className="group-hover:invisible">{listing.price ?? "—"}</span>
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      <span className="group-hover:invisible">
                        {formatDate(listing.endingTimestampMs)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">
                      {/* Both layers are grid-stacked in the same cell (not
                          display:none) so the column always reserves room for
                          whichever is wider — hovering never resizes it. */}
                      <div className="grid">
                        <span className="col-start-1 row-start-1 truncate group-hover:invisible">
                          {listing.shopSectionId != null
                            ? (sectionTitleById.get(listing.shopSectionId) ?? "—")
                            : "—"}
                        </span>
                        <div className="invisible col-start-1 row-start-1 flex items-center justify-end gap-1 group-hover:visible">
                          <button
                            type="button"
                            title="Delete"
                            aria-label="Delete listing"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteTarget(listing);
                            }}
                            className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-red-100 hover:text-red-700 dark:text-zinc-400 dark:hover:bg-red-950/50 dark:hover:text-red-400"
                          >
                            <Trash2 size={16} />
                          </button>
                          <Link
                            href={editorUrl("copy", listing)}
                            title="Copy to a copy"
                            aria-label="Copy listing to a new draft"
                            onClick={(e) => e.stopPropagation()}
                            className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-black/[.06] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[.1] dark:hover:text-zinc-100"
                          >
                            <Copy size={16} />
                          </Link>
                          <button
                            type="button"
                            title="Merge"
                            aria-label="Merge listing"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMerge(listing);
                            }}
                            className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-black/[.06] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[.1] dark:hover:text-zinc-100"
                          >
                            <Merge size={16} />
                          </button>
                          <Link
                            href={editorUrl("existing", listing)}
                            title="Edit"
                            aria-label="Edit listing"
                            onClick={(e) => e.stopPropagation()}
                            className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-black/[.06] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[.1] dark:hover:text-zinc-100"
                          >
                            <Pencil size={16} />
                          </Link>
                        </div>
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
          </>
          )}
        </div>
      </div>

      {deleteTarget && (
        <DeleteListingModal
          listing={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

/** Confirmation modal for the delete row action. Confirming is currently a
 * TODO (see `confirmDelete`) — no endpoint deletes a live Etsy listing yet. */
function DeleteListingModal({
  listing,
  onCancel,
  onConfirm,
}: {
  listing: Listing;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-listing-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl dark:bg-zinc-950"
      >
        <h2 id="delete-listing-title" className="text-base font-semibold text-black dark:text-zinc-50">
          Delete listing?
        </h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          <span className="line-clamp-2 font-medium text-zinc-800 dark:text-zinc-200">
            {listing.title}
          </span>{" "}
          will be permanently deleted from Etsy. This can&apos;t be undone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-9 rounded-full border border-black/[.08] px-4 text-sm font-medium transition-colors hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-white/[.06]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-9 rounded-full bg-red-600 px-4 text-sm font-medium text-white transition-colors hover:bg-red-700"
          >
            Delete
          </button>
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
