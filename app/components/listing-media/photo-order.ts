import { MAX_ALT_TEXT_LENGTH } from "@/lib/etsy/listing-image-limits";

/**
 * One photo-grid slot: a rendered mockup×design combo (identified by a
 * stable `mockupId::designId` key, since indices shift as mockups/designs are
 * added or removed), a user-uploaded photo (identified by its `OwnImage.id`),
 * or a photo already on the Etsy listing being edited (its `listing_image_id`).
 * `imageOrder` state is a list of these — its order IS the Etsy upload/rank
 * order, slot 0 becoming the listing thumbnail.
 */
export type ImageSlotRef =
  | { kind: "job"; key: string }
  | { kind: "own"; id: string }
  | { kind: "etsy"; imageId: number };

export const jobKey = (mockupId: string, designId: string) => `${mockupId}::${designId}`;
export const slotIdFor = (ref: ImageSlotRef) =>
  ref.kind === "job" ? `job:${ref.key}` : ref.kind === "own" ? `own:${ref.id}` : `etsy:${ref.imageId}`;

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
 * dropped, and jobs (or Etsy photos) the user removed from the grid stay out.
 * A listing's Etsy photos arrive in rank order and go first while the grid
 * holds none of them yet — they are slots 1..n on the live listing. Until
 * they have loaded (`etsyImageIds` null) Etsy refs are kept as they are.
 */
export function reconcileImageOrder(
  prev: ImageSlotRef[],
  jobKeys: string[],
  ownIds: string[],
  removedJobKeys: ReadonlySet<string>,
  etsyImageIds: number[] | null = null,
  removedEtsyImageIds: ReadonlySet<number> = new Set(),
): ImageSlotRef[] {
  const validJobKeys = new Set(jobKeys.filter((k) => !removedJobKeys.has(k)));
  const validOwnIds = new Set(ownIds);
  const validEtsyIds = new Set((etsyImageIds ?? []).filter((id) => !removedEtsyImageIds.has(id)));
  const kept = prev.filter((r) =>
    r.kind === "job"
      ? validJobKeys.has(r.key)
      : r.kind === "own"
        ? validOwnIds.has(r.id)
        : etsyImageIds === null || validEtsyIds.has(r.imageId),
  );
  const keptIds = new Set(kept.map(slotIdFor));
  const newEtsy = (etsyImageIds ?? [])
    .filter((id) => validEtsyIds.has(id) && !keptIds.has(`etsy:${id}`))
    .map((imageId): ImageSlotRef => ({ kind: "etsy", imageId }));
  const etsyFirst = !kept.some((r) => r.kind === "etsy");
  const next: ImageSlotRef[] = [
    ...(etsyFirst ? newEtsy : []),
    ...kept,
    ...(etsyFirst ? [] : newEtsy),
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

export type PublishOrderEntry =
  | { kind: "job" | "own"; index: number }
  | { kind: "etsy"; imageId: number; altText: string };

/**
 * The render route's `imageOrder` — each grid slot mapped to the numeric
 * job/own-image index of the payload, in grid order. Jobs are indexed
 * mockup-major (`mockupIndex * designCount + designIndex`). A photo already
 * on the listing is sent by its Etsy id, with its (possibly edited) alt text.
 */
export function publishImageOrder(
  order: ImageSlotRef[],
  mockupIds: string[],
  designIds: string[],
  ownIds: string[],
  altTextBySlot: Record<string, string> = {},
): PublishOrderEntry[] {
  const out: PublishOrderEntry[] = [];
  for (const ref of order) {
    if (ref.kind === "etsy") {
      out.push({ kind: "etsy", imageId: ref.imageId, altText: altTextBySlot[slotIdFor(ref)] ?? "" });
    } else if (ref.kind === "job") {
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
