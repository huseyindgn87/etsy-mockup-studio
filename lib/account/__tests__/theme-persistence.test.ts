import { beforeEach, describe, expect, test, vi } from "vitest";

interface Row {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  theme: string;
}

const rows = new Map<string, Row>();
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.get(where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return { firstName: row.firstName, lastName: row.lastName, theme: row.theme };
      }),
    },
  },
}));

import { getCurrentUser } from "../current-user";
import { updateProfile, validateProfileUpdate } from "../profile";
import { coerceTheme, THEMES } from "../theme";

beforeEach(() => {
  rows.clear();
  rows.set("u1", { id: "u1", email: "seller@example.com", firstName: null, lastName: null, theme: "light" });
  authMock.mockReset().mockResolvedValue({ user: { id: "u1" } });
});

describe("theme choices", () => {
  test("are exactly Light and Dark — no system/OS option", () => {
    expect([...THEMES]).toEqual(["light", "dark"]);
    expect(validateProfileUpdate({ theme: "system" })).toEqual({ ok: false, error: "invalid_theme" });
    expect(validateProfileUpdate({ theme: "auto" })).toEqual({ ok: false, error: "invalid_theme" });
  });

  test("an unknown stored value renders as light", () => {
    expect(coerceTheme("system")).toBe("light");
    expect(coerceTheme(null)).toBe("light");
  });
});

describe("theme persistence", () => {
  test("saving Dark writes it to the user's DB row", async () => {
    const result = await updateProfile("u1", { theme: "dark" });
    expect(result).toEqual({ ok: true, profile: { firstName: null, lastName: null, theme: "dark" } });
    expect(rows.get("u1")!.theme).toBe("dark");
  });

  test("the stored theme is what the next page load reads back (root layout's source)", async () => {
    await updateProfile("u1", { theme: "dark" });
    expect((await getCurrentUser())?.theme).toBe("dark");

    await updateProfile("u1", { theme: "light" });
    expect((await getCurrentUser())?.theme).toBe("light");
  });

  test("is per user — one account's choice never leaks into another's", async () => {
    rows.set("u2", { id: "u2", email: "other@example.com", firstName: null, lastName: null, theme: "light" });
    await updateProfile("u1", { theme: "dark" });

    authMock.mockResolvedValue({ user: { id: "u2" } });
    expect((await getCurrentUser())?.theme).toBe("light");
  });

  test("an invalid theme is rejected without touching the row", async () => {
    const result = await updateProfile("u1", { theme: "purple" });
    expect(result).toEqual({ ok: false, error: "invalid_theme" });
    expect(rows.get("u1")!.theme).toBe("light");
  });

  test("signed out: no user, so the layout falls back to the default theme", async () => {
    authMock.mockResolvedValue(null);
    expect(await getCurrentUser()).toBeNull();
  });
});

describe("profile names", () => {
  test("trims names and stores blank as null", async () => {
    await updateProfile("u1", { firstName: "  Ada ", lastName: "   " });
    expect(rows.get("u1")).toMatchObject({ firstName: "Ada", lastName: null });
  });

  test("rejects an over-long name", () => {
    expect(validateProfileUpdate({ firstName: "x".repeat(101) })).toEqual({ ok: false, error: "name_too_long" });
  });

  test("rejects an empty update", () => {
    expect(validateProfileUpdate({})).toEqual({ ok: false, error: "empty" });
  });
});
