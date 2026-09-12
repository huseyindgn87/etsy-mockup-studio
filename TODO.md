# etsy-mockup-studio — pending tasks

Work through these one at a time, in order. After each task:
`tsc --noEmit`, `eslint .`, `next build`, full `vitest`. Show output.
Do not commit until I say so.

---

## 1. Settings section

Add a `Settings` entry to the left-hand nav (after Shipping), mirroring
Etsy's own Settings tab on the listing editor. Fields:

- **Shop section** — dropdown listing the connected shop's sections,
  fetched from `getShopSections`. Helper text: "Use shop sections to
  organize your products into groups shoppers can explore." Sent as
  `shop_section_id` on listing create/update.
- **Feature this listing** — toggle. Helper text: "Showcase this listing
  at the top of your shop home to make it stand out."
- **Etsy Ads** — toggle. Helper text: "Promote this listing on Etsy as
  part of your Etsy Ads campaign."
- **Renewal options** (required) — radio pair, Automatic (default) /
  Manual. Helper text: "Each renewal lasts for four months or until the
  listing sells out." Maps to `should_auto_renew`.

If any of these have no Open API equivalent, say so explicitly instead
of faking the field — do not silently drop it from the payload.

## 2. Move the variations list out of the modal

Once variations are saved, render them in the Variations page itself —
the wide empty area — not inside the modal. The page shows the variation
list, the vary-by toggles, the counters, the bulk enable/disable
controls and the full combination grid, with room to breathe.

The modal stays only for adding or editing a single variation (the
picker and the custom-variation editor). Saving closes it and returns to
the page.

## 3. Video upload

Add a Video section that uploads one video to the draft listing via
`POST /v3/application/shops/{shop_id}/listings/{listing_id}/videos`.
Check Etsy's accepted formats, max size and max duration first and
enforce them client-side with a clear error message. Upload happens in
the same flow as images, after the draft listing exists.

## 4. Hide the Price field when variations exist

The main-form Price field should be hidden as soon as the listing has at
least one variation with price varying by it — the price is entered per
combination there instead. With no variations, Price stays required and
visible. Do not delete the field outright.

## 5. Connect Etsy's OpenAPI Dev MCP server

Etsy publishes an official MCP server exposing the live Open API spec —
endpoints, request/response schemas, auth requirements, OAuth scopes. No
API key needed. Find its URL in Etsy's own developer docs (do not guess
one), add it to this project's MCP config, and from then on check
endpoint and field names against it instead of relying on memory.
