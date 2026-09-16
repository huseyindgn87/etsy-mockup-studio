"use client";

import { useState } from "react";
import {
  addOption,
  removeOption,
  renameOption,
  reorderOption,
  updateCombination,
  type GridOption,
  type VariationGrid,
} from "@/lib/etsy/variation-grid";
import { INPUT_CLS } from "./helpers";
import type { BulkListingDetail, ProcessingProfileOption } from "./types";

const TABS = [
  "Variations",
  "Price",
  "Quantity",
  "SKU",
  "Visibility",
  "Photos",
  "Processing",
] as const;
type Tab = (typeof TABS)[number];

/**
 * Inventory > Variations: one card per listing, with its own tabs. The
 * Variations tab edits the property options themselves (reorder by dragging,
 * rename, remove, and an "Add option" box per property); the other tabs edit
 * one value per combination.
 *
 * Every edit rebuilds the full combination grid (see lib/etsy/variation-grid.ts) —
 * Etsy requires every property-value combination in an inventory write, so a
 * card can never send a partial grid.
 */
export default function VariationsCard({
  listing,
  grid,
  loading,
  processingProfiles,
  onChange,
}: {
  listing: BulkListingDetail;
  /** Null once loading has finished means Etsy wouldn't hand over the inventory. */
  grid: VariationGrid | null;
  loading: boolean;
  processingProfiles: ProcessingProfileOption[];
  onChange: (grid: VariationGrid) => void;
}) {
  const [tab, setTab] = useState<Tab>("Variations");
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [dragging, setDragging] = useState<{ propertyId: number; index: number } | null>(null);

  if (loading) {
    return <p className="text-xs text-zinc-500">Loading variations…</p>;
  }
  if (!grid) {
    return (
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Etsy didn&apos;t return an inventory record for this listing, so its variations can&apos;t be
        edited here.
      </p>
    );
  }
  if (grid.properties.length === 0) {
    return (
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        This listing has no variations. Its price, quantity and SKU are on the Inventory fields.
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-black/10 dark:border-white/15">
      <div
        role="tablist"
        aria-label={`Variation tabs for ${listing.title}`}
        className="flex flex-wrap gap-1 border-b border-black/10 p-1 dark:border-white/15"
      >
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            aria-label={`${name} tab for ${listing.title}`}
            onClick={() => setTab(name)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              tab === name
                ? "bg-black text-white dark:bg-white dark:text-black"
                : "text-zinc-600 hover:bg-black/[.04] dark:text-zinc-400 dark:hover:bg-white/[.06]"
            }`}
          >
            {name}
          </button>
        ))}
      </div>

      <div className="p-3">
        {tab === "Variations" && (
          <div className="space-y-4">
            {grid.properties.map((property) => (
              <div key={property.propertyId}>
                <p className="text-xs font-medium text-zinc-700 dark:text-zinc-200">{property.name}</p>
                <ul className="mt-1 space-y-1">
                  {property.options.map((option, index) => (
                    <li
                      key={`${option.valueId ?? "t"}-${option.name}`}
                      draggable
                      onDragStart={() => setDragging({ propertyId: property.propertyId, index })}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        if (dragging && dragging.propertyId === property.propertyId) {
                          onChange(reorderOption(grid, property.propertyId, dragging.index, index));
                        }
                        setDragging(null);
                      }}
                      className="flex items-center gap-2 rounded-md border border-black/10 px-2 py-1 dark:border-white/15"
                    >
                      <span
                        aria-label={`Reorder ${option.name} on ${listing.title}`}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          // Keyboard equivalent of the drag handle.
                          if (e.key === "ArrowUp" && index > 0) {
                            e.preventDefault();
                            onChange(reorderOption(grid, property.propertyId, index, index - 1));
                          }
                          if (e.key === "ArrowDown" && index < property.options.length - 1) {
                            e.preventDefault();
                            onChange(reorderOption(grid, property.propertyId, index, index + 1));
                          }
                        }}
                        className="cursor-grab select-none px-1 text-zinc-400"
                      >
                        ⠿
                      </span>
                      <input
                        type="text"
                        aria-label={`${property.name} option ${option.name} on ${listing.title}`}
                        defaultValue={option.name}
                        onBlur={(e) => {
                          if (e.target.value.trim() !== option.name) {
                            onChange(renameOption(grid, property.propertyId, option, e.target.value));
                          }
                        }}
                        className="min-w-0 flex-1 border-none bg-transparent text-sm outline-none"
                      />
                      <button
                        type="button"
                        aria-label={`Remove ${option.name} from ${listing.title}`}
                        onClick={() => onChange(removeOption(grid, property.propertyId, option as GridOption))}
                        disabled={property.options.length <= 1}
                        className="text-xs text-zinc-500 hover:text-red-600 disabled:opacity-30"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="mt-1 flex gap-2">
                  <input
                    type="text"
                    aria-label={`Add ${property.name} option to ${listing.title}`}
                    value={drafts[property.propertyId] ?? ""}
                    placeholder="Add option…"
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [property.propertyId]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        onChange(addOption(grid, property.propertyId, drafts[property.propertyId] ?? ""));
                        setDrafts((prev) => ({ ...prev, [property.propertyId]: "" }));
                      }
                    }}
                    className={`${INPUT_CLS} h-8 flex-1`}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      onChange(addOption(grid, property.propertyId, drafts[property.propertyId] ?? ""));
                      setDrafts((prev) => ({ ...prev, [property.propertyId]: "" }));
                    }}
                    className="h-8 rounded-md border border-black/10 px-2 text-xs font-medium hover:bg-black/[.04] dark:border-white/15 dark:hover:bg-white/[.06]"
                  >
                    Add option
                  </button>
                </div>
              </div>
            ))}
            <p className="text-xs text-zinc-500">
              {grid.combinations.length} combination{grid.combinations.length === 1 ? "" : "s"}
            </p>
          </div>
        )}

        {tab === "Photos" && (
          <div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Etsy links a photo to a variation value with its own upload endpoint, which this screen
              doesn&apos;t write — set variation photos in the listing editor.
            </p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {listing.images.slice(0, 6).map((image) => (
                <li key={image.imageId} className="h-14 w-14 overflow-hidden rounded border border-black/10 dark:border-white/15">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image.url} alt="" className="h-full w-full object-cover" />
                </li>
              ))}
            </ul>
          </div>
        )}

        {tab !== "Variations" && tab !== "Photos" && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500">
                <th className="pb-1 font-medium">Combination</th>
                <th className="pb-1 font-medium">{tab}</th>
              </tr>
            </thead>
            <tbody>
              {grid.combinations.map((combination) => {
                const name = combination.values.join(" / ");
                const rowLabel = `${tab} for ${name} on ${listing.title}`;
                return (
                  <tr key={combination.key} className="border-t border-black/5 dark:border-white/10">
                    <td className="py-1 pr-2 text-xs text-zinc-600 dark:text-zinc-300">{name}</td>
                    <td className="py-1">
                      {tab === "Visibility" ? (
                        <label className="flex items-center gap-1.5 text-xs">
                          <input
                            type="checkbox"
                            aria-label={rowLabel}
                            checked={combination.enabled}
                            onChange={(e) =>
                              onChange(
                                updateCombination(grid, combination.key, { enabled: e.target.checked }),
                              )
                            }
                            className="accent-primary"
                          />
                          {combination.enabled ? "Visible" : "Not currently made"}
                        </label>
                      ) : tab === "Processing" ? (
                        <select
                          aria-label={rowLabel}
                          value={combination.readinessStateId ?? ""}
                          onChange={(e) =>
                            onChange(
                              updateCombination(grid, combination.key, {
                                readinessStateId: e.target.value ? Number(e.target.value) : null,
                              }),
                            )
                          }
                          className={`${INPUT_CLS} h-8`}
                        >
                          <option value="">Etsy decides</option>
                          {processingProfiles.map((p) => (
                            <option key={p.readinessStateId} value={p.readinessStateId}>
                              {p.displayLabel || `${p.minProcessingDays}-${p.maxProcessingDays} days`}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          aria-label={rowLabel}
                          type={tab === "SKU" ? "text" : "number"}
                          min="0"
                          step={tab === "Price" ? "0.01" : "1"}
                          value={
                            tab === "Price"
                              ? (combination.price ?? "")
                              : tab === "Quantity"
                                ? combination.quantity
                                : combination.sku
                          }
                          onChange={(e) => {
                            const raw = e.target.value;
                            if (tab === "Price") {
                              onChange(
                                updateCombination(grid, combination.key, {
                                  price: raw === "" ? null : Number(raw),
                                }),
                              );
                            } else if (tab === "Quantity") {
                              onChange(
                                updateCombination(grid, combination.key, {
                                  quantity: raw === "" ? 0 : Math.trunc(Number(raw)),
                                }),
                              );
                            } else {
                              onChange(updateCombination(grid, combination.key, { sku: raw }));
                            }
                          }}
                          className={`${INPUT_CLS} h-8`}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
