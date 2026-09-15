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

- **HEAD:** 1a0cb9b (plus the commit updating this file). `tsc --noEmit`, `eslint .`, `next build` clean; **471 vitest tests passing**.
- **Shipped:**
  - Listing editor at `/mockups` (variations, photos + video, personalization, settings tab, price-by-variation).
  - `/listings` backed by a DB listings cache with on-demand refresh; multiple Etsy shop connections per user (refresh tokens encrypted at rest).
  - Listing drafts (DB rows + R2 binaries).
  - App accounts (Auth.js credentials, "Keep me signed in"), scoping all user data.
  - Mockup template library + calibration screen at `/admin/templates` (last commit touching it was `5392d17 wip` — confirm with the maintainer what, if anything, is left).
  - Account settings at `/settings`: Light/Dark theme stored per user and rendered server-side as `<html data-theme>`, first/last name, email change (requires current password), password change, Etsy connection status + Disconnect (the only place these live), Log out.
  - Top bar reduced to a sidebar toggle (listings page), the **LISTHOUSE** wordmark (links home; inert text on home itself), and an avatar menu (Account settings, Sign out / Sign in). The product name in the UI is LISTHOUSE; `/login`, `/register` and the TOTP issuer still say "Etsy Mockup Studio".
  - Home welcome card is still (no `entry-card` sheen; login/register keep it). Clicking the shop button plays a ~1s "$" particle burst (`app/(app)/dollar-burst.ts`, Web Animations API, skipped under reduced motion).
  - Password inputs everywhere use `app/components/PasswordInput.tsx` (show/hide toggle).
  - Optional TOTP two-factor auth: enable/disable on `/settings` (QR via `qrcode`, TOTP on `node:crypto` in `lib/auth/totp.ts`), second sign-in step on `/login` accepting a 6-digit code or a single-use recovery code (10 issued, SHA-256 hashed). Secret AES-256-GCM encrypted with `TWO_FACTOR_ENCRYPTION_KEY`; codes can't be replayed.
- **In progress:** nothing.
- **Known gaps (not yet asked for):** no rate limiting or lockout on password / 2FA code attempts; JWT sessions mean a password, email or 2FA change doesn't sign out other devices; no email verification on email change (no email-sending flow).
- **Pending manual steps for the maintainer:**
  - Apply migrations `20260915120000_add_user_profile_and_theme` and `20260916090000_add_two_factor_auth` (`npm run db:migrate`) — signed-in pages fail until they're applied.
  - Add `TWO_FACTOR_ENCRYPTION_KEY` (min 32 chars, `openssl rand -base64 32`) to `.env.local` and restart — until then enabling 2FA shows "not available" and the server logs the missing variable.
- **`.env.local` is maintained by the maintainer only — never edit it.** Document any new variable in `.env.example` and tell the maintainer its name.
- **Storage:** Cloudflare R2 is wired up in code; bucket/env setup is on hold — do not touch storage config.
- `TODO.md`'s five tasks all appear shipped (commits 7b3b227, dd060aa, 8575b3c, 72de813, c6953bd); the file itself hasn't been updated.

**Architectural direction:** users will NOT upload PSD files. The product maintains a curated library of pre-calibrated mockup templates as flat JPEG/PNG. Users upload only their design PNG. The PSD pipeline stays in the repo because it's still used for the maintainer's own Etsy shops, but it is no longer part of the product path. Do not change the mockup compositor logic unless explicitly asked.
