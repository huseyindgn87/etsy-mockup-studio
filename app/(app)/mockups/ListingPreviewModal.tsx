"use client";

import { ChevronLeft, ChevronRight, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** One entry in the preview's thumbnail rail — a listing photo or an uploaded video. */
export interface PreviewMediaItem {
  id: string;
  kind: "photo" | "video";
  url: string | null;
  label: string;
}

/** One variation dropdown — real option names from the editor's Variations tab. */
export interface PreviewVariationDim {
  name: string;
  values: string[];
}

export interface ListingPreviewModalProps {
  title: string;
  description: string;
  /** Already formatted, e.g. "$24.00" or "$18.00+" for a variation price range. */
  priceLabel: string;
  variations: PreviewVariationDim[];
  media: PreviewMediaItem[];
  onClose: () => void;
}

/**
 * A local, read-only render of the current (possibly unsaved) editor state,
 * laid out the way Etsy shows a listing to a buyer. Nothing here is sent to
 * Etsy — it's driven entirely by props from the live form.
 */
export default function ListingPreviewModal({
  title,
  description,
  priceLabel,
  variations,
  media,
  onClose,
}: ListingPreviewModalProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const activeIndexClamped = media.length === 0 ? 0 : Math.min(activeIndex, media.length - 1);
  const active = media[activeIndexClamped] ?? null;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function step(delta: number) {
    if (media.length === 0) return;
    setActiveIndex((i) => (((i + delta) % media.length) + media.length) % media.length);
  }

  const descRef = useRef<HTMLDivElement>(null);
  const [descOverflows, setDescOverflows] = useState(false);
  useEffect(() => {
    const el = descRef.current;
    if (!el) return;
    setDescOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [description]);

  const trimmedDescription = description.trim();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="listing-preview-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-zinc-950"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-black/10 px-5 py-3 dark:border-white/15">
          <h2
            id="listing-preview-title"
            className="text-base font-semibold text-black dark:text-zinc-50"
          >
            Listing preview
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="rounded-full p-1.5 text-zinc-500 transition-colors hover:bg-black/[.06] dark:hover:bg-white/[.1]"
          >
            <X size={18} />
          </button>
        </div>

        <div className="grid flex-1 gap-6 overflow-y-auto p-5 lg:grid-cols-[80px_1fr_300px]">
          {/* ---- left: thumbnail rail ---- */}
          <div className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-y-auto lg:overflow-x-visible">
            {media.length === 0 && <p className="text-xs text-zinc-400">No photos</p>}
            {media.map((m, i) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setActiveIndex(i)}
                aria-current={i === activeIndexClamped}
                aria-label={m.kind === "video" ? `${m.label} (video)` : m.label}
                className={`relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 transition-colors ${
                  i === activeIndexClamped
                    ? "border-[#f56400]"
                    : "border-transparent hover:border-black/10 dark:hover:border-white/15"
                }`}
              >
                {m.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.url} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center bg-zinc-100 text-[10px] text-zinc-400 dark:bg-zinc-900">
                    —
                  </span>
                )}
                {m.kind === "video" && (
                  <span className="absolute inset-0 flex items-center justify-center bg-black/30">
                    <Play size={16} className="fill-white text-white" />
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* ---- center: main image ---- */}
          <div className="relative flex min-h-[320px] items-center justify-center overflow-hidden rounded-lg bg-zinc-100 dark:bg-zinc-900">
            {active ? (
              active.kind === "video" ? (
                active.url ? (
                  <video
                    src={active.url}
                    controls
                    className="max-h-[60vh] max-w-full"
                  />
                ) : (
                  <span className="text-sm text-zinc-400">Video unavailable</span>
                )
              ) : active.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={active.url}
                  alt={active.label}
                  className="max-h-[60vh] max-w-full object-contain"
                />
              ) : (
                <span className="text-sm text-zinc-400">Rendering…</span>
              )
            ) : (
              <span className="text-sm text-zinc-400">No photos yet</span>
            )}

            {media.length > 1 && (
              <>
                <button
                  type="button"
                  onClick={() => step(-1)}
                  aria-label="Previous photo"
                  className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white transition-colors hover:bg-black/60"
                >
                  <ChevronLeft size={20} />
                </button>
                <button
                  type="button"
                  onClick={() => step(1)}
                  aria-label="Next photo"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white transition-colors hover:bg-black/60"
                >
                  <ChevronRight size={20} />
                </button>
              </>
            )}
          </div>

          {/* ---- right: price, title, variations, description ---- */}
          <div className="space-y-3">
            <p className="text-2xl font-medium text-zinc-900 dark:text-zinc-50">{priceLabel}</p>
            <h3 className="text-base font-medium text-zinc-800 dark:text-zinc-100">
              {title.trim() || "Untitled listing"}
            </h3>

            {variations.length > 0 && (
              <div className="space-y-2">
                {variations.map((v, i) => (
                  <label key={`${v.name}-${i}`} className="block text-sm">
                    <span className="text-xs text-zinc-500">
                      {v.name} <span className="text-red-600">*</span>
                    </span>
                    <select
                      disabled
                      defaultValue=""
                      className="mt-1 h-9 w-full rounded-lg border border-black/10 bg-zinc-50 px-2 text-sm text-zinc-500 dark:border-white/15 dark:bg-zinc-900"
                    >
                      <option value="">Select an option</option>
                      {v.values.map((val) => (
                        <option key={val} value={val}>
                          {val}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}

            <div className="border-t border-black/10 pt-3 dark:border-white/15">
              <h4 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                Description
              </h4>
              <div className="relative mt-1">
                <div
                  ref={descRef}
                  className="max-h-40 overflow-hidden whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-400"
                >
                  {trimmedDescription || "No description yet."}
                </div>
                {descOverflows && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-white to-transparent dark:from-zinc-950" />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
