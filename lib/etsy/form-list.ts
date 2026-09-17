/**
 * How a list reaches Etsy in an `application/x-www-form-urlencoded` body.
 *
 * Etsy's schema types `tags`, `materials`, `production_partner_ids`,
 * `value_ids` and `values` as arrays, but the wire form it documents is "a
 * comma-separated list" in ONE field. Sending repeated params instead
 * (`tags=a&tags=b&tags=c`) is accepted without an error and keeps only the
 * last one, so a listing saved that way quietly ends up with a single tag —
 * every earlier tag, including the ones it already had, gone.
 *
 * None of the values this is used for may contain a comma: Etsy's own
 * validation allows only letters, numbers, whitespace and `-'™©®` in a tag,
 * letters, numbers and whitespace in a material, and the id lists are
 * numeric. A comma is dropped rather than sent, so one bad value can't split
 * into two entries on Etsy's side.
 */
export function joinList(values: readonly string[]): string {
  return values
    .map((value) => value.replaceAll(",", " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(",");
}

/** `joinList` for a numeric id list. */
export function joinIdList(ids: readonly number[]): string {
  return ids.map(String).join(",");
}
