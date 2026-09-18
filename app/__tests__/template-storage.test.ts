import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = process.cwd();

/** Every non-test source file under app/ and lib/. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("templates are stored in R2, not on local disk", () => {
  const files = [...sourceFiles(path.join(ROOT, "app")), ...sourceFiles(path.join(ROOT, "lib"))];

  test("no app code refers to public/templates/", () => {
    const offenders = files.filter((f) => readFileSync(f, "utf8").includes("public/templates"));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  test("no app code reads a local templates folder", () => {
    const localDir = /process\.cwd\(\)\s*,\s*["'](public["']\s*,\s*["'])?templates["']/;
    const offenders = files.filter((f) => localDir.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  test("the template store doesn't touch the file system", () => {
    const store = readFileSync(path.join(ROOT, "lib/mockup/template-store.ts"), "utf8");
    expect(store).not.toMatch(/from ["'](node:)?fs(\/promises)?["']/);
  });
});
