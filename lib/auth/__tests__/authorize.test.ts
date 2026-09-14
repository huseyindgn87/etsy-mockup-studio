import { beforeEach, describe, expect, test, vi } from "vitest";
import { hashPassword } from "../password";

const users = new Map<string, { id: string; email: string; name: string | null; passwordHash: string }>();

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { email: string } }) => users.get(where.email) ?? null),
    },
  },
}));

import { authorizeCredentials } from "../authorize";

beforeEach(() => {
  users.clear();
});

describe("authorizeCredentials (Credentials provider sign-in)", () => {
  test("succeeds with the correct email and password", async () => {
    const passwordHash = await hashPassword("correct-password");
    users.set("seller@example.com", { id: "u1", email: "seller@example.com", name: null, passwordHash });

    const result = await authorizeCredentials("seller@example.com", "correct-password");
    expect(result).toEqual({ id: "u1", email: "seller@example.com", name: null, rememberMe: false });
  });

  test("fails with the wrong password", async () => {
    const passwordHash = await hashPassword("correct-password");
    users.set("seller@example.com", { id: "u1", email: "seller@example.com", name: null, passwordHash });

    const result = await authorizeCredentials("seller@example.com", "wrong-password");
    expect(result).toBeNull();
  });

  test("fails for an email that isn't registered", async () => {
    const result = await authorizeCredentials("nobody@example.com", "whatever123");
    expect(result).toBeNull();
  });

  test("is case-insensitive on email", async () => {
    const passwordHash = await hashPassword("correct-password");
    users.set("seller@example.com", { id: "u1", email: "seller@example.com", name: null, passwordHash });

    const result = await authorizeCredentials("Seller@Example.com", "correct-password");
    expect(result?.id).toBe("u1");
  });

  test("fails when email or password is missing", async () => {
    expect(await authorizeCredentials(undefined, "whatever123")).toBeNull();
    expect(await authorizeCredentials("seller@example.com", undefined)).toBeNull();
  });

  describe("rememberMe", () => {
    beforeEach(async () => {
      const passwordHash = await hashPassword("correct-password");
      users.set("seller@example.com", { id: "u1", email: "seller@example.com", name: null, passwordHash });
    });

    test("defaults to false when omitted", async () => {
      const result = await authorizeCredentials("seller@example.com", "correct-password");
      expect(result?.rememberMe).toBe(false);
    });

    test("is false for the string \"false\" (unchecked, as sent over the wire)", async () => {
      const result = await authorizeCredentials("seller@example.com", "correct-password", "false");
      expect(result?.rememberMe).toBe(false);
    });

    test("is true for a real boolean true", async () => {
      const result = await authorizeCredentials("seller@example.com", "correct-password", true);
      expect(result?.rememberMe).toBe(true);
    });

    test("is true for the string \"true\" — how next-auth/react's signIn() serializes a boolean", async () => {
      const result = await authorizeCredentials("seller@example.com", "correct-password", "true");
      expect(result?.rememberMe).toBe(true);
    });
  });
});
