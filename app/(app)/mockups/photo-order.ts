import { MAX_ALT_TEXT_LENGTH } from "@/lib/etsy/listing-image-limits";

/**
 * One photo-grid slot: either a rendered mockup×design combo (identified by a
 * stable `mockupId::designId` key, since indices shift as mockups/designs are
 * added or removed) or a user-uploaded photo (identified by its `OwnImage.id`).
 * `imageOrder` state is a list of these — its order IS the Etsy upload/rank
 * order, slot 0 becoming the listing thumbnail.
 */
export type ImageSlotRef = { kind: "job"; key: string } | { kind: "own"; id: string };

export const jobKey = (mockupId: string, designId: string) => `${mockupId}::${designId}`;
export const slotIdFor = (ref: ImageSlotRef) => (ref.kind === "job" ? `job:${ref.key}` : `own:${ref.id}`);

/** `list` with the item at `from` moved to `to`; the same array back when the move is out of range or a no-op. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Keeps the grid order in sync with what exists: valid refs keep their
 * position, new jobs and own images are appended, refs to something gone are
 * dropped, and jobs the user removed from the grid stay out.
 */
export function reconcileImageOrder(
  prev: ImageSlotRef[],
  jobKeys: string[],
  ownIds: string[],
  removedJobKeys: ReadonlySet<string>,
): ImageSlotRef[] {
  const validJobKeys = new Set(jobKeys.filter((k) => !removedJobKeys.has(k)));
  const validOwnIds = new Set(ownIds);
  const kept = prev.filter((r) => (r.kind === "job" ? validJobKeys.has(r.key) : validOwnIds.has(r.id)));
  const keptIds = new Set(kept.map(slotIdFor));
  const next: ImageSlotRef[] = [
    ...kept,
    ...jobKeys
      .filter((key) => validJobKeys.has(key) && !keptIds.has(`job:${key}`))
      .map((key): ImageSlotRef => ({ kind: "job", key })),
    ...ownIds.filter((id) => !keptIds.has(`own:${id}`)).map((id): ImageSlotRef => ({ kind: "own", id })),
  ];
  if (next.length === prev.length && next.every((r, i) => slotIdFor(r) === slotIdFor(prev[i]))) {
    return prev;
  }
  return next;
}

/** `altTextBySlot` with one slot's alt text set, capped at `MAX_ALT_TEXT_LENGTH`. */
export function withAltText(
  altTextBySlot: Record<string, string>,
  slotId: string,
  text: string,
): Record<string, string> {
  return { ...altTextBySlot, [slotId]: text.slice(0, MAX_ALT_TEXT_LENGTH) };
}

/**
 * The render route's `imageOrder` — each grid slot mapped to the numeric
 * job/own-image index of the payload, in grid order. Jobs are indexed
 * mockup-major (`mockupIndex * designCount + designIndex`).
 */
export function publishImageOrder(
  order: ImageSlotRef[],
  mockupIds: string[],
  designIds: string[],
  ownIds: string[],
): { kind: "job" | "own"; index: number }[] {
  const out: { kind: "job" | "own"; index: number }[] = [];
  for (const ref of order) {
    if (ref.kind === "job") {
      const [mockupId, designId] = ref.key.split("::");
      const i = mockupIds.indexOf(mockupId);
      const k = designIds.indexOf(designId);
      if (i >= 0 && k >= 0) out.push({ kind: "job", index: i * designIds.length + k });
    } else {
      const index = ownIds.indexOf(ref.id);
      if (index >= 0) out.push({ kind: "own", index });
    }
  }
  return out;
}
