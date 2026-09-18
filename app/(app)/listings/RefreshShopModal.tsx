"use client";

import { useEffect, useRef, useState } from "react";
import { waitForJob } from "@/lib/jobs/client";
import { describeJob } from "@/lib/jobs/describe";

export interface ShopConnectionSummary {
  shopId: string;
  shopName: string;
  shopIconUrl: string | null;
  active: boolean;
}

type SyncStage = "listings" | "saving" | "inventory";

type RefreshProgressEvent =
  | { type: "status"; stage?: SyncStage; message: string }
  | { type: "progress"; stage: SyncStage; fetched: number; total: number; message: string }
  | { type: "done"; inserted: number; updated: number; removed: number; total: number; resumed: number }
  | { type: "error"; message: string }
  /** The refresh job is waiting for a worker — `message` says its place in line. */
  | { type: "queued"; jobId: string; position: number | null; message: string }
  /** The stream stopped following a job that's still going; poll it by id. */
  | { type: "pending"; jobId: string; message: string };

const STAGES: { id: SyncStage; label: string }[] = [
  { id: "listings", label: "Fetching listings" },
  { id: "saving", label: "Saving listings" },
  { id: "inventory", label: "Fetching variations" },
];

type Phase = "refreshing" | "error";

/**
 * Blocking modal for the listings page's on-demand "Refresh" action. Opens
 * already refreshing the active shop, reads `POST /api/etsy/shops/refresh`'s
 * newline-delimited JSON progress stream to drive the live status line (the
 * refresh is a queued job: while it waits, the line says its place in line;
 * a stream that ends before the job does is followed by polling), and
 * closes itself (calling `onRefreshed`) the moment a `"done"` event arrives.
 * The bottom "Switch shop" dropdown re-runs the same stream against a
 * different shop without leaving the modal.
 */
