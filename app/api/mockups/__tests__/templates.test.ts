import { beforeEach, describe, expect, test, vi } from "vitest";
import sharp from "sharp";

// A plain `vi.fn()` (not typed against the real, overloaded `auth` export)
// sidesteps TS picking the wrong overload (the Proxy-wrapping one) when this
// mock is later called with `.mockResolvedValue(...)`.
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock("@/auth", () => ({ auth: authMock }));

const DEFAULT_QUAD = [
  [0.3, 0.3],
  [0.7, 0.3],
  [0.7, 0.68],
  [0.3, 0.68],
];

const TEMPLATE = {
  id: "t1",
  source: "user" as const,
  ownerId: "u1",
  filename: "templates/user/u1/abc.png",
  name: "My design",
  productType: "",
  colour: "",
  dpiHint: 300,
  quad: DEFAULT_QUAD,
  calibrated: false,
  imageUrl: "/api/mockups/templates/t1/image",
};

// `vi.mock` factories are hoisted above this file's own top-level statements,
// so anything they close over must go through `vi.hoisted` (a bare `const`
// here would TDZ-error the first time the mocked module loads).
const storeMocks = vi.hoisted(() => ({
  listTemplates: vi.fn(async () => [] as unknown[]),
  listUserTemplates: vi.fn(async () => [] as unknown[]),
  createUserTemplate: vi.fn(async () => ({}) as unknown),
  saveUserTemplateCalibration: vi.fn(async () => ({}) as unknown),
  getUserTemplateImage: vi.fn(
    async (): Promise<{ body: Buffer; contentType: string } | null> => null,
  ),
}));
const {
  listTemplates,
  listUserTemplates,
  createUserTemplate,
  saveUserTemplateCalibration,
  getUserTemplateImage,
} = storeMocks;

vi.mock("@/lib/mockup/template-store", () => storeMocks);

import { GET as listGET, POST as uploadPOST } from "@/app/api/mockups/templates/route";
import { PUT as calibratePUT } from "@/app/api/mockups/templates/[id]/route";
import { GET as imageGET } from "@/app/api/mockups/templates/[id]/image/route";

function withSession() {
  authMock.mockResolvedValue({
    user: { id: "u1", email: "seller@example.com" },
  });
}

const RAW_PNG = await sharp({
  create: { width: 40, height: 30, channels: 3, background: { r: 90, g: 90, b: 90 } },
})
  .png()
  .toBuffer();

beforeEach(() => {
  authMock.mockClear();
  withSession();
  listTemplates.mockClear().mockResolvedValue([]);
  listUserTemplates.mockClear().mockResolvedValue([]);
  createUserTemplate.mockClear().mockResolvedValue(TEMPLATE);
  saveUserTemplateCalibration.mockClear().mockResolvedValue({ ...TEMPLATE, calibrated: true });
  getUserTemplateImage.mockClear().mockResolvedValue({ body: RAW_PNG, contentType: "image/png" });
});

describe("GET /api/mockups/templates", () => {
  test("401 when not signed in", async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await listGET();
    expect(res.status).toBe(401);
  });

  test("returns library + the caller's own templates", async () => {
    listTemplates.mockResolvedValueOnce([{ filename: "shirt.png" }]);
    listUserTemplates.mockResolvedValueOnce([TEMPLATE]);
    const res = await listGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.library).toEqual([{ filename: "shirt.png" }]);
    expect(body.mine).toEqual([TEMPLATE]);
    expect(listUserTemplates).toHaveBeenCalledWith("u1");
  });

  test("500 with a readable message when the store throws (e.g. a stale Prisma client)", async () => {
    listTemplates.mockRejectedValueOnce(new Error("Unknown argument `source`."));
    const res = await listGET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Unknown argument `source`.");
  });
});

function uploadReq(file: File | null) {
  const fd = new FormData();
  if (file) fd.set("file", file);
  return new Request("http://localhost/api/mockups/templates", { method: "POST", body: fd });
}

describe("POST /api/mockups/templates", () => {
  test("401 when not signed in", async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await uploadPOST(uploadReq(new File(["x"], "a.png", { type: "image/png" })));
    expect(res.status).toBe(401);
  });

  test("400 when the file field is missing", async () => {
    const res = await uploadPOST(uploadReq(null));
    expect(res.status).toBe(400);
  });

  test("413 when the file is over the size cap", async () => {
    const big = new File([new Uint8Array(15 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
    const res = await uploadPOST(uploadReq(big));
    expect(res.status).toBe(413);
    expect(createUserTemplate).not.toHaveBeenCalled();
  });

  test("uploads and returns the created template", async () => {
    const res = await uploadPOST(uploadReq(new File(["x"], "a.png", { type: "image/png" })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.template).toEqual(TEMPLATE);
    expect(createUserTemplate).toHaveBeenCalledWith("u1", expect.objectContaining({ originalFilename: "a.png" }));
  });

  test("400 with the store's error message on validation failure", async () => {
    createUserTemplate.mockRejectedValueOnce(new Error("Image is too small."));
    const res = await uploadPOST(uploadReq(new File(["x"], "a.png", { type: "image/png" })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Image is too small.");
  });
});

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("PUT /api/mockups/templates/[id]", () => {
  function putReq(body: unknown) {
    return new Request("http://localhost/api/mockups/templates/t1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("401 when not signed in", async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await calibratePUT(putReq({ quad: DEFAULT_QUAD }), idParams("t1"));
    expect(res.status).toBe(401);
  });

  test("400 on a non-JSON body", async () => {
    const res = await calibratePUT(new Request("http://localhost/x", { method: "PUT", body: "not json" }), idParams("t1"));
    expect(res.status).toBe(400);
  });

  test("saves and returns the updated template", async () => {
    const res = await calibratePUT(
      putReq({ name: "Mug", productType: "Mug", colour: "White", dpiHint: 300, quad: DEFAULT_QUAD }),
      idParams("t1"),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).template.calibrated).toBe(true);
    expect(saveUserTemplateCalibration).toHaveBeenCalledWith("u1", "t1", {
      name: "Mug",
      productType: "Mug",
      colour: "White",
      dpiHint: 300,
      quad: DEFAULT_QUAD,
    });
  });

  test("404 when the store rejects (not found / not owned)", async () => {
    saveUserTemplateCalibration.mockRejectedValueOnce(new Error("Template not found."));
    const res = await calibratePUT(putReq({ quad: DEFAULT_QUAD }), idParams("t1"));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/mockups/templates/[id]/image", () => {
  test("401 when not signed in", async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await imageGET(new Request("http://localhost/x"), idParams("t1"));
    expect(res.status).toBe(401);
  });

  test("answers with a watermarked JPEG preview, never the stored file", async () => {
    const res = await imageGET(new Request("http://localhost/x"), idParams("t1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("X-Template-Width")).toBe("40");
    expect(Buffer.from(await res.arrayBuffer()).equals(RAW_PNG)).toBe(false);
  });

  test("404 when the store returns null", async () => {
    getUserTemplateImage.mockResolvedValueOnce(null);
    const res = await imageGET(new Request("http://localhost/x"), idParams("missing"));
    expect(res.status).toBe(404);
  });

  test("503 with a clear message when storage isn't configured", async () => {
    getUserTemplateImage.mockRejectedValueOnce(new Error("Storage isn't set up yet."));
    const res = await imageGET(new Request("http://localhost/x"), idParams("t1"));
    expect(res.status).toBe(503);
  });
});
