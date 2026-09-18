import { beforeEach, describe, expect, test, vi } from "vitest";
import { hashPassword } from "../password";

const users = new Map<string, { id: string; email: string; name: string | null; passwordHash: string; twoFactorEnabled: boolean }>();

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { email: string } }) => users.get(where.email) ?? null),
    },
  },
}));

const { verifyTurnstileMock } = vi.hoisted(() => ({ verifyTurnstileMock: vi.fn() }));
vi.mock("../turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../turnstile")>()),
  verifyTurnstile: verifyTurnstileMock,
}));

import { authorizeCredentials, type SignInContext } from "../authorize";
import { accountKey, lockDurationMs, setThrottleStore } from "../throttle";
import { parseSignInCode } from "../two-factor-codes";
import { createMemoryThrottleStore } from "./memory-throttle-store";

const EMAIL = "seller@example.com";
const PASSWORD = "correct-password";
const T0 = new Date("2026-09-18T10:00:00Z");
let passwordHash: string;
let store: ReturnType<typeof createMemoryThrottleStore>;

const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

/** Runs an attempt and reports what it did: "ok", "fail" (null), or the thrown code. */
async function attempt(email: string, password: string, context: SignInContext = {}): Promise<string> {
  try {
    const user = await authorizeCredentials(email, password, false, {}, { ip: "203.0.113.7", now: T0, ...context });
    return user ? "ok" : "fail";
  } catch (err) {
    return (err as { code: string }).code;
  }
}

async function failTimes(n: number, context: SignInContext = {}, email = EMAIL): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(await attempt(email, "wrong-password", context));
  return out;
}

beforeEach(async () => {
  passwordHash ??= await hashPassword(PASSWORD);
  users.clear();
  users.set(EMAIL, { id: "u1", email: EMAIL, name: null, passwordHash, twoFactorEnabled: false });
  store = createMemoryThrottleStore();
  setThrottleStore(store);
  verifyTurnstileMock.mockReset().mockResolvedValue(true);
});

describe("account lock after failed sign-ins", () => {
  test("3 failures lock the account for 3 minutes, with the end time in the code", async () => {
    const results = await failTimes(3);
    expect(results.slice(0, 2)).toEqual(["fail", "fail"]);
    const { code, until } = parseSignInCode(results[2]);
    expect(code).toBe("account_locked");
    expect(until).toEqual(at(3 * MIN));

    const locked = parseSignInCode(await attempt(EMAIL, PASSWORD, { now: at(2 * MIN) }));
    expect(locked).toEqual({ code: "account_locked", until: at(3 * MIN) });
  });

  test("escalates 3 min → 15 min → 1 hour, which also locks until email verification", async () => {
    expect(lockDurationMs(1)).toBe(3 * MIN);
    expect(lockDurationMs(2)).toBe(15 * MIN);
    expect(lockDurationMs(3)).toBe(60 * MIN);

    await failTimes(3);
    const second = await failTimes(3, { now: at(4 * MIN), turnstileToken: "tok" });
    expect(parseSignInCode(second[2])).toEqual({ code: "account_locked", until: at(19 * MIN) });

    const third = await failTimes(3, { now: at(20 * MIN), turnstileToken: "tok" });
    expect(third[2]).toBe("email_verification_locked");
    expect(store.rows.get(accountKey(EMAIL))).toMatchObject({ lockLevel: 3, emailLocked: true });
  });

  test("the email-verification lock outlasts the hour and blocks even the right password", async () => {
    store.rows.set(accountKey(EMAIL), {
      key: accountKey(EMAIL),
      failures: 0,
      lockLevel: 3,
      lockedUntil: at(60 * MIN),
      emailLocked: true,
      windowStart: T0,
    });
    const later = { now: at(24 * 60 * MIN), turnstileToken: "tok" };
    expect(await attempt(EMAIL, PASSWORD, later)).toBe("email_verification_locked");
    expect(verifyTurnstileMock).not.toHaveBeenCalled();
  });

  test("a successful sign-in resets the count and the lock level", async () => {
    await failTimes(2);
    expect(await attempt(EMAIL, PASSWORD)).toBe("ok");
    expect(store.rows.has(accountKey(EMAIL))).toBe(false);
    expect(await failTimes(2)).toEqual(["fail", "fail"]);

    await failTimes(1);
    expect(await attempt(EMAIL, PASSWORD, { now: at(4 * MIN), turnstileToken: "tok" })).toBe("ok");
    expect(store.rows.has(accountKey(EMAIL))).toBe(false);
    expect(await attempt(EMAIL, PASSWORD, { now: at(5 * MIN) })).toBe("ok");
  });
});

