/**
 * Mockup template library — both the curated JPEG/PNG set the maintainer
 * calibrates at `/admin/templates` and a user's own uploaded JPEG/PNG,
 * calibrated with the same UI (see AGENTS.md: users upload only flat images,
 * never PSDs). Every template file lives in R2 — library files under
 * `templates/library/{filename}`, user uploads under `templates/user/…` — and
 * every template's metadata in its `MockupTemplate` row. Nothing is read from
 * local disk, so the library survives serverless hosting.
 *
 * Server-only — pulls in `sharp` and Prisma; never import from a client
 * component. Library rows are keyed by their library filename (added with
 * `npm run templates:import`, never renamed); user rows get a generated,
 * globally-unique filename used as their R2 object key.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import {
  deleteObject,
  getObject,
  headObject,
  isR2Configured,
  libraryTemplateKey,
  putObject,
  userTemplateKey,
} from "@/lib/storage/r2";
import { DEFAULT_QUAD, type Quad } from "./types";
import type { TemplateListItem, TemplateRef } from "./template-types";
import { clamp, toQuad } from "./validate";
import { validateTemplateUpload } from "./template-limits";

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

/** A name a library template may have: a plain JPEG/PNG basename, nothing path-like. */
export function isLibraryFilename(filename: string): boolean {
  return (
    !!filename &&
    filename === path.basename(filename) &&
    !filename.includes("\\") &&
    !filename.startsWith(".") &&
    IMAGE_EXTENSIONS.has(path.extname(filename).toLowerCase())
  );
}

function contentTypeFor(filename: string): string {
  return path.extname(filename).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
}

function requireR2(message: string): void {
  if (!isR2Configured()) throw new Error(message);
}

/** Every curated library template, by filename. */
export async function listTemplates(): Promise<TemplateListItem[]> {
  const rows = await prisma.mockupTemplate.findMany({ where: { source: "library" } });
  return rows.sort((a, b) => a.filename.localeCompare(b.filename)).map(toListItem);
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
 * Saves a curated library template's metadata + print-area quad, keyed by
 * filename. Rejects a filename with no library row — rows are created only
 * when the file itself is stored ({@link importLibraryTemplate}).
 */
export async function saveTemplate(
  filename: string,
  input: TemplateSaveInput,
): Promise<TemplateListItem> {
  const existing = await prisma.mockupTemplate.findUnique({ where: { filename } });
  if (!existing || existing.source !== "library") {
    throw new Error(`No library template named "${filename}".`);
  }

  const row = await prisma.mockupTemplate.update({
    where: { id: existing.id },
    data: cleanSaveInput(filename, input),
  });
  return toListItem(row);
}

/**
 * Stores one curated template file in R2 and makes sure it has a library row.
 * Safe to repeat: an object already in R2 at the same size isn't uploaded
 * again, and an existing row keeps its name and calibration.
 */
export async function importLibraryTemplate(
  filename: string,
  bytes: Buffer,
): Promise<{ uploaded: boolean; created: boolean }> {
  if (!isLibraryFilename(filename)) throw new Error(`"${filename}" isn't a JPEG or PNG filename.`);
  requireR2("Storage isn't set up — library templates can't be stored.");

  const existing = await prisma.mockupTemplate.findUnique({ where: { filename } });
  if (existing && existing.source !== "library") {
    throw new Error(`"${filename}" is already used by a user template.`);
  }

  const key = libraryTemplateKey(filename);
  const stored = await headObject(key);
  const uploaded = stored?.size !== bytes.length;
  if (uploaded) await putObject(key, bytes, contentTypeFor(filename));

  if (!existing) {
    await prisma.mockupTemplate.create({
      data: {
        filename,
        source: "library",
        ownerId: null,
        name: stripExt(filename),
        productType: "",
        colour: "",
        dpiHint: 300,
        quad: cloneQuad(DEFAULT_QUAD) as unknown as Prisma.InputJsonValue,
        calibrated: false,
      },
    });
  }
  return { uploaded, created: !existing };
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
  requireR2("Storage isn't set up yet — this template's image can't be loaded.");
  return getObject(row.filename);
}

/**
 * Deletes a user's own template — its R2 object first, then its row, so a
 * failed delete leaves the template whole. `false` when the row doesn't exist,
 * isn't a user template, or belongs to someone else.
 */
export async function deleteUserTemplate(ownerId: string, id: string): Promise<boolean> {
  const row = await prisma.mockupTemplate.findUnique({ where: { id } });
  if (!row || row.source !== "user" || row.ownerId !== ownerId) return false;
  requireR2("Storage isn't set up yet — this template can't be deleted.");
  await deleteObject(row.filename);
  await prisma.mockupTemplate.delete({ where: { id } });
  return true;
}

/**
 * A library template's raw bytes from R2, or `null` for a name with no
 * library row (so no key outside `templates/library/` can be reached).
 */
export async function getLibraryTemplateImage(
  filename: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  if (!isLibraryFilename(filename)) return null;
  const row = await prisma.mockupTemplate.findUnique({ where: { filename } });
  if (!row || row.source !== "library") return null;
  requireR2("Storage isn't set up yet — this template's image can't be loaded.");
  const obj = await getObject(libraryTemplateKey(filename));
  return obj && { body: obj.body, contentType: contentTypeFor(filename) };
}

/** The raw template a render uses — library files for anyone, a user upload only for its owner. */
export async function readTemplateForRender(
  ref: TemplateRef,
  userId: string,
): Promise<{ body: Buffer; contentType: string } | null> {
  return ref.source === "library" ? getLibraryTemplateImage(ref.filename) : getUserTemplateImage(userId, ref.id);
}
