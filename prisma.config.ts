import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

/**
 * Prisma 7 CLI config (migrate / generate / studio). Connection URLs live
 * here, not in schema.prisma. `DIRECT_URL` is Neon's unpooled connection —
 * the schema engine issues session-level statements PgBouncer's transaction
 * pooling mode doesn't support. The app's runtime `PrismaClient` uses the
 * pooled `DATABASE_URL` instead, via `@prisma/adapter-neon` (lib/db/prisma.ts).
 *
 * The Next.js dev/build process reads `.env.local` on its own; the standalone
 * `prisma` CLI does not, so load it explicitly here (falling back to `.env`).
 * `{ quiet: true }` only silences dotenv's own console tips, not our errors.
 */
loadEnv({ path: existsSync(".env.local") ? ".env.local" : ".env", quiet: true });

// A placeholder so `prisma generate` (runs on every `npm install` — see
// package.json's `postinstall`) never fails a fresh clone before `.env.local`
// exists; it doesn't connect to anything. `migrate` / `studio` do connect and
// will fail loudly and obviously if this placeholder is still in play.
const DIRECT_URL =
  process.env.DIRECT_URL ||
  process.env.DATABASE_URL ||
  "postgresql://user:password@localhost:5432/postgres";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: DIRECT_URL,
  },
});
