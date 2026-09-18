/**
 * Uploads curated library templates from local folders to R2 and makes sure
 * each has a `MockupTemplate` row — the one-off move off local disk, and the
 * way to add new library templates afterwards.
 *
 *   npm run templates:import              # templates/ and public/templates/
 *   npm run templates:import -- some/dir  # any folders you name
 *
 * Safe to run again: files already in R2 at the same size aren't re-uploaded,
 * and existing rows keep their name and calibration. Every file is re-read
 * from R2 and compared byte for byte before it's reported as done.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ quiet: true });

const args = process.argv.slice(2).filter((a) => a !== "--" && !a.endsWith("import-templates-to-r2.ts"));
const dirs = (args.length ? args : ["templates", "public/templates"]).filter((d) => existsSync(d));

const { importLibraryTemplate, isLibraryFilename, getLibraryTemplateImage } = await import(
  "@/lib/mockup/template-store"
);

let failed = 0;
let done = 0;
for (const dir of dirs) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    if (!isLibraryFilename(entry.name)) {
      console.log(`skip      ${path.join(dir, entry.name)} (not a JPEG/PNG template)`);
      continue;
    }
    try {
      const bytes = await readFile(path.join(dir, entry.name));
      const { uploaded, created } = await importLibraryTemplate(entry.name, bytes);
      const stored = await getLibraryTemplateImage(entry.name);
      if (!stored || !stored.body.equals(bytes)) throw new Error("R2 copy doesn't match the local file.");
      done++;
      console.log(
        `${uploaded ? "uploaded" : "in R2   "}  ${entry.name}${created ? " (new row)" : ""} — verified`,
      );
    } catch (err) {
      failed++;
      console.error(`FAILED    ${entry.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

console.log(`\n${done} template(s) in R2 from ${dirs.join(", ") || "no folders"}; ${failed} failed.`);
process.exit(failed ? 1 : 0);
