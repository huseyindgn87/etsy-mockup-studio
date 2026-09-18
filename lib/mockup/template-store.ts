/**
 * Mockup template library — both the curated JPEG/PNG set the maintainer
 * calibrates at `/admin/templates` (flat files under `templates/`, deliberately
 * outside `public/` so they are never served as-is) and
 * a user's own uploaded JPEG/PNG, calibrated with the same UI and stored in
 * R2 (see AGENTS.md: users upload only flat images, never PSDs).
 *
 * Server-only — pulls in `fs`, `sharp`, and Prisma; never import from a client
 * component. Library rows are keyed by their on-disk filename (maintainer-
 * managed, not renamed/re-exported); user rows get a generated, globally-
 * unique filename used as their R2 object key.
 */

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { userTemplateKey, putObject, getObject, isR2Configured } from "@/lib/storage/r2";
import { DEFAULT_QUAD, type Quad } from "./types";
import type { TemplateListItem, TemplateRef } from "./template-types";
import { clamp, toQuad } from "./validate";
import { validateTemplateUpload } from "./template-limits";

const TEMPLATE_DIR = path.join(process.cwd(), "templates");
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

const cloneQuad = (q: Quad): Quad => q.map((p) => [...p]) as Quad;
const stripExt = (filename: string) => filename.replace(/\.[^.]+$/, "");

type TemplateRow = {
  id: string;
  ownerId: string | null;
  source: string;
  filename: string;
  name: string;
  productType: string;
  colour: string;
  dpiHint: number;
  quad: Prisma.JsonValue;
  calibrated: boolean;
};

function libraryImageUrl(filename: string): string {
  return `/api/mockups/templates/library/${encodeURIComponent(filename)}/image`;
}

function imageUrlFor(row: Pick<TemplateRow, "id" | "source" | "filename">): string {
  return row.source === "user" ? `/api/mockups/templates/${row.id}/image` : libraryImageUrl(row.filename);
}

function toListItem(row: TemplateRow): TemplateListItem {
  return {
    id: row.id,
    source: row.source === "user" ? "user" : "library",
    ownerId: row.ownerId,
    filename: row.filename,
    name: row.name,
    productType: row.productType,
    colour: row.colour,
    dpiHint: row.dpiHint,
    quad: toQuad(row.quad) ?? cloneQuad(DEFAULT_QUAD),
    calibrated: row.calibrated,
    imageUrl: imageUrlFor(row),
  };
}

/** Filenames of every template image in `templates/`, sorted. */
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

/** Every curated library template on disk, joined with its saved `MockupTemplate` row, if any. */
export async function listTemplates(): Promise<TemplateListItem[]> {
  const [files, rows] = await Promise.all([
    listTemplateFiles(),
    prisma.mockupTemplate.findMany({ where: { source: "library" } }),
  ]);
  const byFilename = new Map(rows.map((r) => [r.filename, r]));
  return files.map((filename) => {
    const row = byFilename.get(filename);
    return {
      id: row?.id ?? null,
      source: "library" as const,
      ownerId: null,
      filename,
      name: row?.name ?? stripExt(filename),
      productType: row?.productType ?? "",
      colour: row?.colour ?? "",
      dpiHint: row?.dpiHint ?? 300,
      quad: (row ? toQuad(row.quad) : null) ?? cloneQuad(DEFAULT_QUAD),
      calibrated: row?.calibrated ?? false,
      imageUrl: libraryImageUrl(filename),
    };
  });
}

