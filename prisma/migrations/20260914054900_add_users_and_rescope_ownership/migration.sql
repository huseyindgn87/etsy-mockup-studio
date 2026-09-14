-- Add the app-account layer (Auth.js Prisma adapter models: users, accounts,
-- sessions, verification_tokens) and re-scope ownership of listing_drafts,
-- mockup_calibrations, and mockup_templates from the Etsy user id to the
-- signed-in app User id.

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "name" TEXT,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_providerAccountId_key" ON "accounts"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_sessionToken_key" ON "sessions"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_identifier_token_key" ON "verification_tokens"("identifier", "token");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Re-scoping listing_drafts and mockup_calibrations from etsyUserId to userId:
-- these two tables had 1 row each in dev, written before any app account
-- existed (scoped only by Etsy identity). There is no User to attribute them
-- to, so they're deleted here rather than left with a dangling/nullable
-- owner — see the audit note in the PR description.
DELETE FROM "listing_drafts";
DELETE FROM "mockup_calibrations";

-- DropIndex
DROP INDEX "listing_drafts_etsyUserId_updatedAt_idx";

-- DropIndex
DROP INDEX "mockup_calibrations_etsyUserId_contentHash_key";

-- DropIndex
DROP INDEX "mockup_calibrations_etsyUserId_idx";

-- AlterTable
ALTER TABLE "listing_drafts" DROP COLUMN "etsyUserId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "mockup_calibrations" DROP COLUMN "etsyUserId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "listing_drafts_userId_updatedAt_idx" ON "listing_drafts"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "mockup_calibrations_userId_idx" ON "mockup_calibrations"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "mockup_calibrations_userId_contentHash_key" ON "mockup_calibrations"("userId", "contentHash");

-- AddForeignKey
ALTER TABLE "mockup_calibrations" ADD CONSTRAINT "mockup_calibrations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listing_drafts" ADD CONSTRAINT "listing_drafts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mockup_templates" ADD CONSTRAINT "mockup_templates_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
