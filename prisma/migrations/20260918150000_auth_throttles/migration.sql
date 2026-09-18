-- Brute-force protection for sign-in, 2FA codes and registration
-- (lib/auth/throttle.ts). One row per limited key; see schema.prisma.
CREATE TABLE "auth_throttles" (
    "key" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lockLevel" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "emailLocked" BOOLEAN NOT NULL DEFAULT false,
    "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_throttles_pkey" PRIMARY KEY ("key")
);
