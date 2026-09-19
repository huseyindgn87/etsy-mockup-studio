# Project task list

Single source of open work. Checked against the code on 2026-09-19.

## Hard rules

- Whatever is in the listing form is exactly what goes to Etsy. Never send source-listing content.
- A live listing never changes on its own; only when the user explicitly updates it.
- No spending money on this project until launch.
- Run only related tests per task; full suite only before launch.

## Open

### New (19 Sept)
- [ ] Increase all text sizes site-wide by 30%.
- [ ] Pasting comma-separated text into Tags splits it into separate tags (today the input caps at 20 chars and only Enter/"," add a tag).
- [ ] Alt text: bigger button; opens ALL listing photos at once (grid or stacked), alt text under each, one Save closes it.
- [ ] Personalization on/off toggle so a non-personalized listing can't go out as personalized (the form always has question slot 1).
- [ ] Scheduling listings that have a video (blocked in `lib/scheduling/publish-guard.ts`).
- [ ] My drafts: published scheduled listings remove their drafts; pending scheduled drafts show a clock badge.
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
