import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "--font-geist-sans" }),
  Geist_Mono: () => ({ variable: "--font-geist-mono" }),
}));
vi.mock("@/lib/account/current-user", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));

import { metadata } from "@/app/layout";
import { TWO_FACTOR_ISSUER } from "@/lib/account/two-factor";
import { APP_NAME } from "@/lib/brand";

const ROOT = process.cwd();

/** Every non-test source/style file under app/ and lib/. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return /\.(tsx?|css)$/.test(entry.name) ? [full] : [];
  });
}

describe("Listhouse branding", () => {
  test("the product name is Listhouse", () => {
    expect(APP_NAME).toBe("Listhouse");
  });

  test("page titles use Listhouse (default, and as the suffix of page-specific titles)", () => {
    expect(metadata.title).toEqual({ default: "Listhouse", template: "%s · Listhouse" });
    expect(String(metadata.description)).not.toMatch(/create next app/i);
  });

  test("authenticator apps label the 2FA entry Listhouse", () => {
    expect(TWO_FACTOR_ISSUER).toBe("Listhouse");
  });

  test("\"Etsy Mockup Studio\" no longer appears anywhere in app/ or lib/", () => {
    const offenders = [path.join(ROOT, "app"), path.join(ROOT, "lib")]
      .flatMap(sourceFiles)
      .filter((file) => /etsy mockup studio/i.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  test("the card sheen is gone everywhere — no entry-card class or styles remain", () => {
    const offenders = [path.join(ROOT, "app"), path.join(ROOT, "lib")]
      .flatMap(sourceFiles)
      .filter((file) => /entry-card/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });
});
