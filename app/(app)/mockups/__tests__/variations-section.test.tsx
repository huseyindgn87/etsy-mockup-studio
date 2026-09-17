// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
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

function renderSection(initial: Partial<ListingFormValue> = {}) {
  const current: { value: ListingFormValue } = { value: { ...EMPTY_LISTING_FORM, ...initial } };
  function Harness() {
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
      />
    );
  }
  render(<Harness />);
  return current;
}

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
  it("shows the seven sub-tabs, placeholders for all but Variations, and collapses to the tab bar", () => {
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
    expect(section().getByRole("tabpanel")).toHaveTextContent("Price per combination isn't editable here yet (6 combinations).");
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
