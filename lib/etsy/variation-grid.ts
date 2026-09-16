/**
 * The pure model behind the bulk editor's per-listing Variations card:
 * reordering, adding and removing a property's options, and keeping the
 * combination rows consistent with them.
 *
 * Dependency-free so the card and its tests share exactly one definition of
 * what editing an option does to the grid.
 *
 * Etsy requires *every* property-value combination to be present in an
 * inventory write, so these functions always rebuild the full cross product:
 * a combination that still exists keeps its own price, quantity, SKU,
 * processing profile and visibility, and a newly possible one inherits from
 * the grid's first row rather than from an invented default. Nothing here
 * ever returns an empty grid — removing the last option of a property leaves
 * the grid untouched, because a listing with a variation property and no
 * options is not something Etsy can store.
 */

export interface GridOption {
  /** Null for a free-text value on an otherwise-real Etsy property. */
  valueId: number | null;
  name: string;
}

export interface GridProperty {
  propertyId: number;
  name: string;
  scaleId: number | null;
  options: GridOption[];
}

export interface GridCombination {
  key: string;
  valueIds: (number | null)[];
  values: string[];
  price: number | null;
  quantity: number;
  sku: string;
  enabled: boolean;
  readinessStateId: number | null;
}

export interface VariationGrid {
  listingId: number;
  properties: GridProperty[];
  combinations: GridCombination[];
  priceOnProperty: number[];
  quantityOnProperty: number[];
  skuOnProperty: number[];
  readinessStateOnProperty: number[];
}

/** The joined value ids of one combination — its stable identity across edits. */
export function combinationKey(valueIds: (number | null)[], values: string[]): string {
  return valueIds.map((id, i) => (id == null ? `t:${values[i]}` : String(id))).join(":");
}

function optionKey(option: GridOption): string {
  return option.valueId == null ? `t:${option.name}` : String(option.valueId);
}

/**
 * Rebuild every combination from the current option lists, carrying each
 * existing row's values across by key.
 */
function rebuild(grid: VariationGrid): VariationGrid {
  const existing = new Map(grid.combinations.map((c) => [c.key, c]));
  const template = grid.combinations[0];

  let rows: { valueIds: (number | null)[]; values: string[] }[] = [{ valueIds: [], values: [] }];
  for (const property of grid.properties) {
    const next: typeof rows = [];
    for (const row of rows) {
      for (const option of property.options) {
        next.push({
          valueIds: [...row.valueIds, option.valueId],
          values: [...row.values, option.name],
        });
      }
    }
    rows = next;
  }

  const combinations: GridCombination[] = rows.map((row) => {
    const key = combinationKey(row.valueIds, row.values);
    const kept = existing.get(key);
    if (kept) return { ...kept, key, valueIds: row.valueIds, values: row.values };
    return {
      key,
      valueIds: row.valueIds,
      values: row.values,
      // A brand-new combination inherits the grid's existing terms rather
      // than a made-up price — the seller can still change it before saving.
      price: template?.price ?? null,
      quantity: template?.quantity ?? 0,
      sku: "",
      enabled: true,
      readinessStateId: template?.readinessStateId ?? null,
    };
  });

  return { ...grid, combinations };
}

/** Move one option within its property, then rebuild the rows to match. */
export function reorderOption(
  grid: VariationGrid,
  propertyId: number,
  from: number,
  to: number,
): VariationGrid {
  const properties = grid.properties.map((property) => {
    if (property.propertyId !== propertyId) return property;
    if (from < 0 || to < 0 || from >= property.options.length || to >= property.options.length) {
      return property;
    }
    const options = [...property.options];
    const [moved] = options.splice(from, 1);
    options.splice(to, 0, moved);
    return { ...property, options };
  });
  return rebuild({ ...grid, properties });
}

/**
 * Add an option to a property. A blank name, or one the property already
 * has (case-insensitively), is ignored rather than creating a duplicate
 * Etsy would reject.
 */
export function addOption(grid: VariationGrid, propertyId: number, name: string): VariationGrid {
  const trimmed = name.trim();
  if (!trimmed) return grid;

  let changed = false;
  const properties = grid.properties.map((property) => {
    if (property.propertyId !== propertyId) return property;
    if (property.options.some((o) => o.name.trim().toLowerCase() === trimmed.toLowerCase())) {
      return property;
    }
    changed = true;
    // A value the seller types isn't in Etsy's value list, so it goes as
    // free text (null id) — the same way the listing editor adds one.
    return { ...property, options: [...property.options, { valueId: null, name: trimmed }] };
  });
  return changed ? rebuild({ ...grid, properties }) : grid;
}

/**
 * Remove one option. Refuses to remove a property's last option: Etsy has no
 * representation for a variation property with nothing to choose from, and
 * silently dropping the property would rewrite the listing's whole structure.
 */
export function removeOption(
  grid: VariationGrid,
  propertyId: number,
  option: GridOption,
): VariationGrid {
  const target = grid.properties.find((p) => p.propertyId === propertyId);
  if (!target || target.options.length <= 1) return grid;

  const properties = grid.properties.map((property) =>
    property.propertyId === propertyId
      ? { ...property, options: property.options.filter((o) => optionKey(o) !== optionKey(option)) }
      : property,
  );
  return rebuild({ ...grid, properties });
}

/** Rename an option in place, keeping its position and its row's values. */
export function renameOption(
  grid: VariationGrid,
  propertyId: number,
  option: GridOption,
  name: string,
): VariationGrid {
  const trimmed = name.trim();
  if (!trimmed) return grid;
  const properties = grid.properties.map((property) =>
    property.propertyId === propertyId
      ? {
          ...property,
          options: property.options.map((o) =>
            optionKey(o) === optionKey(option) ? { ...o, name: trimmed } : o,
          ),
        }
      : property,
  );
  return rebuild({ ...grid, properties });
}

/** Change one combination's own price/quantity/SKU/visibility/processing profile. */
export function updateCombination(
  grid: VariationGrid,
  key: string,
  patch: Partial<Omit<GridCombination, "key" | "valueIds" | "values">>,
): VariationGrid {
  return {
    ...grid,
    combinations: grid.combinations.map((c) => (c.key === key ? { ...c, ...patch } : c)),
  };
}

/**
 * The grid as the save request carries it. `price`/`quantity` fall back to
 * the listing's own values in lib/etsy/bulk-apply.ts when a row has none.
 */
export function toVariationPatch(grid: VariationGrid): {
  products: {
    propertyValues: { propertyId: number; name: string; valueIds: (number | null)[]; values: string[] }[];
    price?: number;
    quantity?: number;
    sku?: string;
    readinessStateId?: number;
    enabled: boolean;
  }[];
  priceOnProperty: number[];
  quantityOnProperty: number[];
  skuOnProperty: number[];
  readinessStateOnProperty: number[];
} {
  return {
    products: grid.combinations.map((combination) => ({
      propertyValues: grid.properties.map((property, index) => ({
        propertyId: property.propertyId,
        name: property.name,
        valueIds: [combination.valueIds[index]],
        values: [combination.values[index]],
      })),
      price: combination.price ?? undefined,
      quantity: combination.quantity,
      sku: combination.sku || undefined,
      readinessStateId: combination.readinessStateId ?? undefined,
      enabled: combination.enabled,
    })),
    priceOnProperty: grid.priceOnProperty,
    quantityOnProperty: grid.quantityOnProperty,
    skuOnProperty: grid.skuOnProperty,
    readinessStateOnProperty: grid.readinessStateOnProperty,
  };
}