/** A user's own uploaded templates, most recently created first. */
export async function listUserTemplates(ownerId: string): Promise<TemplateListItem[]> {
  const rows = await prisma.mockupTemplate.findMany({
    where: { source: "user", ownerId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toListItem);
}

export interface TemplateSaveInput {
  name: string;
  productType: string;
  colour: string;
  dpiHint: number;
  quad: unknown;
}

function cleanSaveInput(filename: string, input: TemplateSaveInput) {
  const quad = toQuad(input.quad) ?? cloneQuad(DEFAULT_QUAD);
  const dpiHint = Math.round(clamp(Number.isFinite(input.dpiHint) ? input.dpiHint : 300, 72, 1200));
  return {
    name: input.name.trim() || stripExt(filename),
    productType: input.productType.trim(),
    colour: input.colour.trim(),
    dpiHint,
    quad: quad as unknown as Prisma.InputJsonValue,
    calibrated: true,
  };
}

/**
 * Upserts a curated library template's metadata + print-area quad, keyed by
 * filename. Rejects a filename with no matching file in `templates/` —
 * this table only ever describes library files that actually exist there.
 */
export async function saveTemplate(
  filename: string,
  input: TemplateSaveInput,
): Promise<TemplateListItem> {
  const files = await listTemplateFiles();
  if (!files.includes(filename)) {
    throw new Error(`No template file named "${filename}" in templates/.`);
  }

  const data = cleanSaveInput(filename, input);
  const row = await prisma.mockupTemplate.upsert({
    where: { filename },
    create: { filename, source: "library", ownerId: null, ...data },
    update: data,
  });

  return toListItem(row);
}

/** Sanitizes an uploaded filename down to a short, safe basename for display + the R2 key. */
function sanitizeOriginalName(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "-");
  return (base || "template").slice(0, 120);
}

/**
 * Validates and stores a user's uploaded template image in R2, then creates
 * its `MockupTemplate` row (uncalibrated — `DEFAULT_QUAD` until the caller
 * saves a real quad via {@link saveUserTemplateCalibration}). Throws with a
 * user-facing message on any validation or storage failure — including R2
 * not being configured yet (see AGENTS.md), so the page never crashes, just
 * surfaces a clear error.
 */
export async function createUserTemplate(
  ownerId: string,
  file: { bytes: Buffer; originalFilename: string; contentType: string },
): Promise<TemplateListItem> {
  if (!isR2Configured()) {
    throw new Error(
      "Uploading your own templates isn't available yet — storage hasn't been set up. Try again later.",
    );
  }

  const validated = await validateTemplateUpload(file.bytes);
  if (!validated.ok) throw new Error(validated.error);

  const storageName = `${randomUUID()}.${validated.format === "png" ? "png" : "jpg"}`;
  const key = userTemplateKey(ownerId, storageName);
  const contentType = validated.format === "png" ? "image/png" : "image/jpeg";
  await putObject(key, file.bytes, contentType);

  const row = await prisma.mockupTemplate.create({
    data: {
      ownerId,
      source: "user",
      filename: key,
      name: stripExt(sanitizeOriginalName(file.originalFilename)),
      productType: "",
      colour: "",
      dpiHint: 300,
      quad: cloneQuad(DEFAULT_QUAD) as unknown as Prisma.InputJsonValue,
      calibrated: false,
    },
  });

  return toListItem(row);
}

/**
 * Upserts a user-owned template's metadata + print-area quad, keyed by id.
 * Throws if the template doesn't exist or isn't owned by `ownerId` — a user
 * can only calibrate their own uploads, never the library or another user's.
 */
export async function saveUserTemplateCalibration(
  ownerId: string,
  id: string,
  input: TemplateSaveInput,
): Promise<TemplateListItem> {
  const existing = await prisma.mockupTemplate.findUnique({ where: { id } });
  if (!existing || existing.source !== "user" || existing.ownerId !== ownerId) {
    throw new Error("Template not found.");
  }

  const data = cleanSaveInput(existing.filename, input);
  const row = await prisma.mockupTemplate.update({ where: { id }, data });
  return toListItem(row);
}

/**
 * Streams a user template's image bytes back from R2, or `null` if the row
 * doesn't exist / isn't owned by `ownerId` / isn't a user template.
 */
export async function getUserTemplateImage(
  ownerId: string,
  id: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  const row = await prisma.mockupTemplate.findUnique({ where: { id } });
  if (!row || row.source !== "user" || row.ownerId !== ownerId) return null;
  if (!isR2Configured()) {
    throw new Error("Storage isn't set up yet — this template's image can't be loaded.");
  }
  return getObject(row.filename);
}

/**
 * A library template's raw bytes, or `null` for a name that isn't one of the
 * files in `templates/` (so no path can reach outside it).
 */
export async function getLibraryTemplateImage(
  filename: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  if (!(await listTemplateFiles()).includes(filename)) return null;
  const body = await readFile(path.join(TEMPLATE_DIR, filename));
  return { body, contentType: path.extname(filename).toLowerCase() === ".png" ? "image/png" : "image/jpeg" };
}

/** The raw template a render uses — library files for anyone, a user upload only for its owner. */
export async function readTemplateForRender(
  ref: TemplateRef,
  userId: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  return ref.source === "library" ? getLibraryTemplateImage(ref.filename) : getUserTemplateImage(userId, ref.id);
}
