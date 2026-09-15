import { beforeEach, describe, expect, test, vi } from "vitest";

const { authMock, changeEmailMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  changeEmailMock: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/account/change-email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/account/change-email")>()),
  changeEmail: changeEmailMock,
}));

import { POST } from "@/app/api/account/email/route";

function req(body: unknown) {
  return new Request("http://localhost/api/account/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  authMock.mockReset().mockResolvedValue({ user: { id: "u1" } });
  changeEmailMock.mockReset();
});

describe("POST /api/account/email", () => {
  test("401 when signed out — never reaches the change", async () => {
    authMock.mockResolvedValue(null);
    const res = await POST(req({ newEmail: "new@example.com", currentPassword: "x" }));
    expect(res.status).toBe(401);
    expect(changeEmailMock).not.toHaveBeenCalled();
  });

  test("passes the signed-in user's id and the submitted password through", async () => {
    changeEmailMock.mockResolvedValue({ ok: true, email: "new@example.com" });
    const res = await POST(req({ newEmail: "new@example.com", currentPassword: "correct-password" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "new@example.com" });
    expect(changeEmailMock).toHaveBeenCalledWith("u1", {
      newEmail: "new@example.com",
      currentPassword: "correct-password",
    });
  });

  test("400 with a clear message when the password is missing", async () => {
    changeEmailMock.mockResolvedValue({ ok: false, error: "password_required" });
    const res = await POST(req({ newEmail: "new@example.com" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/current password/i);
  });

  test("403 for a wrong password, 409 for a taken address", async () => {
    changeEmailMock.mockResolvedValueOnce({ ok: false, error: "wrong_password" });
    expect((await POST(req({ newEmail: "a@b.co", currentPassword: "nope" }))).status).toBe(403);

    changeEmailMock.mockResolvedValueOnce({ ok: false, error: "email_taken" });
    expect((await POST(req({ newEmail: "a@b.co", currentPassword: "yes" }))).status).toBe(409);
  });
});
