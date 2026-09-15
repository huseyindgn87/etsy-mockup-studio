import { beforeEach, describe, expect, test, vi } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

const rows = new Map<string, { id: string; passwordHash: string }>();

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { passwordHash: string } }) => {
        Object.assign(rows.get(where.id)!, data);
      }),
    },
  },
}));

import { changePassword } from "../change-password";

let hash: string;

beforeEach(async () => {
  hash ??= await hashPassword("correct-password");
  rows.clear();
  rows.set("u1", { id: "u1", passwordHash: hash });
});

describe("changePassword", () => {
  test("updates the hash with the correct current password", async () => {
    const result = await changePassword("u1", {
      currentPassword: "correct-password",
      newPassword: "brand-new-password",
      confirmPassword: "brand-new-password",
    });
    expect(result).toEqual({ ok: true });
    expect(await verifyPassword("brand-new-password", rows.get("u1")!.passwordHash)).toBe(true);
  });

  test("rejects a wrong current password and keeps the old hash", async () => {
    const result = await changePassword("u1", {
      currentPassword: "wrong-password",
      newPassword: "brand-new-password",
      confirmPassword: "brand-new-password",
    });
    expect(result).toEqual({ ok: false, error: "wrong_password" });
    expect(rows.get("u1")!.passwordHash).toBe(hash);
  });

  test("validates length and confirmation before checking the password", async () => {
    const base = { currentPassword: "correct-password" };
    expect(await changePassword("u1", { ...base, newPassword: "short", confirmPassword: "short" })).toEqual({
      ok: false,
      error: "weak_password",
    });
    expect(
      await changePassword("u1", { ...base, newPassword: "long-enough-1", confirmPassword: "long-enough-2" }),
    ).toEqual({ ok: false, error: "password_mismatch" });
    expect(await changePassword("u1", { newPassword: "long-enough-1", confirmPassword: "long-enough-1" })).toEqual({
      ok: false,
      error: "password_required",
    });
  });
});
