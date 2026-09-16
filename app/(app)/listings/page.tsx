"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CalendarClock,
  ChevronDown,
  Copy,
  Download,
  Pencil,
  RefreshCw,
  Share2,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DraftSummary } from "@/lib/drafts/types";
import {
  deselectPage,
  emptySelection,
  filterKey,
  forFilters,
  isSelected,
  pageSelectionState,
  selectAllMatching,
  selectPage,
  selectedCount,
  selectedIds,
  selectionSummary,
  toggleOne,
  type ListingFilters,
  type Selection,
} from "@/lib/listings/selection";
import { SIDEBAR_ID, useSidebar } from "../SidebarContext";
import RefreshShopModal from "./RefreshShopModal";

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
  neverSynced?: boolean;
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

async function errorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error || `Request failed (${res.status})`;
}

/** One CSV field — quoted, with embedded quotes doubled. */
function csvCell(value: string | number | null): string {
  const s = value == null ? "" : String(value);
  return `"${s.replaceAll('"', '""')}"`;
}

export default function ListingsPage() {
  const { open: sidebarOpen } = useSidebar();
  const router = useRouter();
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
  const [deleteTargets, setDeleteTargets] = useState<Listing[] | null>(null);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [rawSelection, setRawSelection] = useState<Selection>(() =>
    emptySelection(filterKey({ state: "active", sectionId: null })),
  );
  const [selectMenuOpen, setSelectMenuOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Bumped after a successful shop refresh to force the counts + listings
  // effects below to re-fetch from the (now updated) DB-backed cache.
  const [dataVersion, setDataVersion] = useState(0);

  const filters: ListingFilters = useMemo(() => ({ state, sectionId }), [state, sectionId]);
  /**
   * Selection as it applies to the filters showing right now. Derived rather
   * than reset in an effect, so changing the state tab or the section drops
   * the selection in the very same render the new filters appear in — there's
   * never a frame where a stale count is on screen.
   */
  const selection = useMemo(() => forFilters(rawSelection, filters), [rawSelection, filters]);
  const selectedListingIds = useMemo(() => selectedIds(selection), [selection]);
  const count = selectedCount(selection);

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
  }, [dataVersion]);

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

  /** Every listing matching the current filters, unpaginated — for "select all matching" and Export. */
  const fetchAllMatching = useCallback(async (): Promise<Listing[]> => {
    const params = new URLSearchParams({ state, all: "true" });
    const res = await fetch(`/api/etsy/listings?${params.toString()}`);
    if (!res.ok) throw new Error(await errorFrom(res));
    const whole = (await res.json()) as ListingsPage;
    return sectionId == null
      ? whole.listings
      : whole.listings.filter((l) => l.shopSectionId === sectionId);
  }, [state, sectionId]);

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
    // `dataVersion` isn't read in the body — it's here purely to bust this
    // callback's identity after a shop refresh, so the effect below re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, sectionId, offset, dataVersion],
  );

  useEffect(() => {
    const controller = new AbortController();
    // `load` flips loading/error state before awaiting; that initial render pass
    // is intentional (it shows the skeleton / clears a stale error).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function handleRefreshed() {
    setDataVersion((v) => v + 1);
    setRawSelection((s) => emptySelection(s.key));
  }

  /**
   * Changing a filter drops the selection for real, not just for display.
   * Deriving it through `forFilters` alone would only *hide* it while the new
   * filters are showing and hand the old rows straight back the moment the
   * user returned to the original tab.
   */
  function resetSelectionFor(next: ListingFilters) {
    setRawSelection(emptySelection(filterKey(next)));
  }

  function selectState(next: ListingState) {
    setViewingDrafts(false);
    if (next === state) return;
    setOffset(0);
    setState(next);
    resetSelectionFor({ state: next, sectionId });
  }
  function selectSection(next: number | null) {
    if (next === sectionId) return;
    setOffset(0);
    setSectionId(next);
    resetSelectionFor({ state, sectionId: next });
  }

  const total = data?.count ?? 0;
  const listings = useMemo(() => data?.listings ?? [], [data]);
  const pageIds = useMemo(() => listings.map((l) => l.listingId), [listings]);
  const showingFrom = total === 0 ? 0 : offset + 1;
  const showingTo = Math.min(offset + PAGE_SIZE, total);
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;
  const headerState = pageSelectionState(selection, pageIds);

  const sectionTitleById = useMemo(() => {
    const m = new Map<number, string>();
    for (const s of sections ?? []) m.set(s.shopSectionId, s.title);
    return m;
  }, [sections]);

  const stateLabel = STATE_TABS.find((t) => t.value === state)?.label ?? "Listings";

  function toggleHeaderCheckbox() {
    setRawSelection(
      headerState === "all" ? deselectPage(selection, pageIds) : selectPage(selection, pageIds),
    );
  }

  async function handleSelectAllMatching() {
    setSelectMenuOpen(false);
    setNotice(null);
    try {
      const all = await fetchAllMatching();
      setRawSelection(selectAllMatching(selection, all.map((l) => l.listingId)));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Couldn't select every matching listing.");
    }
  }

  /** Export — built in the browser from the listings themselves; nothing is sent anywhere. */
  async function handleExport() {
    setBulkBusy(true);
    setNotice(null);
    try {
      const all = await fetchAllMatching();
      const chosen = all.filter((l) => isSelected(selection, l.listingId));
      const header = ["Listing ID", "Title", "SKU", "State", "Price", "Quantity", "Section", "URL"];
      const rows = chosen.map((l) => [
        csvCell(l.listingId),
        csvCell(l.title),
        csvCell(l.sku),
        csvCell(l.state),
        csvCell(l.price),
        csvCell(l.quantity),
        csvCell(l.shopSectionId != null ? (sectionTitleById.get(l.shopSectionId) ?? "") : ""),
        csvCell(l.url),
      ]);
      const csv = [header.map(csvCell).join(","), ...rows.map((r) => r.join(","))].join("\r\n");
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `listings-${state}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      setNotice(`Exported ${chosen.length} listing${chosen.length === 1 ? "" : "s"}.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBulkBusy(false);
    }
  }

  /** Copy — creates a draft per listing. Never touches the live listings. */
  async function handleCopy() {
    setBulkBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/etsy/listings/bulk/copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingIds: selectedListingIds }),
      });
      if (!res.ok) throw new Error(await errorFrom(res));
      const body = (await res.json()) as { copied: number };
      setNotice(
        `Created ${body.copied} draft${body.copied === 1 ? "" : "s"} — find them under My drafts.`,
      );
      loadDrafts();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Copy failed.");
    } finally {
      setBulkBusy(false);
    }
  }

  function handleBulkEdit() {
    router.push(`/listings/bulk?ids=${selectedListingIds.join(",")}`);
  }

  async function confirmDelete() {
    const targets = deleteTargets ?? [];
    setBulkBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/etsy/listings/bulk/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingIds: targets.map((l) => l.listingId) }),
      });
      if (!res.ok) throw new Error(await errorFrom(res));
      const body = (await res.json()) as {
        deleted: number;
        failed: number;
        results: { listingId: number; ok: boolean; error?: string }[];
      };
      const firstError = body.results.find((r) => !r.ok)?.error;
      setNotice(
        body.failed === 0
          ? `Deleted ${body.deleted} listing${body.deleted === 1 ? "" : "s"}.`
          : `Deleted ${body.deleted}, ${body.failed} failed${firstError ? ` — ${firstError}` : "."}`,
      );
      setDeleteTargets(null);
      setRawSelection((s) => emptySelection(s.key));
      setDataVersion((v) => v + 1);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Delete failed.");
      setDeleteTargets(null);
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8 lg:flex-row">
        {/* ---- left sidebar: state + section filters (collapsed from the top bar's toggle) ---- */}
        <aside id={SIDEBAR_ID} hidden={!sidebarOpen} className="lg:w-56 lg:shrink-0">
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

          <div className="mt-6 flex items-center justify-between">
            <span className="text-xs text-zinc-500">Status</span>
            <button
              type="button"
              title="Refresh shop from Etsy"
              aria-label="Refresh shop from Etsy"
              onClick={() => setRefreshOpen(true)}
              className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-black/[.06] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[.1] dark:hover:text-zinc-100"
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <nav className="mt-1 space-y-0.5">
            {STATE_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => selectState(tab.value)}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  state === tab.value && !viewingDrafts
                    ? "bg-black text-white dark:bg-white dark:text-black"
                    : "text-zinc-600 hover:bg-black/[.04] dark:text-zinc-400 dark:hover:bg-white/[.06]"
                }`}
              >
                <span>{tab.label}</span>
                <span className={state === tab.value && !viewingDrafts ? "opacity-80" : "text-zinc-400"}>
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
            <Link
              href="/schedule"
              className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-zinc-600 transition-colors hover:bg-black/[.04] dark:text-zinc-400 dark:hover:bg-white/[.06]"
            >
              <span>Schedule</span>
              <CalendarClock size={14} aria-hidden className="text-zinc-400" />
            </Link>
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
          {/* ---- header: selection count + the actions it enables ---- */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100" aria-live="polite">
              {selectionSummary(selection, stateLabel)}
            </h2>
            {count > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={() =>
                    setDeleteTargets(listings.filter((l) => isSelected(selection, l.listingId)))
                  }
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-black/10 px-3 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40 dark:border-white/15 dark:text-red-400 dark:hover:bg-red-950/40"
                >
                  <Trash2 size={14} aria-hidden /> Delete
                </button>
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={handleExport}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-black/10 px-3 text-xs font-medium transition-colors hover:bg-black/[.04] disabled:opacity-40 dark:border-white/15 dark:hover:bg-white/[.06]"
                >
                  <Download size={14} aria-hidden /> Export
                </button>
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={handleCopy}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-black/10 px-3 text-xs font-medium transition-colors hover:bg-black/[.04] disabled:opacity-40 dark:border-white/15 dark:hover:bg-white/[.06]"
                >
                  <Copy size={14} aria-hidden /> Copy
                </button>
                <button
                  type="button"
                  disabled={bulkBusy}
                  onClick={handleBulkEdit}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-3 text-xs font-medium text-white transition-colors hover:bg-primary-dark disabled:opacity-40"
                >
                  <Pencil size={14} aria-hidden /> Edit
                </button>
              </div>
            )}
          </div>

          {notice && (
            <div
              role="status"
              className="mb-3 rounded-xl border border-black/10 bg-white px-4 py-2 text-sm text-zinc-700 dark:border-white/15 dark:bg-zinc-950 dark:text-zinc-300"
            >
              {notice}
            </div>
          )}

          <div className="overflow-x-auto rounded-xl border border-black/10 bg-white dark:border-white/15 dark:bg-zinc-950">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead>
                <tr className="border-b border-black/10 text-xs text-zinc-500 dark:border-white/15">
                  <th className="w-12 px-4 py-3 font-medium">
                    <div className="relative flex items-center gap-1">
                      <input
                        type="checkbox"
                        aria-label="Select all on this page"
                        checked={headerState === "all"}
                        ref={(el) => {
                          if (el) el.indeterminate = headerState === "some";
                        }}
                        onChange={toggleHeaderCheckbox}
                        className="h-4 w-4 cursor-pointer accent-primary"
                      />
                      <button
                        type="button"
                        aria-label="Selection options"
                        aria-expanded={selectMenuOpen}
                        onClick={() => setSelectMenuOpen((o) => !o)}
                        className="rounded p-0.5 text-zinc-400 transition-colors hover:bg-black/[.06] hover:text-zinc-700 dark:hover:bg-white/[.1]"
                      >
                        <ChevronDown size={14} aria-hidden />
                      </button>
                      {selectMenuOpen && (
                        <div className="absolute left-0 top-7 z-20 w-64 overflow-hidden rounded-lg border border-black/10 bg-white py-1 shadow-lg dark:border-white/15 dark:bg-zinc-900">
                          <button
                            type="button"
                            onClick={() => {
                              setRawSelection(selectPage(selection, pageIds));
                              setSelectMenuOpen(false);
                            }}
                            className="block w-full px-3 py-2 text-left text-xs font-normal text-zinc-700 transition-colors hover:bg-black/[.04] dark:text-zinc-200 dark:hover:bg-white/[.06]"
                          >
                            Select all on this page ({pageIds.length})
                          </button>
                          <button
                            type="button"
                            onClick={handleSelectAllMatching}
                            className="block w-full px-3 py-2 text-left text-xs font-normal text-zinc-700 transition-colors hover:bg-black/[.04] dark:text-zinc-200 dark:hover:bg-white/[.06]"
                          >
                            Select all {total} matching these filters
                          </button>
                        </div>
                      )}
                    </div>
                  </th>
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
                      <td colSpan={7} className="px-4 py-4">
                        <div className="h-8 w-full animate-pulse rounded bg-zinc-100 dark:bg-zinc-900" />
                      </td>
                    </tr>
                  ))}

                {!loading && !error && listings.length === 0 && data?.neverSynced && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-sm text-zinc-500">
                      This shop hasn&apos;t been synced from Etsy yet.{" "}
                      <button
                        type="button"
                        onClick={() => setRefreshOpen(true)}
                        className="font-medium text-primary underline underline-offset-2"
                      >
                        Refresh now
                      </button>{" "}
                      to load your listings.
                    </td>
                  </tr>
                )}

                {!loading && !error && listings.length === 0 && !data?.neverSynced && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-sm text-zinc-500">
                      No {stateLabel.toLowerCase()} listings found.
                    </td>
                  </tr>
                )}

                {listings.map((listing) => (
                  <tr
                    key={listing.listingId}
                    className={`group border-b border-black/5 last:border-0 transition-colors dark:border-white/10 ${
                      isSelected(selection, listing.listingId)
                        ? "bg-primary/[.06]"
                        : "hover:bg-zinc-100 dark:hover:bg-white/[.06]"
                    }`}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${listing.title}`}
                        checked={isSelected(selection, listing.listingId)}
                        onChange={() => setRawSelection(toggleOne(selection, listing.listingId))}
                        className="h-4 w-4 cursor-pointer accent-primary"
                      />
                    </td>
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
                            aria-label={`Delete ${listing.title}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDeleteTargets([listing]);
                            }}
                            className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-red-100 hover:text-red-700 dark:text-zinc-400 dark:hover:bg-red-950/50 dark:hover:text-red-400"
                          >
                            <Trash2 size={16} />
                          </button>
                          <Link
                            href={editorUrl("copy", listing)}
                            title="Copy to a new draft"
                            aria-label={`Copy ${listing.title}`}
                            onClick={(e) => e.stopPropagation()}
                            className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-black/[.06] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[.1] dark:hover:text-zinc-100"
                          >
                            <Copy size={16} />
                          </Link>
                          <button
                            type="button"
                            title="Copy link"
                            aria-label={`Share ${listing.title}`}
                            onClick={async (e) => {
                              e.stopPropagation();
                              try {
                                await navigator.clipboard.writeText(listing.url);
                                setNotice("Listing link copied.");
                              } catch {
                                setNotice(listing.url);
                              }
                            }}
                            className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-black/[.06] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[.1] dark:hover:text-zinc-100"
                          >
                            <Share2 size={16} />
                          </button>
                          <Link
                            href={editorUrl("existing", listing)}
                            title="Edit"
                            aria-label={`Edit ${listing.title}`}
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

      {deleteTargets && deleteTargets.length > 0 && (
        <DeleteListingsModal
          listings={deleteTargets}
          busy={bulkBusy}
          onCancel={() => setDeleteTargets(null)}
          onConfirm={confirmDelete}
        />
      )}

      <RefreshShopModal
        open={refreshOpen}
        onClose={() => setRefreshOpen(false)}
        onRefreshed={handleRefreshed}
      />
    </div>
  );
}

/**
 * Confirmation for deleting listings — one row's icon or the header's bulk
 * action, both land here. Always states how many listings it affects, since
 * the deletion is permanent on Etsy and can't be undone from this app.
 */
function DeleteListingsModal({
  listings,
  busy,
  onCancel,
  onConfirm,
}: {
  listings: Listing[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const many = listings.length > 1;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-listing-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={busy ? undefined : onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl dark:bg-zinc-950"
      >
        <h2 id="delete-listing-title" className="text-base font-semibold text-black dark:text-zinc-50">
          {many ? `Delete ${listings.length} listings?` : "Delete listing?"}
        </h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          {many ? (
            <>
              <span className="font-medium text-zinc-800 dark:text-zinc-200">
                {listings.length} listings
              </span>{" "}
              will be permanently deleted from Etsy. This can&apos;t be undone.
            </>
          ) : (
            <>
              <span className="line-clamp-2 font-medium text-zinc-800 dark:text-zinc-200">
                {listings[0].title}
              </span>{" "}
              will be permanently deleted from Etsy. This can&apos;t be undone.
            </>
          )}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-9 rounded-full border border-black/[.08] px-4 text-sm font-medium transition-colors hover:bg-black/[.04] disabled:opacity-40 dark:border-white/[.145] dark:hover:bg-white/[.06]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="h-9 rounded-full bg-red-600 px-4 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-60"
          >
            {busy ? "Deleting…" : many ? `Delete ${listings.length}` : "Delete"}
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
