<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Listhouse (repo: etsy-mockup-studio)

A web app for Etsy sellers: connect Etsy shops, edit listings (single editor and bulk editor), build listing photos from a curated library of pre-calibrated mockup templates plus the user's design PNG, save drafts, schedule publishes and bulk edits. Brand name comes from `lib/brand.ts` (`APP_NAME`).

## Stack

Next.js (App Router, `proxy.ts` — see the block above), React, TypeScript, Tailwind. Prisma on Neon Postgres (`@prisma/adapter-neon`). Auth.js credentials + optional TOTP. Cloudflare R2 (S3 SDK) for all binaries, Turnstile for bot checks. `sharp` for images. `@anthropic-ai/sdk` for AI Edits. Vitest (+ jsdom) for tests; zod for validation.

## Folder map

- `app/(app)/` — signed-in pages: `listings/` (+ `bulk/`), `mockups/` (listing editor), `schedule/`, `settings/`; layout mounts `ToastProvider`.
- `app/(legal)/` — `/terms`, `/privacy`, `/refunds`, `/cookies` (drafts with `[FILL: …]` placeholders).
- `app/api/` — route handlers (`etsy/`, `mockups/`, `drafts/`, `schedule/`, `jobs/`, `ai/`, `admin/`).
- `app/components/` — shared UI (`listing-media/`, `toast/`, `unsaved-changes/`, `jobs/`, `legal/`).
- `app/admin/templates` — template calibration, admin only (`ADMIN_USER_IDS`).
- `lib/etsy/` — Etsy client, sync, publish, bulk apply, form⇄Etsy mapping, change detection.
- `lib/jobs/` — Etsy job queue + worker. `lib/scheduling/` — scheduled publishes/bulk edits.
- `lib/mockup/` — templates (R2), previews, compositor. `lib/drafts/`, `lib/storage/` (R2), `lib/auth/`, `lib/ai/`, `lib/listings/`, `lib/db/`.
- `prisma/` — schema + migrations. `scripts/` — dev runner, job runner, template import.
- `docs/agents-archive.md` — full feature history and past decisions (not auto-loaded; read the relevant part when a task touches that feature).

## Run / test

- `npm run dev` — `next dev` + the job watcher. **Restart it after every `prisma migrate`/`prisma generate`.**
- `npm run jobs:run` (`-- --watch`) — works the Etsy job queue; needs `SCHEDULE_RUNNER_SECRET`.
- `npm run test:unit` — vitest only. `npm test` = `next build && vitest run`.
- `npx tsc --noEmit`, `npm run lint`.
- `npm run db:migrate`; `npm run templates:import [dirs…]` adds library templates to R2.
- **Run only the tests related to the change** (`npx vitest run <paths>`), not the whole suite, unless asked.

## Hard rules

- **Never modify a live Etsy listing** (no writes against a real shop) unless the maintainer explicitly asks for that specific action. Tests use fakes; nothing here has been run against Etsy unless stated.
- **What's in the form is exactly what goes to Etsy.** Publish/schedule/copy send the form's values; never read or merge from a source listing at publish time; never silently drop a change — anything Etsy can't write is reported as an `UnsyncedChange` (`lib/etsy/listing-changes.ts`).
- **No spend before launch**: no paid services, plans, credits or API calls that cost money without asking first.
- All Etsy API traffic goes through `lib/etsy/client.ts` (`etsyRequest`) — the only file that may name `api.etsy.com` (a test enforces it). It holds the global rate limiter and daily budget tiers.
- Never repeat a POST to Etsy on retry (it may already have created something).
- **Never edit `.env.local`** (only the maintainer does, unless they explicitly ask). Document new variables in `.env.example` and tell the maintainer the name.
- Do not touch storage (R2) config. All template files live in R2; never read templates from local disk (a test enforces it).
- Raw template images never reach non-admin users — serve the watermarked preview.
- Users don't upload PSDs. The PSD pipeline stays for the maintainer's own shops. **Do not change mockup compositor logic unless explicitly asked.**
- Every user-data query is scoped to the signed-in user (and active shop where relevant); ids from the client are checked against the caller's cached listings before reaching Etsy.
- No email-existence leaks in auth responses.

## Conventions

- Match surrounding code; no comments that restate code; no drive-by refactors.
- Pure logic in `lib/` with unit tests beside it (`__tests__/`); components tested in jsdom wrapped in `<ToastProvider>` when they toast.
- User-facing results go through toasts (`useToast().show`), not banners.
- Equality of form/listing state = sorted-key JSON deep-equal (`lib/drafts/snapshot.ts`, `lib/etsy/listing-changes.ts`).
- Lists sent to Etsy urlencoded (`tags`, `materials`, …) are one comma-joined field (`lib/etsy/form-list.ts`).
- Etsy work a user waits on or that runs in the background goes through the job queue (`lib/jobs/`).
- DB changes: a new Prisma migration; say it must be applied.

# Keeping this file current (mandatory)

At the end of every session, update **Project state** below (and CLAUDE.md if anything it says changes), verify each fact (HEAD from `git log`, test counts from an actual run, pending steps from migrations and `.env.example`), and commit. Keep it short: one line per shipped item at most. Detailed history goes in `docs/agents-archive.md`, not here.

# Project state

_Last updated 2026-09-19._

- **HEAD:** the "Shrink AGENTS.md" commit. Code unchanged since 37aefb0; last full test count 1416 at 113b60d, last related-suite run 662 passing at 37aefb0.
- **In progress:** nothing.
- **Never verified against real Etsy/DB end to end:** job queue (real save/refresh/scheduled publish), incremental refresh, scheduled publishes and bulk edits, bulk editing, variation photos, Sync to Etsy, AI Edits (real API). Much UI verified only in jsdom, not a real browser. Details in the archive's "Known gaps".
- **Known TODO:** see `docs/todo.md`.
- **Pending manual steps for the maintainer:** set `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY` before deploying; `ANTHROPIC_API_KEY` for AI Edits; `SCHEDULE_RUNNER_SECRET` (≥32 chars) for the job worker; `TWO_FACTOR_ENCRYPTION_KEY` (≥32 chars) for 2FA; `ETSY_SCOPES=listings_r listings_w listings_d shops_r` + reconnect the shop to allow Delete. All in `.env.example`. No hosted cron exists for `jobs:run`.
- All migrations through `20260919090000_listing_last_modified` are applied.

Open tasks live in docs/todo.md — read it when asked what's next.