export default function RefreshShopModal({
  open,
  onClose,
  onRefreshed,
}: {
  open: boolean;
  onClose: () => void;
  onRefreshed: () => void;
}) {
  const [shops, setShops] = useState<ShopConnectionSummary[] | null>(null);
  const [phase, setPhase] = useState<Phase>("refreshing");
  const [statusMessage, setStatusMessage] = useState("Preparing to refresh");
  const [stage, setStage] = useState<SyncStage>("listings");
  const [fetched, setFetched] = useState(0);
  const [total, setTotal] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [targetShopId, setTargetShopId] = useState<string | undefined>(undefined);
  const runIdRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    fetch("/api/etsy/shops")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { shops?: ShopConnectionSummary[] } | null) => setShops(body?.shops ?? []))
      .catch(() => setShops([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Modal just opened — reset to the active shop and kick off its refresh.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTargetShopId(undefined);
    void runRefresh(undefined);
    // `runRefresh` is intentionally omitted — it's stable across renders in
    // effect but re-running this on every render (its natural identity
    // changes each render) would restart the refresh; only a real modal
    // open/close should.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function runRefresh(shopId: string | undefined) {
    const runId = ++runIdRef.current;
    setPhase("refreshing");
    setStatusMessage("Preparing to refresh");
    setStage("listings");
    setFetched(0);
    setTotal(0);
    setErrorMessage(null);

    let pendingJobId: string | null = null;
    const applyEvent = (event: RefreshProgressEvent) => {
      if (runIdRef.current !== runId) return; // superseded by a newer run (shop switch / retry)
      if (event.type === "queued") {
        setStatusMessage(event.message);
      } else if (event.type === "pending") {
        pendingJobId = event.jobId;
        setStatusMessage(event.message);
      } else if (event.type === "status") {
        if (event.stage) setStage(event.stage);
        setStatusMessage(event.message);
      } else if (event.type === "progress") {
        setStage(event.stage);
        setFetched(event.fetched);
        setTotal(event.total);
        setStatusMessage(event.message);
      } else if (event.type === "done") {
        onRefreshed();
        onClose();
      } else {
        setPhase("error");
        setErrorMessage(event.message);
      }
    };

    try {
      const res = await fetch("/api/etsy/shops/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(shopId ? { shopId } : {}),
      });
      if (!res.body) throw new Error("No response from server.");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.trim()) applyEvent(JSON.parse(line) as RefreshProgressEvent);
        }
      }
      if (buffer.trim()) applyEvent(JSON.parse(buffer) as RefreshProgressEvent);

      if (pendingJobId) {
        const job = await waitForJob(pendingJobId, {
          onStatus: (j) => {
            if (runIdRef.current !== runId) return;
            setStatusMessage(describeJob(j));
            if (j.progress?.done != null && j.progress.total != null) {
              setFetched(j.progress.done);
              setTotal(j.progress.total);
            }
          },
        });
        if (runIdRef.current !== runId) return;
        if (job.status === "done") applyEvent({ type: "done", inserted: 0, updated: 0, removed: 0, total: 0, resumed: 0 });
        else applyEvent({ type: "error", message: job.error || "Refresh failed." });
      }
    } catch (err) {
      if (runIdRef.current !== runId) return;
      setPhase("error");
      setErrorMessage(err instanceof Error ? err.message : "Refresh failed.");
    }
  }

  const CONNECT_NEW = "__connect_new__";

  function handleShopSelect(value: string) {
    if (value === CONNECT_NEW) {
      // A full navigation, not a Next.js page — this Route Handler starts
      // the Etsy OAuth redirect, so client-side routing doesn't apply.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = "/api/auth/etsy/login";
      return;
    }
    setTargetShopId(value || undefined);
    void runRefresh(value || undefined);
  }

  if (!open) return null;

  const stageIndex = Math.max(0, STAGES.findIndex((s) => s.id === stage));
  const activeShop = shops?.find((s) => s.shopId === targetShopId) ?? shops?.find((s) => s.active) ?? null;
  const otherShops = (shops ?? []).filter((s) => s.shopId !== (activeShop?.shopId ?? ""));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="refresh-shop-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
    >
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl dark:bg-zinc-950">
        <div className="flex flex-col items-center text-center">
          {activeShop?.shopIconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={activeShop.shopIconUrl}
              alt=""
              className="h-12 w-12 rounded-full object-cover"
            />
          ) : (
            <div className="h-12 w-12 rounded-full bg-zinc-100 dark:bg-zinc-800" />
          )}
          <p className="mt-2 text-sm font-medium text-zinc-600 dark:text-zinc-400">
            {activeShop?.shopName ?? "Your shop"}
          </p>

          <h2 id="refresh-shop-title" className="mt-3 text-base font-semibold text-black dark:text-zinc-50">
            Refreshing shop
          </h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            The time this takes will depend on the number of listings in your shop.
          </p>

          {phase === "refreshing" && (
            <>
              <div
                role="status"
                aria-label="Refreshing"
                className="mt-5 h-8 w-8 animate-spin rounded-full border-2 border-zinc-300 border-t-primary dark:border-zinc-700"
              />
              <p className="mt-3 text-xs font-medium uppercase tracking-wide text-zinc-500">
                Step {stageIndex + 1} of {STAGES.length} · {STAGES[stageIndex].label}
              </p>
              <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{statusMessage}</p>
              {total > 0 && (
                <div
                  role="progressbar"
                  aria-label={STAGES[stageIndex].label}
                  aria-valuemin={0}
                  aria-valuemax={total}
                  aria-valuenow={fetched}
                  className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width]"
                    style={{ width: `${Math.min(100, Math.round((fetched / total) * 100))}%` }}
                  />
                </div>
              )}
            </>
          )}

          {phase === "error" && (
            <div className="mt-5 w-full">
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
                {errorMessage ?? "Something went wrong."}
              </p>
              <div className="mt-3 flex justify-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="h-9 rounded-full border border-black/[.08] px-4 text-sm font-medium transition-colors hover:bg-black/[.04] dark:border-white/[.145] dark:hover:bg-white/[.06]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => runRefresh(targetShopId)}
                  className="h-9 rounded-full bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-dark"
                >
                  Retry
                </button>
              </div>
            </div>
          )}
        </div>

        {shops != null && (
          <label className="mt-6 block text-sm">
            <span className="text-xs text-zinc-500">Switch shop</span>
            <select
              value=""
              disabled={phase === "refreshing"}
              onChange={(e) => handleShopSelect(e.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-black/10 bg-white px-2 text-sm outline-none focus:border-primary disabled:opacity-50 dark:border-white/15 dark:bg-zinc-950"
            >
              <option value="">{activeShop?.shopName ?? "Current shop"}</option>
              {otherShops.map((s) => (
                <option key={s.shopId} value={s.shopId}>
                  {s.shopName}
                </option>
              ))}
              <option value={CONNECT_NEW}>+ Connect another shop</option>
            </select>
          </label>
        )}
      </div>
    </div>
  );
}
