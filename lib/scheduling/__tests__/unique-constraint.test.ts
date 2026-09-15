import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

// The at-most-one-active-schedule rule lives in the database, not just in
// application code. These check the schema and the migration that creates
// the index; the API tests exercise how a violation is handled.

const ROOT = process.cwd();

describe("database unique constraint: one active schedule per draft", () => {
  test("ScheduledListing.activeDraftId is a unique column", () => {
    const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf8");
    const model = /model ScheduledListing \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
    expect(model).toMatch(/^\s*activeDraftId\s+String\?\s+@unique\s*$/m);
  });

  test("a migration creates the unique index", () => {
    const dir = path.join(ROOT, "prisma/migrations");
    const sql = readdirSync(dir)
      .filter((d) => !d.endsWith(".toml"))
      .map((d) => readFileSync(path.join(dir, d, "migration.sql"), "utf8"))
      .join("\n");
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "scheduled_listings_activeDraftId_key" ON "scheduled_listings"("activeDraftId");',
    );
  });
});
