// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import type { TaxonomyNode, TaxonomyProperty } from "@/lib/etsy/taxonomy";
import { EMPTY_LISTING_FORM, type ListingFormValue } from "../ListingForm";
import VariationsSection from "../VariationsSection";

function node(id: number, name: string, parentId: number | null, children: TaxonomyNode[] = []): TaxonomyNode {
  return { id, level: 1, name, parentId, children };
}

const TREE: TaxonomyNode[] = [
  node(1, "Clothing", null, [
    node(2, "Gender-Neutral Adult Clothing", 1, [
      node(3, "Tops & Tees", 2, [node(482, "T-shirts", 3), node(483, "Tank Tops", 3)]),
      node(4, "Hoodies & Sweatshirts", 2, [node(490, "Hoodies", 4)]),
    ]),
  ]),
  node(10, "Home & Living", null, [node(11, "Wall Decor", 10)]),
];

function property(propertyId: number, displayName: string, values: [number, string][]): TaxonomyProperty {
  return {
    propertyId,
    name: displayName.toLowerCase(),
    displayName,
    isRequired: false,
    isMultivalued: false,
    maxValuesAllowed: null,
    supportsAttributes: false,
    supportsVariations: true,
    scales: [],
    possibleValues: values.map(([valueId, name]) => ({ valueId, name, scaleId: null })),
  };
}

const PROPERTIES = [
  property(100, "Size", [
    [11, "S"],
    [12, "M"],
    [13, "L"],
  ]),
  property(200, "Primary color", [
    [21, "Black"],
    [22, "White"],
  ]),
];

const T_SHIRTS = "Clothing > Gender-Neutral Adult Clothing > Tops & Tees > T-shirts";

function renderSection(initial: Partial<ListingFormValue> = {}, extra: Partial<SectionExtras> = {}) {
  const current: { value: ListingFormValue } = { value: { ...EMPTY_LISTING_FORM, ...initial } };
  function Harness(props: Partial<SectionExtras>) {
    const [value, setValue] = useState(current.value);
    return (
      <VariationsSection
        value={value}
        patch={(partial) =>
          setValue((prev) => {
            current.value = { ...prev, ...partial };
            return current.value;
          })
        }
        taxonomyTree={TREE}
        taxonomyError={null}
        variationProperties={value.taxonomyId === 482 ? PROPERTIES : []}
        propertiesLoading={false}
        propertiesError={null}
        {...props}
      />
    );
  }
  const { rerender } = render(<Harness {...extra} />);
  return Object.assign(current, { rerender: (next: Partial<SectionExtras>) => rerender(<Harness {...next} />) });
}

type SectionExtras = Pick<
  ComponentProps<typeof VariationsSection>,
  "processingProfiles" | "photoSlots" | "currencyCode" | "showErrors" | "errorJump"
>;

const section = () => within(screen.getByRole("region", { name: "Variations" }));
const combo = (name: string) => section().getByRole("combobox", { name });
const optionNames = (list: string) =>
  within(section().getByRole("list", { name: `${list} options` }))
    .getAllByRole("listitem")
    .map((li) => li.querySelector("span")!.textContent);

function addOption(column: string, name: string) {
  fireEvent.change(section().getByLabelText(`New ${column} option`), { target: { value: name } });
  fireEvent.click(section().getByRole("button", { name: `Add ${column} option` }));
}

/** Size (S, M, L) × Primary color (Black, White) on T-shirts. */
function sizeByColor(extra: Partial<ListingFormValue> = {}): Partial<ListingFormValue> {
  return {
    taxonomyId: 482,
    taxonomyPath: T_SHIRTS,
    variations: [
      { propertyId: 100, name: "Size", isCustom: false, valueIds: [11, 12, 13], values: ["S", "M", "L"], linksPhotos: false },
      { propertyId: 200, name: "Primary color", isCustom: false, valueIds: [21, 22], values: ["Black", "White"], linksPhotos: false },
    ],
    ...extra,
  };
}

