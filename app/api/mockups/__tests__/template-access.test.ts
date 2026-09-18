import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock("@/auth", () => ({ auth: authMock }));

const storeMocks = vi.hoisted(() => ({
  getLibraryTemplateImage: vi.fn(),
  getUserTemplateImage: vi.fn(),
  saveTemplate: vi.fn(),
  saveUserTemplateCalibration: vi.fn(),
  deleteUserTemplate: vi.fn(),
}));
vi.mock("@/lib/mockup/template-store", () => storeMocks);

import { GET as libraryImageGET } from "@/app/api/mockups/templates/library/[filename]/image/route";
import { GET as userImageGET } from "@/app/api/mockups/templates/[id]/image/route";
import { PUT as adminPUT } from "@/app/api/admin/templates/[filename]/route";
import { DELETE as userTemplateDELETE } from "@/app/api/mockups/templates/[id]/route";

const RAW = await sharp({
  create: { width: 2000, height: 1600, channels: 3, background: { r: 128, g: 128, b: 128 } },
})
  .jpeg({ quality: 95 })
  .toBuffer();

const ADMIN = "admin-id";
const REGULAR = "regular-id";
const signIn = (id: string) => authMock.mockResolvedValue({ user: { id } });
const libraryParams = { params: Promise.resolve({ filename: "shirt.jpg" }) };
const userParams = { params: Promise.resolve({ id: "t1" }) };
const req = (query = "") => new Request(`http://localhost/x${query}`);
const bytesOf = async (res: Response) => Buffer.from(await res.arrayBuffer());

const prevAdmins = process.env.ADMIN_USER_IDS;
beforeEach(() => {
  process.env.ADMIN_USER_IDS = ADMIN;
  storeMocks.getLibraryTemplateImage.mockReset().mockResolvedValue({ body: RAW, contentType: "image/jpeg" });
  storeMocks.getUserTemplateImage.mockReset().mockResolvedValue({ body: RAW, contentType: "image/jpeg" });
  storeMocks.saveTemplate.mockReset();
  storeMocks.deleteUserTemplate.mockReset().mockResolvedValue(true);
  signIn(REGULAR);
});
afterEach(() => {
  process.env.ADMIN_USER_IDS = prevAdmins;
});

describe("raw template files are never served to a regular user", () => {
  test("library templates are not in public/, so no static URL serves them", () => {
    expect(existsSync(path.join(process.cwd(), "public", "templates"))).toBe(false);
  });

  test("a non-admin asking for the raw library file gets a 404 and no bytes of it", async () => {
    const res = await libraryImageGET(req("?raw=1"), libraryParams);
    expect(res.status).toBe(404);
    expect((await bytesOf(res)).includes(RAW.subarray(0, 64))).toBe(false);
    expect(storeMocks.getLibraryTemplateImage).not.toHaveBeenCalled();
  });

  test("a non-admin asking for the raw file of their own upload gets a 404", async () => {
    const res = await userImageGET(req("?raw=1"), userParams);
    expect(res.status).toBe(404);
    expect(storeMocks.getUserTemplateImage).not.toHaveBeenCalled();
  });

  test("a non-admin gets a downscaled, watermarked preview carrying the original size", async () => {
    const res = await libraryImageGET(req(), libraryParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("X-Template-Width")).toBe("2000");
    expect(res.headers.get("X-Template-Height")).toBe("1600");
    const body = await bytesOf(res);
    expect(body.equals(RAW)).toBe(false);
    const meta = await sharp(body).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(1400);

    const plain = await sharp(RAW).resize(1400, 1400, { fit: "inside" }).raw().toBuffer();
    const served = await sharp(body).raw().toBuffer();
    let changed = 0;
    for (let i = 0; i < plain.length; i += 3) if (Math.abs(plain[i] - served[i]) > 12) changed++;
    expect(changed).toBeGreaterThan(1000);
  });

  test("signed out: 401 for previews and raw alike", async () => {
    authMock.mockResolvedValue(null);
    expect((await libraryImageGET(req(), libraryParams)).status).toBe(401);
    expect((await libraryImageGET(req("?raw=1"), libraryParams)).status).toBe(401);
  });

  test("a non-admin cannot modify a library template", async () => {
    const res = await adminPUT(
      new Request("http://localhost/x", { method: "PUT", body: JSON.stringify({ name: "x" }) }),
      libraryParams,
    );
    expect(res.status).toBe(404);
    expect(storeMocks.saveTemplate).not.toHaveBeenCalled();
  });

  test("an admin gets the raw file byte for byte", async () => {
    signIn(ADMIN);
    const res = await libraryImageGET(req("?raw=1"), libraryParams);
    expect(res.status).toBe(200);
    expect((await bytesOf(res)).equals(RAW)).toBe(true);
  });

  test("a name outside the library is a 404", async () => {
    storeMocks.getLibraryTemplateImage.mockResolvedValue(null);
    const res = await libraryImageGET(req(), { params: Promise.resolve({ filename: "..%2F.env.local" }) });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/mockups/templates/[id]", () => {
  test("deletes the caller's own template", async () => {
    const res = await userTemplateDELETE(req(), userParams);
    expect(res.status).toBe(200);
    expect(storeMocks.deleteUserTemplate).toHaveBeenCalledWith(REGULAR, "t1");
  });

  test("answers 404 for a template the caller doesn't own", async () => {
    storeMocks.deleteUserTemplate.mockResolvedValue(false);
    expect((await userTemplateDELETE(req(), userParams)).status).toBe(404);
  });

  test("answers 401 when signed out", async () => {
    authMock.mockResolvedValue(null);
    expect((await userTemplateDELETE(req(), userParams)).status).toBe(401);
    expect(storeMocks.deleteUserTemplate).not.toHaveBeenCalled();
  });
});