describe("Turnstile after the first lock", () => {
  test("not asked for before any lock", async () => {
    await failTimes(2);
    expect(await attempt(EMAIL, PASSWORD)).toBe("ok");
    expect(verifyTurnstileMock).not.toHaveBeenCalled();
  });

  test("once the lock ends, an attempt without a token is refused and not counted", async () => {
    await failTimes(3);
    const after = { now: at(4 * MIN) };
    expect(await attempt(EMAIL, PASSWORD, after)).toBe("human_check_required");
    expect(await attempt(EMAIL, "wrong-password", after)).toBe("human_check_required");
    expect(store.rows.get(accountKey(EMAIL))?.failures).toBe(0);
  });

  test("the token is verified on the server; a failed check is refused", async () => {
    await failTimes(3);
    verifyTurnstileMock.mockResolvedValueOnce(false);
    expect(await attempt(EMAIL, PASSWORD, { now: at(4 * MIN), turnstileToken: "bad" })).toBe("human_check_failed");
    expect(verifyTurnstileMock).toHaveBeenCalledWith("bad", "203.0.113.7");
    expect(await attempt(EMAIL, PASSWORD, { now: at(4 * MIN), turnstileToken: "good" })).toBe("ok");
  });

  test("still required for every attempt after the second lock", async () => {
    await failTimes(3);
    await failTimes(3, { now: at(4 * MIN), turnstileToken: "tok" });
    expect(await attempt(EMAIL, PASSWORD, { now: at(20 * MIN) })).toBe("human_check_required");
  });
});

describe("per-IP limit", () => {
  test("20 failures from one IP within 15 minutes block it until the window ends", async () => {
    for (let i = 0; i < 20; i++) {
      const email = `user${i}@example.com`;
      expect(await attempt(email, "wrong-password", { now: at(i * 1000) })).toBe("fail");
    }
    const blocked = parseSignInCode(await attempt(EMAIL, PASSWORD, { now: at(60_000) }));
    expect(blocked).toEqual({ code: "rate_limited", until: at(15 * MIN) });

    expect(await attempt(EMAIL, PASSWORD, { now: at(60_000), ip: "198.51.100.1" })).toBe("ok");
    expect(await attempt(EMAIL, PASSWORD, { now: at(15 * MIN + 1) })).toBe("ok");
  });
});

describe("never reveals whether an email has an account", () => {
  test("an unknown email fails, locks and escalates exactly like a real one", async () => {
    const real = await failTimes(3, {}, EMAIL);
    const unknown = await failTimes(3, {}, "nobody@example.com");
    expect(unknown).toEqual(real);

    const realLater = await failTimes(3, { now: at(4 * MIN), turnstileToken: "tok" }, EMAIL);
    const unknownLater = await failTimes(3, { now: at(4 * MIN), turnstileToken: "tok" }, "nobody@example.com");
    expect(unknownLater).toEqual(realLater);
    expect(await attempt("nobody@example.com", "x", { now: at(20 * MIN) })).toBe("human_check_required");
  });

  test("no sign-in code or message names the email or says whether it exists", async () => {
    const codes = [
      ...(await failTimes(3, {}, "nobody@example.com")),
      ...(await failTimes(3, {}, EMAIL)),
    ];
    for (const code of codes) {
      expect(code).not.toMatch(/example\.com|exist|unknown|not found|no account/i);
    }
  });
});
