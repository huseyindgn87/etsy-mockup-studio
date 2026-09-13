<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Project state and product direction

HEAD is ff20b8e. The draft system is done (207 tests passing). Cloudflare R2 is configured in code but the bucket and env vars are not set up yet — that decision is on hold, do not touch storage config or `.env.local`.

**Architectural change from an earlier plan:** users will NOT upload PSD files. The product maintains a curated library of pre-calibrated mockup templates as flat JPEG/PNG. Users upload only their design PNG. The PSD pipeline stays in the repo because it's still used for the maintainer's own Etsy shops, but it is no longer part of the product path.

Next task: a calibration admin screen.
