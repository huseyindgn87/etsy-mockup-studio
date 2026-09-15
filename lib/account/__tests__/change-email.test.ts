import { beforeEach, describe, expect, test, vi } from "vitest";
import { hashPassword } from "@/lib/auth/password";

interface Row {
  id: string;
  email: string;
  passwordHash: string;
}

const rows = new Map<string, Row>();
const { updateMock } = vi.hoisted(() => ({ updateMock: vi.fn() }));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.id) return rows.get(where.id) ?? null;
        return [...rows.values()].find((r) => r.email === where.email) ?? null;
      }),
      update: updateMock,
    },
  },
}));

import { changeEmail } from "../change-email";

let hash: string;

beforeEach(async () => {
  hash ??= await hashPassword("correct-password");
  rows.clear();
  rows.set("u1", { id: "u1", email: "seller@example.com", passwordHash: hash });
  rows.set("u2", { id: "u2", email: "taken@example.com", passwordHash: hash });
  updateMock.mockReset().mockImplementation(
    async ({ where, data }: { where: { id: string }; data: { email: string } }) => {
      Object.assign(rows.get(where.id)!, data);
      return rows.get(where.id);
    },
  );
});

describe("changeEmail", () => {
  test("requires the current password — without it nothing is written", async () => {
    const result = await changeEmail("u1", { newEmail: "new@example.com" });
    expect(result).toEqual({ ok: false, error: "password_required" });

    const blank = await changeEmail("u1", { newEmail: "new@example.com", currentPassword: "" });
    expect(blank).toEqual({ ok: false, error: "password_required" });

    expect(updateMock).not.toHaveBeenCalled();
    expect(rows.get("u1")!.email).toBe("seller@example.com");
  });

  test("rejects a wrong current password — nothing is written", async () => {
    const result = await changeEmail("u1", { newEmail: "new@example.com", currentPassword: "wrong-password" });
    expect(result).toEqual({ ok: false, error: "wrong_password" });
    expect(updateMock).not.toHaveBeenCalled();
    expect(rows.get("u1")!.email).toBe("seller@example.com");
  });

  test("changes the email (normalized) with the correct current password", async () => {
    const result = await changeEmail("u1", { newEmail: "  New@Example.com ", currentPassword: "correct-password" });
    expect(result).toEqual({ ok: true, email: "new@example.com" });
    expect(rows.get("u1")!.email).toBe("new@example.com");
  });

  test("doesn't reveal whether an address is taken without the right password", async () => {
    const result = await changeEmail("u1", { newEmail: "taken@example.com", currentPassword: "wrong-password" });
    expect(result).toEqual({ ok: false, error: "wrong_password" });
  });

  test("rejects an address another account already uses", async () => {
    const result = await changeEmail("u1", { newEmail: "taken@example.com", currentPassword: "correct-password" });
    expect(result).toEqual({ ok: false, error: "email_taken" });
    expect(updateMock).not.toHaveBeenCalled();
  });

  test("maps a unique-constraint race to email_taken", async () => {
    updateMock.mockRejectedValue(Object.assign(new Error("Unique constraint"), { code: "P2002" }));
    const result = await changeEmail("u1", { newEmail: "new@example.com", currentPassword: "correct-password" });
    expect(result).toEqual({ ok: false, error: "email_taken" });
  });

  test("rejects an invalid address and the current address", async () => {
    expect(await changeEmail("u1", { newEmail: "nope", currentPassword: "correct-password" })).toEqual({
      ok: false,
      error: "invalid_email",
    });
    expect(
      await changeEmail("u1", { newEmail: "seller@example.com", currentPassword: "correct-password" }),
    ).toEqual({ ok: false, error: "same_email" });
  });
});
