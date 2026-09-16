/**
 * Row selection on the listings table — kept as a pure model so the two
 * select-all modes and the "clears when the filters change" rule are testable
 * without rendering the page.
 *
 * Two things make this more than a `Set<number>`:
 *
 *   - Selection belongs to one filter set. The ids are stamped with the
 *     filters they were chosen under ({@link filterKey}); changing the state
 *     tab or the section drops the selection rather than carrying rows the
 *     user can no longer see into a bulk edit.
 *   - "Select everything matching these filters" is a different promise from
 *     "select the 24 rows on this page". Both end up as explicit ids (so the
 *     count and the bulk screen are exact), but `mode` records which one the
 *     user asked for, so the header can say so.
 *
 * Dependency-free — no React, no fetch.
 */

export interface ListingFilters {
  state: string;
  sectionId: number | null;
}

/** The identity of a filter set. Selection is dropped whenever this changes. */
export function filterKey(filters: ListingFilters): string {
  return `${filters.state}:${filters.sectionId ?? "all"}`;
}

export type SelectionMode = "manual" | "all-matching";

export interface Selection {
  /** The filter set these ids were chosen under. */
  key: string;
  ids: ReadonlySet<number>;
  mode: SelectionMode;
}

export function emptySelection(key: string): Selection {
  return { key, ids: new Set(), mode: "manual" };
}

function withIds(selection: Selection, ids: Set<number>, mode: SelectionMode): Selection {
  return { key: selection.key, ids, mode };
}

/**
 * The selection as it applies to `filters`. Same filters — untouched (so
 * paging through the same filter set keeps every row already ticked);
 * different filters — empty.
 */
export function forFilters(selection: Selection, filters: ListingFilters): Selection {
  const key = filterKey(filters);
  return selection.key === key ? selection : emptySelection(key);
}

export function isSelected(selection: Selection, listingId: number): boolean {
  return selection.ids.has(listingId);
}

export function selectedCount(selection: Selection): number {
  return selection.ids.size;
}

export function selectedIds(selection: Selection): number[] {
  return [...selection.ids];
}

/**
 * Add or remove one row. Removing a row from an "everything matching"
 * selection makes it a manual one again — it is no longer everything.
 */
export function toggleOne(selection: Selection, listingId: number): Selection {
  const ids = new Set(selection.ids);
  if (ids.has(listingId)) {
    ids.delete(listingId);
    return withIds(selection, ids, "manual");
  }
  ids.add(listingId);
  return withIds(selection, ids, selection.mode);
}

/** Every row on the page is ticked. */
export function selectPage(selection: Selection, pageIds: readonly number[]): Selection {
  const ids = new Set(selection.ids);
  for (const id of pageIds) ids.add(id);
  return withIds(selection, ids, selection.mode);
}

/** Every row on the page is unticked; rows selected on other pages stay. */
export function deselectPage(selection: Selection, pageIds: readonly number[]): Selection {
  const ids = new Set(selection.ids);
  for (const id of pageIds) ids.delete(id);
  return withIds(selection, ids, "manual");
}

/**
 * Every listing matching the current filters — `matchingIds` is the full set,
 * resolved by the caller (the listings page fetches the unpaginated list).
 */
export function selectAllMatching(selection: Selection, matchingIds: readonly number[]): Selection {
  return withIds(selection, new Set(matchingIds), "all-matching");
}

export function clear(selection: Selection): Selection {
  return emptySelection(selection.key);
}

export type PageSelectionState = "none" | "some" | "all";

/** Drives the header checkbox: ticked, indeterminate, or empty. */
export function pageSelectionState(
  selection: Selection,
  pageIds: readonly number[],
): PageSelectionState {
  if (pageIds.length === 0) return "none";
  let selected = 0;
  for (const id of pageIds) if (selection.ids.has(id)) selected++;
  if (selected === 0) return "none";
  return selected === pageIds.length ? "all" : "some";
}

/**
 * The header's count line, e.g. `Active — 3 selected`. `stateLabel` is the
 * current tab's own label, so it reads the way the tab does.
 */
export function selectionSummary(selection: Selection, stateLabel: string): string {
  const count = selectedCount(selection);
  return count === 0 ? stateLabel : `${stateLabel} — ${count} selected`;
}
