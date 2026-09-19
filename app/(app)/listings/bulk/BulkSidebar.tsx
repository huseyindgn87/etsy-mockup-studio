"use client";

import { useState } from "react";
import { BULK_GROUPS } from "@/lib/etsy/bulk-edit";
import type { FieldSelection } from "./types";

/**
 * The bulk editor's left sidebar: AI Edits at the top, visually separated,
 * then the collapsible Media / Listings / Optional / Inventory / Shipping
 * groups. Exactly one field is selected at a time, and the same field can be
 * reached from two groups (Title is in both AI Edits and Listings) — so the
 * selection is a `group:field` pair, not a field alone.
 */
export default function BulkSidebar({
  selection,
  onSelect,
  /** Per-field count of listings with a pending change, for the badges. */
  pendingByField,
}: {
  selection: FieldSelection;
  onSelect: (selection: FieldSelection) => void;
  pendingByField: Partial<Record<string, number>>;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <nav aria-label="Fields" className="space-y-4">
      {BULK_GROUPS.map((group) => {
        const isCollapsed = group.collapsible && collapsed[group.key] === true;
        const headingId = `bulk-group-${group.key}`;
        return (
          <div
            key={group.key}
            className={
              // AI Edits is set apart from the rest, as specified.
              group.collapsible
                ? ""
                : "rounded-xl border border-black/10 bg-white p-2 dark:border-white/15 dark:bg-zinc-950"
            }
          >
            {group.collapsible ? (
              <button
                type="button"
                id={headingId}
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsed((prev) => ({ ...prev, [group.key]: !isCollapsed }))}
                className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 transition-colors hover:text-zinc-800 dark:hover:text-zinc-200"
              >
                {group.label}
                <span aria-hidden className="text-[13px]">
                  {isCollapsed ? "▸" : "▾"}
                </span>
              </button>
            ) : (
              <h2
                id={headingId}
                className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-primary"
              >
                {group.label}
              </h2>
            )}

            {!isCollapsed && (
              <ul className="mt-0.5 space-y-0.5">
                {group.fields.map((field) => {
                  const active = selection.group === group.key && selection.field === field.key;
                  const pending = pendingByField[field.key] ?? 0;
                  return (
                    <li key={`${group.key}:${field.key}`}>
                      <button
                        type="button"
                        aria-current={active ? "true" : undefined}
                        // Title, Description and Tags appear under both AI
                        // Edits and Listings, so the group is part of the
                        // accessible name — otherwise the same name is read
                        // out twice with nothing to tell them apart.
                        aria-label={`${field.label} — ${group.label}`}
                        onClick={() => onSelect({ group: group.key, field: field.key })}
                        className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                          active
                            ? "bg-black text-white dark:bg-white dark:text-black"
                            : "text-zinc-600 hover:bg-black/[.04] dark:text-zinc-400 dark:hover:bg-white/[.06]"
                        }`}
                      >
                        <span>{field.label}</span>
                        {pending > 0 && (
                          <span
                            className={`ml-2 rounded-full px-1.5 text-[13px] font-medium ${
                              active ? "bg-white/20" : "bg-primary/15 text-primary"
                            }`}
                          >
                            {pending}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
