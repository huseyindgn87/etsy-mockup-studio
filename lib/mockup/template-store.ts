/**
 * Curated mockup template library (see AGENTS.md: users upload only their
 * design PNG — the templates themselves are flat JPEG/PNG files the
 * maintainer drops in `public/templates/`, calibrated at `/admin/templates`).
 *
 * Server-only — pulls in `fs` and Prisma; never import from a client component.
 * Keyed by filename, not content hash: unlike a user's PSD upload, these files
 * are maintainer-managed and filename is a stable, meaningful key.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { DEFAULT_QUAD, type Quad } from "./types";
import type { TemplateListItem } from "./template-types";
import { clamp, toQuad } from "./validate";

const TEMPLATE_DIR = path.join(process.cwd(), "public", "templates");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

const cloneQuad = (q: Quad): Quad => q.map((p) => [...p]) as Quad;
const stripExt = (filename: string) => filename.replace(/\.[^.]+$/, "");

/** Filenames of every template image in `public/templates/`, sorted. */
export async function listTemplateFiles(): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(TEMPLATE_DIR, { withFileTypes: true });
  } catch {
    return []; // directory doesn't exist yet — an empty library, not an error
  }
  return entries
    .filter((e) => e.isFile() && IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Every template file on disk, joined with its saved `MockupTemplate` row, if any. */
export async function listTemplates(): Promise<TemplateListItem[]> {
  const [files, rows] = await Promise.all([listTemplateFiles(), prisma.mockupTemplate.findMany()]);
  const byFilename = new Map(rows.map((r) => [r.filename, r]));
  return files.map((filename) => {
    const row = byFilename.get(filename);
    return {
      filename,
      name: row?.name ?? stripExt(filename),
      productType: row?.productType ?? "",
      colour: row?.colour ?? "",
      dpiHint: row?.dpiHint ?? 300,
      quad: (row ? toQuad(row.quad) : null) ?? cloneQuad(DEFAULT_QUAD),
      calibrated: !!row,
    };
  });
}

export interface TemplateSaveInput {
  name: string;
  productType: string;
  colour: string;
  dpiHint: number;
  quad: unknown;
}

/**
 * Upserts a template's metadata + print-area quad, keyed by filename. Rejects
 * a filename with no matching file in `public/templates/` — this table only
 * ever describes files that actually exist there.
 */
export async function saveTemplate(
  filename: string,
  input: TemplateSaveInput,
): Promise<TemplateListItem> {
  const files = await listTemplateFiles();
  if (!files.includes(filename)) {
    throw new Error(`No template file named "${filename}" in public/templates/.`);
  }

  const quad = toQuad(input.quad) ?? cloneQuad(DEFAULT_QUAD);
  const dpiHint = Math.round(clamp(Number.isFinite(input.dpiHint) ? input.dpiHint : 300, 72, 1200));
  const data = {
    name: input.name.trim() || stripExt(filename),
    productType: input.productType.trim(),
    colour: input.colour.trim(),
    dpiHint,
    quad: quad as unknown as Prisma.InputJsonValue,
  };

  const row = await prisma.mockupTemplate.upsert({
    where: { filename },
    create: { filename, ...data },
    update: data,
  });

  return {
    filename: row.filename,
    name: row.name,
    productType: row.productType,
    colour: row.colour,
    dpiHint: row.dpiHint,
    quad: toQuad(row.quad) ?? cloneQuad(DEFAULT_QUAD),
    calibrated: true,
  };
}