describe("Variations section — taxonomy cascade", () => {
  it("enables each level only once the level above is chosen", () => {
    const state = renderSection();
    expect(combo("Category")).toBeEnabled();
    expect(combo("Sub-category")).toBeDisabled();
    expect(combo("Group")).toBeDisabled();
    expect(combo("Item type")).toBeDisabled();

    fireEvent.change(combo("Category"), { target: { value: "1" } });
    expect(combo("Sub-category")).toBeEnabled();
    expect(combo("Group")).toBeDisabled();
    fireEvent.change(combo("Sub-category"), { target: { value: "2" } });
    fireEvent.change(combo("Group"), { target: { value: "3" } });
    fireEvent.change(combo("Item type"), { target: { value: "482" } });

    expect(state.value.taxonomyId).toBe(482);
    expect(state.value.taxonomyPath).toBe(T_SHIRTS);
    expect(within(combo("Item type")).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Choose item type",
      "T-shirts",
      "Tank Tops",
    ]);
  });

  it("clears the levels below when a level changes", () => {
    const state = renderSection({ taxonomyId: 482, taxonomyPath: T_SHIRTS });
    expect(combo("Item type")).toHaveValue("482");

    fireEvent.change(combo("Group"), { target: { value: "4" } });
    expect(state.value.taxonomyId).toBe(4);
    expect(combo("Group")).toHaveValue("4");
    expect(combo("Item type")).toHaveValue("");
    expect(combo("Item type")).toBeEnabled();

    fireEvent.change(combo("Category"), { target: { value: "10" } });
    expect(state.value.taxonomyPath).toBe("Home & Living");
    expect(combo("Sub-category")).toHaveValue("");
    expect(combo("Group")).toBeDisabled();
  });

  it("offers the chosen leaf's variation properties", () => {
    renderSection({ taxonomyId: 482, taxonomyPath: T_SHIRTS });
    expect(within(combo("First variation")).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Choose Variation",
      "Size",
      "Primary color",
      "Create your own…",
    ]);
  });
});

