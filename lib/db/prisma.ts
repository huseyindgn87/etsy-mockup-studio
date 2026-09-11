import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "@prisma/client";

/**
 * Prisma Client singleton, Neon Postgres via the `@prisma/adapter-neon` driver
 * adapter (Prisma 7 requires an adapter — schema.prisma carries no `url`; see
 * prisma.config.ts and prisma/schema.prisma for why).
 *
 * `DATABASE_URL` is Neon's pooled (PgBouncer) connection string — the right
 * one for a request-scoped runtime connection. Cached on `globalThis` so Next
 * dev's module reloading doesn't open a fresh pool on every edit.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Missing DATABASE_URL. Copy .env.example to .env.local and fill in your Neon connection string.",
    );
  }
  const adapter = new PrismaNeon({ connectionString });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
