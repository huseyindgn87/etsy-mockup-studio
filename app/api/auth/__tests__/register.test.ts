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
import { setThrottleStore } from "@/lib/auth/throttle";
import { createMemoryThrottleStore } from "@/lib/auth/__tests__/memory-throttle-store";

function req(body: unknown, ip = "203.0.113.7") {
  return new Request("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  setThrottleStore(createMemoryThrottleStore());
  users.clear();
  nextId = 1;
});

describe("POST /api/auth/register", () => {
  const valid = { email: "seller@example.com", password: "goodpassword", confirmPassword: "goodpassword" };

  test("creates an account and returns 201", async () => {
    const res = await POST(req(valid));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(users.get("seller@example.com")).toBeDefined();
  });

  test("hashes the password — it is never stored in plain text", async () => {
    await POST(req(valid));
    const stored = users.get("seller@example.com");
    expect(stored).toBeDefined();
    expect(stored!.passwordHash).not.toBe("goodpassword");
    expect(stored!.passwordHash).not.toContain("goodpassword");
    expect(stored!.passwordHash).toMatch(/^\$2[aby]\$12\$/);
  });

  test("a duplicate email gets the same answer as a new one, and the existing account is untouched", async () => {
    const first = await POST(req(valid));
    const original = users.get("seller@example.com")!.passwordHash;
    const res = await POST(req({ ...valid, password: "differentpass", confirmPassword: "differentpass" }));
    expect(res.status).toBe(first.status);
    expect(await res.json()).toEqual({ ok: true });
    expect(users.size).toBe(1);
    expect(users.get("seller@example.com")!.passwordHash).toBe(original);
  });

  test("allows 5 sign-ups per IP per hour, then answers 429 with when to retry", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-18T10:00:00Z"), toFake: ["Date"] });
    try {
      for (let i = 0; i < 5; i++) {
        expect((await POST(req({ ...valid, email: `s${i}@example.com` }))).status).toBe(201);
      }
      const blocked = await POST(req({ ...valid, email: "s6@example.com" }));
      expect(blocked.status).toBe(429);
      const body = await blocked.json();
      expect(body.error).toMatch(/Too many sign-ups from this network\. Try again in 60 minutes\./);
      expect(body.retryAt).toBe("2026-09-18T11:00:00.000Z");
      expect(users.has("s6@example.com")).toBe(false);

      expect((await POST(req({ ...valid, email: "other@example.com" }, "198.51.100.1"))).status).toBe(201);

      vi.setSystemTime(new Date("2026-09-18T11:00:01Z"));
      expect((await POST(req({ ...valid, email: "s6@example.com" }))).status).toBe(201);
    } finally {
      vi.useRealTimers();
    }
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