describe("Variations section — tabs and columns", () => {
  it("shows the seven sub-tabs and collapses to the tab bar", () => {
    renderSection(sizeByColor());
    const tabs = section().getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual([
      "Variations",
      "Price",
      "Quantity",
      "SKU",
      "Visibility",
      "Photos",
      "Processing",
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.click(section().getByRole("tab", { name: "Price" }));
    expect(section().getByRole("checkbox", { name: "Individual price (Size)" })).not.toBeChecked();
    fireEvent.keyDown(section().getByRole("tab", { name: "Price" }), { key: "ArrowRight" });
    expect(section().getByRole("tab", { name: "Quantity" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(section().getByRole("button", { name: "Show less" }));
    expect(section().queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(section().queryByRole("combobox", { name: "Category" })).not.toBeInTheDocument();
    expect(section().getAllByRole("tab")).toHaveLength(7);
    fireEvent.click(section().getByRole("button", { name: "Show more" }));
    expect(section().getByRole("tabpanel")).toBeInTheDocument();
  });

  it("shows placeholders for empty columns", () => {
    renderSection({ taxonomyId: 482, taxonomyPath: T_SHIRTS });
    expect(combo("First variation")).toHaveValue("");
    expect(combo("Second variation")).toBeDisabled();
    expect(section().getByText("No third variation")).toBeInTheDocument();
    expect(section().getByRole("button", { name: "Delete first variation" })).toBeDisabled();
  });

  it("chooses a property, then adds values from Etsy's list or as free text", () => {
    const state = renderSection({ taxonomyId: 482, taxonomyPath: T_SHIRTS });
    fireEvent.change(combo("First variation"), { target: { value: "p100" } });
    addOption("Size", "m");
    addOption("Size", "S");
    addOption("Size", "Tall");
    addOption("Size", "tall");

    expect(optionNames("Size")).toEqual(["M", "S", "Tall"]);
    expect(state.value.variations[0]).toMatchObject({ propertyId: 100, valueIds: [12, 11, -1] });
    expect(combo("Second variation")).toBeEnabled();
    expect(within(combo("Second variation")).queryByRole("option", { name: "Size" })).not.toBeInTheDocument();

    fireEvent.change(combo("Second variation"), { target: { value: "p200" } });
    const input = section().getByRole("combobox", { name: "New Primary color option" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "Black" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(optionNames("Primary color")).toEqual(["Black"]);
    expect(section().getByText(/^3 combinations/)).toBeInTheDocument();
  });

  it("removes a value with no data without asking", () => {
    const state = renderSection(sizeByColor());
    fireEvent.click(section().getByRole("button", { name: "Remove M" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(optionNames("Size")).toEqual(["S", "L"]);
    expect(state.value.variations[0].valueIds).toEqual([11, 13]);
  });

  it("reorders values by dragging within a column, never across columns", () => {
    const state = renderSection(sizeByColor());
    const items = () => within(section().getByRole("list", { name: "Size options" })).getAllByRole("listitem");

    fireEvent.dragStart(items()[2]);
    fireEvent.dragOver(items()[0]);
    fireEvent.drop(items()[0]);
    expect(optionNames("Size")).toEqual(["L", "S", "M"]);
    expect(state.value.variations[0].valueIds).toEqual([13, 11, 12]);

    const colors = within(section().getByRole("list", { name: "Primary color options" })).getAllByRole("listitem");
    fireEvent.dragStart(items()[0]);
    fireEvent.drop(colors[1]);
    expect(optionNames("Size")).toEqual(["L", "S", "M"]);
    expect(optionNames("Primary color")).toEqual(["Black", "White"]);
  });

  it("reorders values from the keyboard", () => {
    const state = renderSection(sizeByColor());
    fireEvent.keyDown(section().getByRole("button", { name: "Move S" }), { key: "ArrowDown" });
    expect(optionNames("Size")).toEqual(["M", "S", "L"]);
    fireEvent.keyDown(section().getByRole("button", { name: "Move L" }), { key: "ArrowUp" });
    expect(state.value.variations[0].values).toEqual(["M", "L", "S"]);
  });

  it("deleting a column shifts the next one left", () => {
    const state = renderSection(sizeByColor());
    fireEvent.click(section().getByRole("button", { name: "Delete first variation" }));
    expect(combo("First variation")).toHaveValue("p200");
    expect(combo("Second variation")).toHaveValue("");
    expect(state.value.variations.map((v) => v.name)).toEqual(["Primary color"]);
  });

  it("creates a custom variation with its own name", () => {
    const state = renderSection({ taxonomyId: 482, taxonomyPath: T_SHIRTS });
    fireEvent.change(combo("First variation"), { target: { value: "custom" } });
    fireEvent.change(section().getByRole("textbox", { name: "First variation name" }), { target: { value: "Paper" } });
    addOption("Paper", "Matte");
    expect(state.value.variations[0]).toMatchObject({ propertyId: 513, isCustom: true, name: "Paper", valueIds: [1] });
  });
});

describe("Variations section — destructive changes", () => {
  const withPrices = () =>
    sizeByColor({
      variationToggles: {
        ...EMPTY_LISTING_FORM.variationToggles,
        price: { enabled: true, appliesTo: [0] },
        sku: { enabled: true, appliesTo: [0, 1] },
      },
      variationRows: {
        ...EMPTY_LISTING_FORM.variationRows,
        price: { "11": "20.00", "12": "22.00" },
        sku: { "11:21": "S-BLK" },
      },
    });

  it("warns before removing a value whose combinations carry data, and keeps it on Cancel", () => {
    const state = renderSection(withPrices());
    fireEvent.click(section().getByRole("button", { name: "Remove S" }));

    const dialog = screen.getByRole("alertdialog", { name: "Delete combination data?" });
    expect(dialog).toHaveTextContent("Removing “S” deletes 2 combinations with price or SKU data.");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(optionNames("Size")).toEqual(["S", "M", "L"]);
    expect(state.value.variationRows.price).toEqual({ "11": "20.00", "12": "22.00" });
  });

  it("applies the removal and drops its data on Delete", () => {
    const state = renderSection(withPrices());
    fireEvent.click(section().getByRole("button", { name: "Remove S" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));

    expect(optionNames("Size")).toEqual(["M", "L"]);
    expect(state.value.variationRows.price).toEqual({ "12": "22.00" });
    expect(state.value.variationRows.sku).toEqual({});
  });

  it("doesn't warn when the removed value has no data", () => {
    renderSection(withPrices());
    fireEvent.click(section().getByRole("button", { name: "Remove L" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(optionNames("Size")).toEqual(["S", "M"]);
  });

  it("warns before removing a property or changing the category", () => {
    const state = renderSection(withPrices());
    fireEvent.click(section().getByRole("button", { name: "Delete second variation" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "Removing “Primary color” deletes 1 combination with SKU data.",
    );
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(state.value.variations).toHaveLength(2);

    fireEvent.change(combo("Item type"), { target: { value: "483" } });
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "Changing the category deletes 4 combinations with price or SKU data.",
    );
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    expect(state.value.taxonomyId).toBe(483);
    expect(state.value.variations).toEqual([]);
  });

  it("never warns when reordering", () => {
    renderSection(withPrices());
    fireEvent.keyDown(section().getByRole("button", { name: "Move S" }), { key: "ArrowDown" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(optionNames("Size")).toEqual(["M", "S", "L"]);
  });
});

function openTab(name: string) {
  fireEvent.click(section().getByRole("tab", { name }));
}

const rowsOf = (table: string) =>
  within(section().getByRole("table", { name: table }))
    .getAllByRole("row")
    .slice(1);

const PROFILES = [
  { readinessStateId: 1, readinessState: "made_to_order" as const, minProcessingDays: 1, maxProcessingDays: 3, displayLabel: "1-3 days" },
  { readinessStateId: 2, readinessState: "made_to_order" as const, minProcessingDays: 3, maxProcessingDays: 5, displayLabel: "3-5 days" },
];

describe("Variations section — per-combination tabs", () => {
  it("an Individual price checkbox turns one listing-wide price into a row per option", () => {
    const state = renderSection(sizeByColor({ price: "10" }), { currencyCode: "USD" });
    openTab("Price");
    expect(section().getByLabelText("Price for every combination")).toHaveValue("10");

    fireEvent.click(section().getByRole("checkbox", { name: "Individual price (Primary color)" }));
    expect(state.value.variationToggles.price).toEqual({ enabled: true, appliesTo: [1] });
    expect(rowsOf("Price per combination").map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual(["Black", "White"]);
    expect(section().getByLabelText("Price for Black")).toHaveValue("10");
    expect(section().getAllByText("$")).toHaveLength(2);

    fireEvent.click(section().getByRole("checkbox", { name: "Individual price (Size)" }));
    expect(rowsOf("Price per combination")).toHaveLength(6);
    expect(section().getByLabelText("Price for M / White")).toHaveValue("10");
  });

  it("warns before unchecking discards different values, and keeps them on Cancel", () => {
    const state = renderSection(
      sizeByColor({
        variationToggles: { ...EMPTY_LISTING_FORM.variationToggles, price: { enabled: true, appliesTo: [0] } },
        variationRows: { ...EMPTY_LISTING_FORM.variationRows, price: { "11": "12.00", "12": "15.00", "13": "12.00" } },
      }),
    );
    openTab("Price");
    fireEvent.click(section().getByRole("checkbox", { name: "Individual price (Size)" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(
      "Turning off individual price for “Size” keeps one price per merged row and discards 1 different price.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(state.value.variationToggles.price.appliesTo).toEqual([0]);
    expect(section().getByRole("checkbox", { name: "Individual price (Size)" })).toBeChecked();

    fireEvent.click(section().getByRole("checkbox", { name: "Individual price (Size)" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    expect(state.value.variationToggles.price).toEqual({ enabled: false, appliesTo: [] });
    expect(state.value.price).toBe("12.00");
    expect(section().getByLabelText("Price for every combination")).toHaveValue("12.00");
  });

  it("price and quantity inputs refuse negatives and extra decimals; price is padded to two decimals", () => {
    const state = renderSection(
      sizeByColor({ variationToggles: { ...EMPTY_LISTING_FORM.variationToggles, price: { enabled: true, appliesTo: [0] }, quantity: { enabled: true, appliesTo: [0] } } }),
    );
    openTab("Price");
    const s = section().getByLabelText("Price for S");
    fireEvent.change(s, { target: { value: "-4" } });
    fireEvent.change(s, { target: { value: "4.567" } });
    expect(state.value.variationRows.price["11"]).toBeUndefined();
    fireEvent.change(s, { target: { value: "4.5" } });
    fireEvent.blur(s);
    expect(state.value.variationRows.price["11"]).toBe("4.50");

    openTab("Quantity");
    const q = section().getByLabelText("Quantity for M");
    fireEvent.change(q, { target: { value: "-1" } });
    fireEvent.change(q, { target: { value: "1.5" } });
    fireEvent.change(q, { target: { value: "0" } });
    expect(state.value.variationRows.quantity["12"]).toBe("0");
  });

  it("virtualizes a 450-row grid and edits one row without touching the rest", () => {
    const state = renderSection({
      taxonomyId: 482,
      taxonomyPath: T_SHIRTS,
      variations: [
        { propertyId: 513, name: "Style", isCustom: true, valueIds: Array.from({ length: 45 }, (_, i) => i + 1), values: Array.from({ length: 45 }, (_, i) => `Comfort C Shirt ${i}`), linksPhotos: false },
        { propertyId: 200, name: "Primary color", isCustom: false, valueIds: Array.from({ length: 10 }, (_, i) => i + 101), values: Array.from({ length: 10 }, (_, i) => `Color ${i}`), linksPhotos: false },
      ],
      variationToggles: { ...EMPTY_LISTING_FORM.variationToggles, sku: { enabled: true, appliesTo: [0, 1] } },
    });
    openTab("SKU");
    const table = section().getByRole("table", { name: "SKU per combination" });
    expect(table).toHaveAttribute("aria-rowcount", "451");
    const rendered = rowsOf("SKU per combination");
    expect(rendered.length).toBeGreaterThan(5);
    expect(rendered.length).toBeLessThan(30);

    fireEvent.change(section().getByLabelText("SKU for Comfort C Shirt 0 / Color 1"), { target: { value: "ABC" } });
    expect(state.value.variationRows.sku).toEqual({ "1:102": "ABC" });
  });

  it("the bulk bar applies to every row shown, respecting the filter", () => {
    const state = renderSection(
      sizeByColor({
        variationToggles: { ...EMPTY_LISTING_FORM.variationToggles, price: { enabled: true, appliesTo: [0, 1] } },
        variationRows: { ...EMPTY_LISTING_FORM.variationRows, price: { "11:21": "10.00", "11:22": "10.00", "12:21": "11.00" } },
        price: "9.00",
      }),
    );
    openTab("Price");
    fireEvent.change(section().getByLabelText("Filter combinations"), { target: { value: "black" } });
    expect(rowsOf("Price per combination")).toHaveLength(3);
    fireEvent.change(section().getByLabelText("Bulk operation"), { target: { value: "increasePercent" } });
    fireEvent.change(section().getByLabelText("Bulk amount"), { target: { value: "10" } });
    fireEvent.click(section().getByRole("button", { name: "Apply" }));
    expect(state.value.variationRows.price).toEqual({
      "11:21": "11.00",
      "11:22": "10.00",
      "12:21": "12.10",
      "13:21": "9.90",
    });
    expect(section().getByRole("status")).toHaveTextContent("Applied to 3 of 3 rows.");

    fireEvent.change(section().getByLabelText("Bulk operation"), { target: { value: "decrease" } });
    fireEvent.change(section().getByLabelText("Bulk amount"), { target: { value: "20" } });
    fireEvent.click(section().getByRole("button", { name: "Apply" }));
    expect(section().getByRole("alert")).toHaveTextContent("That would make 3 prices negative — nothing was changed.");
    expect(state.value.variationRows.price["11:21"]).toBe("11.00");
  });

  it("the processing bulk bar sets a profile on every shown row", () => {
    const state = renderSection(
      sizeByColor({ variationToggles: { ...EMPTY_LISTING_FORM.variationToggles, readiness: { enabled: true, appliesTo: [0] } } }),
      { processingProfiles: PROFILES },
    );
    openTab("Processing");
    fireEvent.change(section().getByLabelText("Bulk amount"), { target: { value: "2" } });
    fireEvent.click(section().getByRole("button", { name: "Apply" }));
    expect(state.value.variationRows.readiness).toEqual({ "11": "2", "12": "2", "13": "2" });
    expect(section().getByLabelText("Processing profile for L")).toHaveValue("2");
  });

  it("the SKU pattern generator fills every row in one action", () => {
    const state = renderSection(
      sizeByColor({ variationToggles: { ...EMPTY_LISTING_FORM.variationToggles, sku: { enabled: true, appliesTo: [0, 1] } } }),
    );
    openTab("SKU");
    fireEvent.change(section().getByLabelText("SKU pattern"), { target: { value: "TEE-{Size}-{Primary color}-{##}" } });
    fireEvent.click(section().getByRole("button", { name: "Generate SKUs" }));
    expect(Object.values(state.value.variationRows.sku)).toEqual([
      "TEE-S-Black-01",
      "TEE-S-White-02",
      "TEE-M-Black-03",
      "TEE-M-White-04",
      "TEE-L-Black-05",
      "TEE-L-White-06",
    ]);
    expect(section().getByLabelText("SKU for L / White")).toHaveValue("TEE-L-White-06");

    fireEvent.change(section().getByLabelText("SKU pattern"), { target: { value: "{Fabric}" } });
    fireEvent.click(section().getByRole("button", { name: "Generate SKUs" }));
    expect(section().getByRole("alert")).toHaveTextContent("Unknown token {Fabric}.");
  });

  it("Visibility hides a combination, which stays greyed in the other tabs with its data", () => {
    const state = renderSection(
      sizeByColor({
        variationToggles: { ...EMPTY_LISTING_FORM.variationToggles, price: { enabled: true, appliesTo: [0, 1] } },
        variationRows: { ...EMPTY_LISTING_FORM.variationRows, price: { "12:22": "18.00" } },
      }),
    );
    openTab("Visibility");
    expect(rowsOf("Visibility per combination")).toHaveLength(6);
    fireEvent.click(section().getByRole("switch", { name: "Offer M / White" }));
    expect(state.value.variationRowEnabled).toEqual({ "12:22": false });
    expect(section().getByRole("switch", { name: "Offer M / White" })).toHaveAttribute("aria-checked", "false");

    openTab("Price");
    const row = rowsOf("Price per combination").find((r) => r.textContent?.includes("(hidden)"))!;
    expect(row).toHaveTextContent("M");
    expect(within(row).getByLabelText("Price for M / White")).toHaveValue("18.00");

    openTab("Visibility");
    fireEvent.click(section().getByRole("switch", { name: "Offer M / White" }));
    expect(state.value.variationRowEnabled).toEqual({});
    expect(state.value.variationRows.price["12:22"]).toBe("18.00");
  });

  it("Photos assigns on one variation only, one row per option, and warns before moving it", () => {
    const photoSlots = [
      { slotId: "job:a", thumbnailUrl: null, label: "Front" },
      { slotId: "own:b", thumbnailUrl: null, label: "Back" },
    ];
    const state = renderSection(sizeByColor(), { photoSlots });
    openTab("Photos");
    expect(section().getAllByRole("combobox", { name: "Photos vary by" })).toHaveLength(1);
    expect(section().queryByRole("table")).not.toBeInTheDocument();

    fireEvent.change(section().getByRole("combobox", { name: "Photos vary by" }), { target: { value: "1" } });
    expect(state.value.variations.map((v) => v.linksPhotos)).toEqual([false, true]);
    expect(rowsOf("Photo per Primary color").map((r) => r.querySelector("span")!.textContent)).toEqual(["Black", "White"]);

    fireEvent.click(section().getByRole("button", { name: "Photo 2 for White" }));
    expect(state.value.variationPhotos).toEqual({ "22": "own:b" });
    expect(section().getByRole("button", { name: "Photo 2 for White" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.change(section().getByRole("combobox", { name: "Photos vary by" }), { target: { value: "0" } });
    expect(screen.getByRole("alertdialog")).toHaveTextContent("discards 1 photo assignment");
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    expect(state.value.variations.map((v) => v.linksPhotos)).toEqual([true, false]);
    expect(state.value.variationPhotos).toEqual({});
    expect(rowsOf("Photo per Size")).toHaveLength(3);
  });

  it("removing a value with an assigned photo asks first", () => {
    renderSection(
      sizeByColor({
        variations: sizeByColor().variations!.map((v, i) => ({ ...v, linksPhotos: i === 1 })),
        variationPhotos: { "21": "job:a" },
      }),
    );
    fireEvent.click(section().getByRole("button", { name: "Remove Black" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Removing “Black” deletes 1 photo assignment.");
  });

  it("marks errored rows and tabs, and a refused publish jumps to the first error", () => {
    const initial = sizeByColor({
      price: "",
      variationToggles: { ...EMPTY_LISTING_FORM.variationToggles, quantity: { enabled: true, appliesTo: [0] }, price: { enabled: true, appliesTo: [1] } },
      variationRows: { ...EMPTY_LISTING_FORM.variationRows, price: { "21": "5.00" }, quantity: { "11": "1", "12": "1", "13": "1" } },
    });
    const state = renderSection(initial);
    expect(section().getByRole("tab", { name: "Price" })).not.toHaveTextContent("!");

    state.rerender({ showErrors: true, errorJump: 1 });
    expect(section().getByRole("tab", { name: "Price, has errors" })).toHaveAttribute("aria-selected", "true");
    expect(section().getByRole("tab", { name: "Quantity" })).toBeInTheDocument();
    const white = section().getByLabelText("Price for White");
    expect(white).toHaveAttribute("aria-invalid", "true");
    expect(white.closest('[role="row"]')).toHaveAttribute("data-error", "true");
    expect(section().getByText("Enter a price.")).toBeInTheDocument();
    expect(section().getByLabelText("Price for Black")).not.toHaveAttribute("aria-invalid");

    fireEvent.change(white, { target: { value: "7" } });
    expect(section().getByRole("tab", { name: "Price" })).toBeInTheDocument();
    expect(white).not.toHaveAttribute("aria-invalid");
  });
});

/** Size (5 options) × Primary color (2) = 10 combinations, priced individually. */
function tenRows(extra: Partial<ListingFormValue> = {}): Partial<ListingFormValue> {
  return {
    taxonomyId: 482,
    taxonomyPath: T_SHIRTS,
    variations: [
      { propertyId: 100, name: "Size", isCustom: false, valueIds: [11, 12, 13, 14, 15], values: ["S", "M", "L", "XL", "2XL"], linksPhotos: false },
      { propertyId: 200, name: "Primary color", isCustom: false, valueIds: [21, 22], values: ["Black", "White"], linksPhotos: false },
    ],
    variationToggles: { ...EMPTY_LISTING_FORM.variationToggles, price: { enabled: true, appliesTo: [0, 1] } },
    ...extra,
  };
}

const showMore = () => section().getByRole("button", { name: /^Show more rows/ });

describe("Variations section — collapsed combination table", () => {
  it("renders the first 6 rows, reports the hidden count, and expands and collapses again", () => {
    renderSection(tenRows({ price: "9.00" }));
    openTab("Price");
    expect(rowsOf("Price per combination")).toHaveLength(6);
    expect(showMore()).toHaveTextContent("Show more (4 more)");

    fireEvent.click(showMore());
    expect(rowsOf("Price per combination")).toHaveLength(10);

    fireEvent.click(section().getByRole("button", { name: "Show less rows" }));
    expect(rowsOf("Price per combination")).toHaveLength(6);
    expect(showMore()).toHaveTextContent("Show more (4 more)");
  });

  it("shows no button when the table has 6 rows or fewer", () => {
    renderSection(
      sizeByColor({ variationToggles: { ...EMPTY_LISTING_FORM.variationToggles, price: { enabled: true, appliesTo: [0, 1] } } }),
    );
    openTab("Price");
    expect(rowsOf("Price per combination")).toHaveLength(6);
    expect(section().queryByRole("button", { name: /^Show more rows/ })).not.toBeInTheDocument();
    expect(section().queryByRole("button", { name: "Show less rows" })).not.toBeInTheDocument();
  });

  it("expands itself when a refused publish jumps to a collapsed row", () => {
    const priced = Object.fromEntries(
      [11, 12, 13, 14, 15].flatMap((s) => [21, 22].map((c) => [`${s}:${c}`, "9.00"])),
    );
    delete priced["15:22"];
    const state = renderSection(tenRows({ price: "", variationRows: { ...EMPTY_LISTING_FORM.variationRows, price: priced } }));
    openTab("Price");
    expect(rowsOf("Price per combination")).toHaveLength(6);

    state.rerender({ showErrors: true, errorJump: 1 });
    expect(rowsOf("Price per combination")).toHaveLength(10);
    expect(section().getByLabelText("Price for 2XL / White")).toHaveAttribute("aria-invalid", "true");
  });

  it("keeps hidden rows in the form: they take bulk edits, and edits after expanding are saved", () => {
    const state = renderSection(tenRows({ price: "10.00" }));
    openTab("Price");
    expect(rowsOf("Price per combination")).toHaveLength(6);

    fireEvent.change(section().getByLabelText("Bulk amount"), { target: { value: "5.00" } });
    fireEvent.click(section().getByRole("button", { name: "Apply" }));
    expect(section().getByRole("status")).toHaveTextContent("Applied to 10 of 10 rows.");
    expect(state.value.variationRows.price["15:22"]).toBe("5.00");

    fireEvent.click(showMore());
    fireEvent.change(section().getByLabelText("Price for 2XL / White"), { target: { value: "12.00" } });
    fireEvent.click(section().getByRole("button", { name: "Show less rows" }));
    expect(state.value.variationRows.price["15:22"]).toBe("12.00");
  });
});
