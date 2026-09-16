import { describe, expect, test } from "vitest";
import {
  clear,
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
} from "@/lib/listings/selection";

const ACTIVE: ListingFilters = { state: "active", sectionId: null };
const ACTIVE_SECTION: ListingFilters = { state: "active", sectionId: 7 };
const DRAFT: ListingFilters = { state: "draft", sectionId: null };

const PAGE_ONE = [1, 2, 3];
const PAGE_TWO = [4, 5, 6];
/** Everything matching ACTIVE — two pages' worth plus rows never rendered. */
const ALL_MATCHING = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const start = () => emptySelection(filterKey(ACTIVE));

describe("select all on this page vs. select all matching the filters", () => {
  test("selecting the page takes only the rows on it", () => {
    const selection = selectPage(start(), PAGE_ONE);
    expect(selectedIds(selection)).toEqual(PAGE_ONE);
    expect(selection.mode).toBe("manual");
    expect(isSelected(selection, 4)).toBe(false);
  });

  test("selecting everything matching takes rows the user never paged to", () => {
    const selection = selectAllMatching(start(), ALL_MATCHING);
    expect(selectedCount(selection)).toBe(ALL_MATCHING.length);
    expect(selection.mode).toBe("all-matching");
    expect(isSelected(selection, 9)).toBe(true);
  });

  test("the two modes differ on exactly the rows off this page", () => {
    const page = selectPage(start(), PAGE_ONE);
    const everything = selectAllMatching(start(), ALL_MATCHING);
    expect(selectedCount(page)).toBe(3);
    expect(selectedCount(everything)).toBe(9);
    for (const id of PAGE_ONE) expect(isSelected(page, id)).toBe(isSelected(everything, id));
    for (const id of [4, 5, 6, 7, 8, 9]) {
      expect(isSelected(page, id)).toBe(false);
      expect(isSelected(everything, id)).toBe(true);
    }
  });

  test("unticking one row drops 'everything matching' back to a manual selection", () => {
    const everything = selectAllMatching(start(), ALL_MATCHING);
    const minusOne = toggleOne(everything, 5);
    expect(minusOne.mode).toBe("manual");
    expect(selectedCount(minusOne)).toBe(8);
    expect(isSelected(minusOne, 5)).toBe(false);
  });
});

describe("selection survives pagination within the same filter set", () => {
  test("paging to the next page and selecting it keeps the first page's rows", () => {
    let selection = selectPage(start(), PAGE_ONE);
    selection = forFilters(selection, ACTIVE); // same filters, new page
    selection = selectPage(selection, PAGE_TWO);
    expect(selectedIds(selection).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("clearing one page leaves the other page's rows selected", () => {
    let selection = selectPage(selectPage(start(), PAGE_ONE), PAGE_TWO);
    selection = deselectPage(selection, PAGE_TWO);
    expect(selectedIds(selection)).toEqual(PAGE_ONE);
  });
});

describe("selection clears when the filters change", () => {
  test("switching the state tab drops it", () => {
    const selection = selectAllMatching(start(), ALL_MATCHING);
    const afterTabChange = forFilters(selection, DRAFT);
    expect(selectedCount(afterTabChange)).toBe(0);
    expect(afterTabChange.mode).toBe("manual");
    expect(afterTabChange.key).toBe(filterKey(DRAFT));
  });

  test("choosing a section drops it, even with the same state tab", () => {
    const selection = selectPage(start(), PAGE_ONE);
    expect(selectedCount(forFilters(selection, ACTIVE_SECTION))).toBe(0);
  });

  test("the same filters leave it exactly as it was", () => {
    const selection = selectPage(start(), PAGE_ONE);
    expect(forFilters(selection, ACTIVE)).toBe(selection);
  });

  test("going back to the original filters does not resurrect the old rows", () => {
    let selection = selectPage(start(), PAGE_ONE);
    selection = forFilters(selection, DRAFT);
    selection = forFilters(selection, ACTIVE);
    expect(selectedCount(selection)).toBe(0);
  });
});

describe("header checkbox state", () => {
  test.each([
    ["none", [] as number[], "none"],
    ["some", [1], "some"],
    ["all", PAGE_ONE, "all"],
  ])("%s of the page selected", (_label, chosen, expected) => {
    let selection = start();
    for (const id of chosen as number[]) selection = toggleOne(selection, id);
    expect(pageSelectionState(selection, PAGE_ONE)).toBe(expected);
  });

  test("an empty page is never 'all'", () => {
    expect(pageSelectionState(selectAllMatching(start(), ALL_MATCHING), [])).toBe("none");
  });

  test("rows selected on another page don't make this page look selected", () => {
    const selection = selectPage(start(), PAGE_ONE);
    expect(pageSelectionState(selection, PAGE_TWO)).toBe("none");
  });
});

describe("the header's count line", () => {
  test("reads as the plain tab label with nothing selected", () => {
    expect(selectionSummary(start(), "Active")).toBe("Active");
  });

  test("names the tab and the count once rows are selected", () => {
    expect(selectionSummary(selectPage(start(), PAGE_ONE), "Active")).toBe("Active — 3 selected");
  });

  test("clearing puts it back", () => {
    expect(selectionSummary(clear(selectPage(start(), PAGE_ONE)), "Sold out")).toBe("Sold out");
  });
});

describe("toggling one row", () => {
  test("adds then removes", () => {
    const once = toggleOne(start(), 42);
    expect(isSelected(once, 42)).toBe(true);
    expect(isSelected(toggleOne(once, 42), 42)).toBe(false);
  });

  test("never mutates the selection handed in", () => {
    const before = selectPage(start(), PAGE_ONE);
    const after = toggleOne(before, 99);
    expect(selectedCount(before)).toBe(3);
    expect(selectedCount(after)).toBe(4);
  });
});
