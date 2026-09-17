import type { TaxonomyNode } from "@/lib/etsy/taxonomy";

/**
 * The Variations section's cascading category dropdowns, as a pure model over
 * Etsy's seller taxonomy tree. The form keeps only the deepest chosen node
 * (`taxonomyId` + `taxonomyPath`); every level above it is its ancestor chain.
 */

export const CASCADE_LABELS = ["Category", "Sub-category", "Group", "Item type"] as const;

export interface IndexedTaxonomyNode {
  node: TaxonomyNode;
  parentId: number | null;
  path: string;
}

export type TaxonomyIndex = ReadonlyMap<number, IndexedTaxonomyNode>;

export function indexTaxonomy(tree: readonly TaxonomyNode[]): TaxonomyIndex {
  const index = new Map<number, IndexedTaxonomyNode>();
  const walk = (nodes: readonly TaxonomyNode[], parentId: number | null, prefix: string) => {
    for (const node of nodes) {
      const path = prefix ? `${prefix} > ${node.name}` : node.name;
      index.set(node.id, { node, parentId, path });
      walk(node.children, node.id, path);
    }
  };
  walk(tree, null, "");
  return index;
}

/** Root-first ids from the top category down to `taxonomyId`; empty when it isn't in the tree. */
export function taxonomyChain(index: TaxonomyIndex, taxonomyId: number | null): number[] {
  const chain: number[] = [];
  let id = taxonomyId;
  while (id != null) {
    const entry = index.get(id);
    if (!entry) return [];
    chain.unshift(id);
    id = entry.parentId;
  }
  return chain;
}

export interface CascadeLevel {
  label: string;
  options: { id: number; name: string }[];
  selectedId: number | null;
  /** Nothing chosen at the level above, or nothing to choose from. */
  disabled: boolean;
}

/**
 * Always the four named levels; a deeper branch of Etsy's tree adds one more
 * dropdown per extra level while there's something below the chosen node.
 */
export function cascadeLevels(
  tree: readonly TaxonomyNode[],
  index: TaxonomyIndex,
  taxonomyId: number | null,
): CascadeLevel[] {
  const chain = taxonomyChain(index, taxonomyId);
  const deepest = chain.length > 0 ? index.get(chain[chain.length - 1])!.node : null;
  const count = Math.max(CASCADE_LABELS.length, chain.length + (deepest && deepest.children.length > 0 ? 1 : 0));
  const levels: CascadeLevel[] = [];
  for (let level = 0; level < count; level++) {
    const parentId = level === 0 ? null : chain[level - 1];
    const children = level === 0 ? tree : parentId != null ? index.get(parentId)!.node.children : [];
    levels.push({
      label: CASCADE_LABELS[Math.min(level, CASCADE_LABELS.length - 1)],
      options: children.map((n) => ({ id: n.id, name: n.name })),
      selectedId: chain[level] ?? null,
      disabled: (level > 0 && parentId == null) || children.length === 0,
    });
  }
  return levels;
}

/**
 * The form's taxonomy after choosing `id` at `level` (or clearing it with
 * null): everything below that level is dropped.
 */
export function selectCascadeLevel(
  index: TaxonomyIndex,
  taxonomyId: number | null,
  level: number,
  id: number | null,
): { taxonomyId: number | null; taxonomyPath: string } {
  const chain = taxonomyChain(index, taxonomyId);
  const next = id ?? (level > 0 ? chain[level - 1] ?? null : null);
  return { taxonomyId: next, taxonomyPath: next != null ? index.get(next)?.path ?? "" : "" };
}
