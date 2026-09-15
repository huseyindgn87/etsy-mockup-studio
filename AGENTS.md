<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Keeping this file current (mandatory)

At the end of every session, update the **Project state** section below (and
CLAUDE.md if anything it says changes) so it matches reality, and commit it.
Verify every fact before writing it — HEAD from `git log`, the test count from
an actual `vitest run`, pending manual steps from the migrations folder and
`.env.example`. Never carry forward a number or status you didn't re-check.

# Project state

_Last updated 2026-09-16._

- **HEAD:** 64a5c05 (plus the commit updating this file). `tsc --noEmit`, `eslint .`, `next build` clean; **623 vitest tests passing**.
- **Shipped:**
  - Listing editor at `/mockups` (variations, photos + video, personalization, settings tab, price-by-variation).
  - `/listings` backed by a DB listings cache with on-demand refresh; multiple Etsy shop connections per user (refresh tokens encrypted at rest).
  - Listing drafts (DB rows + R2 binaries).
  - App accounts (Auth.js credentials, "Keep me signed in"), scoping all user data.
  - Mockup template library + calibration screen at `/admin/templates` (last commit touching it was `5392d17 wip` — confirm with the maintainer what, if anything, is left).
  - Account settings at `/settings`: Light/Dark theme stored per user and rendered server-side as `<html data-theme>`, first/last name, email change (requires current password), password change, Etsy connection status + Disconnect (the only place these live), Log out.
  - Top bar reduced to a sidebar toggle (listings page), the **LISTHOUSE** wordmark (links to `/listings` — the app's home, showing the currently selected shop — from every page including the `/` shop picker; inert text only on `/listings` itself), and an avatar menu (Account settings, Sign out / Sign in).
  - **The product is named Listhouse** (`lib/brand.ts` → `APP_NAME`): login/register cards, page titles (`%s · Listhouse`), the 2FA authenticator issuer, and the uppercased wordmark all read it. "Etsy Mockup Studio" is gone from the UI (`app/__tests__/branding.test.ts` guards this); the repo/package name `etsy-mockup-studio` is unchanged.
  - All glass cards (home, login, register) are still — the hover sheen and its `entry-card` styles are deleted. Clicking the shop button plays a ~1s "$" particle burst (`app/(app)/dollar-burst.ts`, Web Animations API, skipped under reduced motion) — deliberately tight, staying within ~250px of the click point.
  - Password inputs everywhere use `app/components/PasswordInput.tsx` (show/hide toggle).
  - Optional TOTP two-factor auth: enable/disable on `/settings` (QR via `qrcode`, TOTP on `node:crypto` in `lib/auth/totp.ts`), second sign-in step on `/login` accepting a 6-digit code or a single-use recovery code (10 issued, SHA-256 hashed). Secret AES-256-GCM encrypted with `TWO_FACTOR_ENCRYPTION_KEY`; codes can't be replayed.
  - **Listing scheduling (parts 1 and 2 — data model, API, UI, runner):** `ScheduledListing` (draft, shop, owner, UTC `scheduledAt`, IANA `timezone`, status pending/publishing/published/failed/cancelled, `publishSpec` + `renderSetId` + `images` fixed at schedule time, `attemptCount`/`nextAttemptAt`/`lastError`/`etsyListingId`; index on status + scheduledAt, unique `activeDraftId`). `lib/scheduling/` holds Intl-only wall-time⇄UTC conversion (DST-gap times rejected), validation, a store scoped to user **and** active shop, the runner and the publisher. API: `GET/POST /api/schedule` (`from`/`to` range or `draftId`), `PATCH /api/schedule/[id]`, `POST /api/schedule/[id]/cancel`, `PUT|DELETE /api/schedule/renders/...`, `POST /api/schedule/run`. `/schedule` (listings sidebar) shows a two-week strip with TODAY, fortnight arrows, reschedule/cancel per entry.
  - **Rendering happens at schedule time, in the browser** (`app/(app)/mockups/schedule-renders.ts`): full-resolution `compose()` + the same JPEG window as Publish, uploaded to `scheduled/{userId}/{renderSetId}/image-NN` in R2. The runner never composites — it creates the listing, attaches the stored images in rank order (`overwrite`, so retries are idempotent), activates it, then deletes **only** that job's own keys (`isOwnedRenderKey`); user uploads under `drafts/` and `templates/user/` are never touched. Failures retry with backoff (5 min, 20 min) up to 3 attempts, then "failed" with the images kept. Claiming is a conditional pending→publishing update, so concurrent runs can't double-publish; `etsyListingId` is recorded as soon as Etsy creates the listing so a retry finishes it instead of duplicating. Runner auth: `Authorization: Bearer $SCHEDULE_RUNNER_SECRET`; run it with `npm run schedule:run` (needs `npm run dev` up). Listing-creation steps are shared with the editor's Publish in `lib/etsy/publish-listing.ts`; the runner authenticates from the shop connection's stored refresh token (no cookie).
  - Scheduling is refused, with a message, for "add photos to an existing listing" mode and for listings with a video; Publish is disabled while a draft has a pending/publishing schedule.
- **In progress:** nothing.
- **Known gaps (not yet asked for):** no rate limiting or lockout on password / 2FA code attempts; JWT sessions mean a password, email or 2FA change doesn't sign out other devices; no email verification on email change (no email-sending flow); cancelling a schedule keeps its rendered images in R2 (only a successful publish deletes them); a run interrupted mid-publish is only recovered after 30 minutes (`STALE_PUBLISHING_MS`); the runner refreshes Etsy tokens with the stored refresh token, which Etsy's docs don't say invalidates the browser session's copy — if a reconnect is ever needed after a run, that's the first thing to check. **The whole scheduling flow has only been verified by build/lint/types and unit tests — it has never run against a migrated DB, a real R2 bucket or Etsy.**
- **Pending manual steps for the maintainer:**
  - Apply migrations `20260915120000_add_user_profile_and_theme`, `20260916090000_add_two_factor_auth`, `20260916150000_add_scheduled_listings` and `20260917090000_scheduled_listing_runner` (`npm run db:migrate`) — signed-in pages fail until the first two are applied; scheduling fails until the last two are.
  - Add `SCHEDULE_RUNNER_SECRET` (min 32 chars, `openssl rand -base64 32`) to `.env.local` — until then `POST /api/schedule/run` refuses every request with 503 and `npm run schedule:run` exits with that message.
  - **Scheduling needs the R2 bucket** (`R2_*` in `.env.local`): images are rendered and stored when a listing is scheduled. While R2 is unset, "Schedule for later" fails with a clear message and Publish is unaffected.
  - Add `TWO_FACTOR_ENCRYPTION_KEY` (min 32 chars, `openssl rand -base64 32`) to `.env.local` and restart — until then enabling 2FA shows "not available" and the server logs the missing variable.
- **`.env.local` is maintained by the maintainer only — never edit it.** Document any new variable in `.env.example` and tell the maintainer its name.
- **Storage:** Cloudflare R2 is wired up in code; bucket/env setup is on hold — do not touch storage config.
- `TODO.md`'s five tasks all appear shipped (commits 7b3b227, dd060aa, 8575b3c, 72de813, c6953bd); the file itself hasn't been updated.

**Architectural direction:** users will NOT upload PSD files. The product maintains a curated library of pre-calibrated mockup templates as flat JPEG/PNG. Users upload only their design PNG. The PSD pipeline stays in the repo because it's still used for the maintainer's own Etsy shops, but it is no longer part of the product path. Do not change the mockup compositor logic unless explicitly asked.
