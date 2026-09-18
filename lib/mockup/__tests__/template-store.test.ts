import { beforeEach, describe, expect, test, vi } from "vitest";

const dirents = (names: string[]) => names.map((name) => ({ name, isFile: () => true }));

let templateFiles: string[] = [];
vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(async () => dirents(templateFiles)),
  readFile: vi.fn(async () => Buffer.from("raw")),
}));

interface Row {
  id: string;
  ownerId: string | null;
  source: string;
  filename: string;
  name: string;
  productType: string;
  colour: string;
  dpiHint: number;
  quad: unknown;
  calibrated: boolean;
  createdAt: Date;
  updatedAt: Date;
}

let rows: Row[] = [];
let nextId = 1;

function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, v]) => (row as unknown as Record<string, unknown>)[k] === v);
}

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    mockupTemplate: {
      findMany: vi.fn(async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: { createdAt: "asc" | "desc" } } = {}) => {
        let out = rows.filter((r) => matches(r, where));
        if (orderBy?.createdAt === "desc") out = [...out].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return out;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { filename: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const existing = rows.find((r) => r.filename === where.filename);
          if (existing) {
            Object.assign(existing, update, { updatedAt: new Date() });
            return existing;
          }
          const row: Row = {
            id: `row-${nextId++}`,
            ownerId: null,
            source: "library",
            name: "",
            productType: "",
            colour: "",
            dpiHint: 300,
            quad: [],
            calibrated: false,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...create,
          } as Row;
          rows.push(row);
          return row;
        },
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = {
          id: `row-${nextId++}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        } as Row;
        rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
    },
  },
}));

// `vi.mock` factories are hoisted above this file's own top-level statements,
// so anything they close over must go through `vi.hoisted` (a bare `const`/
// `let` here would TDZ-error the first time the mocked module loads).
const r2Mocks = vi.hoisted(() => ({
  putObject: vi.fn(async () => undefined),
  getObject: vi.fn(async () => ({ body: Buffer.from("img"), contentType: "image/png" })),
  r2State: { configured: true },
}));
const { putObject, getObject } = r2Mocks;
vi.mock("@/lib/storage/r2", () => ({
  isR2Configured: () => r2Mocks.r2State.configured,
  putObject: r2Mocks.putObject,
  getObject: r2Mocks.getObject,
  userTemplateKey: (ownerId: string, storageName: string) => `templates/user/${ownerId}/${storageName}`,
}));

import { encodeRaster } from "../server";
import { solid } from "./helpers";
import {
  createUserTemplate,
  getUserTemplateImage,
  getLibraryTemplateImage,
  listTemplateFiles,
  listTemplates,
  listUserTemplates,
  saveTemplate,
  saveUserTemplateCalibration,
} from "../template-store";
import { MIN_TEMPLATE_SHORT_EDGE } from "../template-limits";
import { DEFAULT_QUAD } from "../types";

async function bigImage(): Promise<Buffer> {
  return encodeRaster(solid(MIN_TEMPLATE_SHORT_EDGE, MIN_TEMPLATE_SHORT_EDGE, 10, 20, 30), { format: "png" });
}
async function smallImage(): Promise<Buffer> {
  return encodeRaster(solid(10, 10, 1, 1, 1), { format: "png" });
}

beforeEach(() => {
  templateFiles = [];
  rows = [];
  nextId = 1;
  r2Mocks.r2State.configured = true;
  putObject.mockClear();
  getObject.mockClear();
});

describe("library templates", () => {
  test("getLibraryTemplateImage reads only files in the library", async () => {
    templateFiles = ["shirt.png"];
    expect(await getLibraryTemplateImage("../.env.local")).toBeNull();
    expect(await getLibraryTemplateImage("shirt.png")).toEqual({ body: Buffer.from("raw"), contentType: "image/png" });
  });

  test("listTemplateFiles reads only jpg/jpeg/png from templates/", async () => {
    templateFiles = ["a.png", "b.JPG", "c.txt", "d.jpeg"];
    const files = await listTemplateFiles();
    expect(files).toEqual(["a.png", "b.JPG", "d.jpeg"]);
  });

  test("listTemplates joins files with saved rows and defaults the rest", async () => {
    templateFiles = ["shirt.png", "mug.png"];
    await saveTemplate("shirt.png", { name: "Shirt", productType: "T-shirt", colour: "White", dpiHint: 300, quad: DEFAULT_QUAD });

    const list = await listTemplates();
    expect(list).toHaveLength(2);
    const shirt = list.find((t) => t.filename === "shirt.png")!;
    expect(shirt.calibrated).toBe(true);
    expect(shirt.source).toBe("library");
    expect(shirt.ownerId).toBeNull();
    expect(shirt.imageUrl).toBe("/api/mockups/templates/library/shirt.png/image");

    const mug = list.find((t) => t.filename === "mug.png")!;
    expect(mug.calibrated).toBe(false);
    expect(mug.id).toBeNull();
  });

  test("saveTemplate rejects a filename with no matching file", async () => {
    templateFiles = [];
    await expect(
      saveTemplate("ghost.png", { name: "", productType: "", colour: "", dpiHint: 300, quad: DEFAULT_QUAD }),
    ).rejects.toThrow(/no template file/i);
  });

  test("listTemplates never includes a user-sourced row", async () => {
    templateFiles = ["shirt.png"];
    await createUserTemplate("u1", { bytes: await bigImage(), originalFilename: "mine.png", contentType: "image/png" });
    const list = await listTemplates();
    expect(list.every((t) => t.source === "library")).toBe(true);
  });
});

describe("createUserTemplate", () => {
  test("stores the image in R2 and creates an uncalibrated row", async () => {
    const template = await createUserTemplate("u1", {
      bytes: await bigImage(),
      originalFilename: "My Design.png",
      contentType: "image/png",
    });
    expect(template.source).toBe("user");
    expect(template.ownerId).toBe("u1");
    expect(template.calibrated).toBe(false);
    expect(template.quad).toEqual(DEFAULT_QUAD);
    expect(template.imageUrl).toBe(`/api/mockups/templates/${template.id}/image`);
    expect(putObject).toHaveBeenCalledTimes(1);
    const [key] = putObject.mock.calls[0] as unknown as [string, Buffer, string];
    expect(key).toMatch(/^templates\/user\/u1\/[0-9a-f-]+\.png$/);
  });

  test("rejects when the image is too small, without touching R2", async () => {
    await expect(
      createUserTemplate("u1", { bytes: await smallImage(), originalFilename: "tiny.png", contentType: "image/png" }),
    ).rejects.toThrow(/shorter side/i);
    expect(putObject).not.toHaveBeenCalled();
  });

  test("degrades with a clear error when R2 isn't configured, without creating a row", async () => {
    r2Mocks.r2State.configured = false;
    await expect(
      createUserTemplate("u1", { bytes: await bigImage(), originalFilename: "mine.png", contentType: "image/png" }),
    ).rejects.toThrow(/storage/i);
    expect(rows).toHaveLength(0);
  });

  test("two uploads with the same original filename get distinct storage keys", async () => {
    const bytes = await bigImage();
    const a = await createUserTemplate("u1", { bytes, originalFilename: "design.png", contentType: "image/png" });
    const b = await createUserTemplate("u1", { bytes, originalFilename: "design.png", contentType: "image/png" });
    expect(a.filename).not.toBe(b.filename);
  });
});

describe("listUserTemplates", () => {
  test("only returns a user's own uploads, most recent first", async () => {
    await createUserTemplate("u1", { bytes: await bigImage(), originalFilename: "one.png", contentType: "image/png" });
    await createUserTemplate("u2", { bytes: await bigImage(), originalFilename: "two.png", contentType: "image/png" });
    const mine = await listUserTemplates("u1");
    expect(mine).toHaveLength(1);
    expect(mine[0].ownerId).toBe("u1");
  });
});

describe("saveUserTemplateCalibration", () => {
  test("saves a deliberate quad and marks the template calibrated", async () => {
    const created = await createUserTemplate("u1", { bytes: await bigImage(), originalFilename: "a.png", contentType: "image/png" });
    const quad = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]] as const;
    const saved = await saveUserTemplateCalibration("u1", created.id!, {
      name: "Mug",
      productType: "Mug",
      colour: "White",
      dpiHint: 300,
      quad,
    });
    expect(saved.calibrated).toBe(true);
    expect(saved.quad).toEqual(quad);
  });

  test("rejects a template owned by someone else", async () => {
    const created = await createUserTemplate("u1", { bytes: await bigImage(), originalFilename: "a.png", contentType: "image/png" });
    await expect(
      saveUserTemplateCalibration("u2", created.id!, { name: "", productType: "", colour: "", dpiHint: 300, quad: DEFAULT_QUAD }),
    ).rejects.toThrow(/not found/i);
  });

  test("rejects a library template id", async () => {
    templateFiles = ["shirt.png"];
    const saved = await saveTemplate("shirt.png", { name: "Shirt", productType: "", colour: "", dpiHint: 300, quad: DEFAULT_QUAD });
    await expect(
      saveUserTemplateCalibration("u1", saved.id!, { name: "", productType: "", colour: "", dpiHint: 300, quad: DEFAULT_QUAD }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("getUserTemplateImage", () => {
  test("streams bytes back for the owner", async () => {
    const created = await createUserTemplate("u1", { bytes: await bigImage(), originalFilename: "a.png", contentType: "image/png" });
    const obj = await getUserTemplateImage("u1", created.id!);
    expect(obj).not.toBeNull();
    expect(getObject).toHaveBeenCalledWith(created.filename);
  });

  test("returns null for someone else's template", async () => {
    const created = await createUserTemplate("u1", { bytes: await bigImage(), originalFilename: "a.png", contentType: "image/png" });
    expect(await getUserTemplateImage("u2", created.id!)).toBeNull();
  });

  test("returns null for an unknown id", async () => {
    expect(await getUserTemplateImage("u1", "missing")).toBeNull();
  });

  test("throws a clear error when R2 isn't configured", async () => {
    const created = await createUserTemplate("u1", { bytes: await bigImage(), originalFilename: "a.png", contentType: "image/png" });
    r2Mocks.r2State.configured = false;
    await expect(getUserTemplateImage("u1", created.id!)).rejects.toThrow(/storage/i);
  });
});
