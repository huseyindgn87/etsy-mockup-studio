import { beforeEach, describe, expect, test, vi } from "vitest";

interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
}

const users = new Map<string, StoredUser>();
let nextId = 1;

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { email: string } }) => users.get(where.email) ?? null),
      create: vi.fn(
        async ({ data }: { data: { email: string; passwordHash: string } }) => {
          const user: StoredUser = { id: `u${nextId++}`, email: data.email, passwordHash: data.passwordHash };
          users.set(data.email, user);
          return { id: user.id, email: user.email };
        },
      ),
    },
  },
}));

import { POST } from "@/app/api/auth/register/route";

function req(body: unknown) {
  return new Request("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  users.clear();
  nextId = 1;
});

describe("POST /api/auth/register", () => {
  const valid = { email: "seller@example.com", password: "goodpassword", confirmPassword: "goodpassword" };

  test("creates an account and returns 201", async () => {
    const res = await POST(req(valid));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.email).toBe("seller@example.com");
  });

  test("hashes the password — it is never stored in plain text", async () => {
    await POST(req(valid));
    const stored = users.get("seller@example.com");
    expect(stored).toBeDefined();
    expect(stored!.passwordHash).not.toBe("goodpassword");
    expect(stored!.passwordHash).not.toContain("goodpassword");
    expect(stored!.passwordHash).toMatch(/^\$2[aby]\$12\$/);
  });

  test("rejects a duplicate email with 409, without creating a second row", async () => {
    await POST(req(valid));
    const res = await POST(req(valid));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already exists/i);
  });

  test("rejects a weak (short) password with 400", async () => {
    const res = await POST(req({ ...valid, password: "short1", confirmPassword: "short1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/8 characters/i);
    expect(users.size).toBe(0);
  });

  test("rejects an invalid email with 400", async () => {
    const res = await POST(req({ ...valid, email: "not-an-email" }));
    expect(res.status).toBe(400);
    expect(users.size).toBe(0);
  });

  test("rejects mismatched password confirmation with 400", async () => {
    const res = await POST(req({ ...valid, confirmPassword: "somethingElse123" }));
    expect(res.status).toBe(400);
    expect(users.size).toBe(0);
  });

  test("400 on a non-JSON body", async () => {
    const res = await POST(new Request("http://localhost/api/auth/register", { method: "POST", body: "not json" }));
    expect(res.status).toBe(400);
  });
});
