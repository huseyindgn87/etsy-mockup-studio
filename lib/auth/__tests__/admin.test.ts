import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { authMock, saveTemplateMock, listTemplatesMock, notFoundMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  saveTemplateMock: vi.fn(),
  listTemplatesMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/mockup/template-store", () => ({
  saveTemplate: saveTemplateMock,
  listTemplates: listTemplatesMock,
}));
vi.mock("next/navigation", () => ({ notFound: notFoundMock }));

import { isAdminUserId, parseAdminUserIds } from "../admin";
import { PUT } from "@/app/api/admin/templates/[filename]/route";
import AdminTemplatesPage from "@/app/admin/templates/page";

function put() {
  return PUT(
    new Request("http://localhost/api/admin/templates/tee.jpg", {
      method: "PUT",
      body: JSON.stringify({ name: "Tee", quad: [] }),
    }),
    { params: Promise.resolve({ filename: "tee.jpg" }) },
  );
}

describe("admin user ids", () => {
  test("parses comma- and space-separated ids", () => {
    expect([...parseAdminUserIds(" a, b  c,,")]).toEqual(["a", "b", "c"]);
  });

  test("unset or empty means nobody is an admin", () => {
    expect(isAdminUserId("a", undefined)).toBe(false);
    expect(isAdminUserId("a", "")).toBe(false);
  });

  test("only a listed id is an admin", () => {
    expect(isAdminUserId("a", "a,b")).toBe(true);
    expect(isAdminUserId("c", "a,b")).toBe(false);
    expect(isAdminUserId(null, "a")).toBe(false);
    expect(isAdminUserId("", "a")).toBe(false);
  });
});

describe("admin template routes", () => {
  beforeEach(() => {
    vi.stubEnv("ADMIN_USER_IDS", "admin-1");
    authMock.mockReset();
    saveTemplateMock.mockReset().mockResolvedValue({ filename: "tee.jpg" });
    listTemplatesMock.mockReset().mockResolvedValue([]);
    notFoundMock.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  test("a signed-in non-admin gets 404 from the save route and nothing is saved", async () => {
    authMock.mockResolvedValue({ user: { id: "customer-1" } });
    const res = await put();
    expect(res.status).toBe(404);
    expect(saveTemplateMock).not.toHaveBeenCalled();
  });

  test("with ADMIN_USER_IDS unset even the maintainer is refused", async () => {
    vi.stubEnv("ADMIN_USER_IDS", "");
    authMock.mockResolvedValue({ user: { id: "admin-1" } });
    expect((await put()).status).toBe(404);
    expect(saveTemplateMock).not.toHaveBeenCalled();
  });

  test("an admin can save", async () => {
    authMock.mockResolvedValue({ user: { id: "admin-1" } });
    const res = await put();
    expect(res.status).toBe(200);
    expect(saveTemplateMock).toHaveBeenCalledOnce();
  });

  test("the admin page is a 404 for a non-admin and never reads templates", async () => {
    authMock.mockResolvedValue({ user: { id: "customer-1" } });
    await expect(AdminTemplatesPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(listTemplatesMock).not.toHaveBeenCalled();
  });

  test("the admin page renders for an admin", async () => {
    authMock.mockResolvedValue({ user: { id: "admin-1" } });
    await expect(AdminTemplatesPage()).resolves.toBeTruthy();
    expect(notFoundMock).not.toHaveBeenCalled();
  });
});
