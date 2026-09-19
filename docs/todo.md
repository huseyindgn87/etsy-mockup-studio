# Project task list

Single source of open work. Checked against the code on 2026-09-19.

## Hard rules

- Whatever is in the listing form is exactly what goes to Etsy. Never send source-listing content.
- A live listing never changes on its own; only when the user explicitly updates it.
- No spending money on this project until launch.
- Run only related tests per task; full suite only before launch.

## Open

### New (19 Sept)
- [ ] On the My drafts tab the "Listhouse" logo (top left) can't be clicked.
- [ ] While a scheduled publish runs: blur the site, block edits, show "sending to Etsy" status.
- [ ] Scheduling listings that have a video (blocked in `lib/scheduling/publish-guard.ts`).
- [ ] Real-shop test of copy → edit → schedule after b88cd79 / 37aefb0.

### Backlog
- [ ] Physical vs digital listing type (digital: file upload, no shipping/processing).
- [ ] Combination table: select rows, then bulk price change (today the bulk bar applies to the filtered rows; no row checkboxes).
- [ ] Listings table Score column.
- [ ] Media Library for reusable images.
- [ ] Product types beyond t-shirts (tumbler, poster, ornament, yard sign).
- [ ] Trend tool: holiday calendar → weekly Etsy autocomplete → SERP.
- [ ] AI Edits live use (built; blocked: no spend before launch, needs `ANTHROPIC_API_KEY`).
- [ ] Template library has only 1 template.

### Launch blockers
- [ ] Hosting + domain + prod DB/R2; production cron for `jobs:run`.
- [ ] Password reset + email unlock link (`emailLocked`).
- [ ] Etsy commercial API application.
- [ ] Payments/subscriptions.
- [ ] Turnstile keys.
- [ ] Verify forwarded-for header on host.
- [ ] Account isolation check.
- [ ] Replace the `[FILL: …]` placeholders in the legal pages.
- [ ] IP throttle cleanup (raw IPs in `auth_throttles` are never purged).
- [ ] End-to-end real-shop test.

## Done

- [x] Variations: pencil rename in place, keeping prices/quantities/SKUs/profiles/photos — caa7512. Not checked in a real browser.
- [x] Variations: deleting an option is one click, no confirmation — 48b0b40.
- [x] My drafts: scheduled publish deletes its draft, published ones hidden, pending ones show a clock badge — 87534bf. Not run against the real DB.
- [x] Personalization on/off switch (off = no questions sent) — 793055d.
- [x] Alt text window: all photos with a field under each, one Save; bigger tile button + "Edit alt text" button — ec128d5.
- [x] Pasting comma-separated text into Tags splits it into tags (editor + bulk rows) — a130659.
- [x] All text sizes +30% site-wide (`--text-*` theme overrides in `app/globals.css`) — e7ae00f. Not checked in a real browser.
- [x] Tags "Delete all" button (editor + bulk edit rows) — 3aa56df. Saving an empty tag list is still refused by the bulk save validator.
- [x] Bulk edit left menu (AI Edits, Media, Listings, Optional, Inventory, Shipping) with per-field bulk apply bar — `BULK_GROUPS` in `lib/etsy/bulk-edit.ts`, `BulkApplyControl.tsx`.
- [x] Bulk tags add, never replace; apply only to ticked rows; single tags removable — `lib/etsy/bulk-text.ts`.
- [x] Shipping profile, item weight + dimensions, return policy — bulk Shipping group; copy/prefill carries shipping profile and return policy.
- [x] Drag-to-reorder photos/videos, X remove, + in empty slots, photos 15% bigger, video upload — `app/components/listing-media/`.
- [x] Settings section: shop section, feature listing, Etsy Ads, renewal — in `ListingForm.tsx` (Etsy Ads has no API endpoint, reported as unsynced).
- [x] "Create listing" from a blank form — `/listings` → `/mockups`.
- [x] Personalization section (text / options / file upload, two questions) — `ListingForm.tsx`, `lib/etsy/listing-personalization.ts`.
- [x] Main price applied to all variations, per-variation off by default — "Individual price" checkboxes in `VariationOfferingTabs.tsx`; unchecked = one listing-wide price.
- [x] AI Edits built (bulk editor, `POST /api/ai/optimize`) — never called live.
- [x] Calibration files committed — `TemplateCalibrator.tsx`, `TemplatePicker.tsx`, `app/admin/templates/` are tracked.
