import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/db/prisma", async () => ({
  prisma: (await import("./two-factor-fake-db")).fakePrisma,
}));

import { hashPassword } from "@/lib/auth/password";
import {
  consumeRecoveryCode,
  countRemainingRecoveryCodes,
  verifyTotpForSignIn,
} from "@/lib/auth/second-factor";
import { base32Decode, hotp, timeStep, totpAt } from "@/lib/auth/totp";
import { decryptTwoFactorSecret } from "@/lib/auth/two-factor-key";
import { beginTwoFactorSetup, disableTwoFactor, enableTwoFactor } from "../two-factor";
import { db, resetDb, seedUser } from "./two-factor-fake-db";

let passwordHash: string;

beforeEach(async () => {
  vi.stubEnv("TWO_FACTOR_ENCRYPTION_KEY", "test-two-factor-key-0123456789abcdef");
  passwordHash ??= await hashPassword("correct-password");
  resetDb();
  seedUser({ id: "u1", email: "seller@example.com", passwordHash });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Runs the full enable flow and returns the plain secret and recovery codes. */
async function enable(userId = "u1") {
  const setup = await beginTwoFactorSetup(userId);
  if (!setup.ok) throw new Error(setup.error);
  const result = await enableTwoFactor(userId, totpAt(setup.secret));
  if (!result.ok) throw new Error(result.error);
  return { secret: setup.secret, recoveryCodes: result.recoveryCodes };
}

describe("enable", () => {
  test("setup stores an encrypted pending secret and returns a QR code, without turning 2FA on", async () => {
    const setup = await beginTwoFactorSetup("u1");
    if (!setup.ok) throw new Error(setup.error);

    const user = db.users.get("u1")!;
    expect(user.twoFactorEnabled).toBe(false);
    expect(user.twoFactorSecret).toBeNull();
    expect(user.twoFactorPendingSecret).not.toBeNull();
    expect(user.twoFactorPendingSecret).not.toContain(setup.secret);
    expect(decryptTwoFactorSecret(user.twoFactorPendingSecret!)).toBe(setup.secret);

    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(setup.otpauthUrl).toContain(`secret=${setup.secret}`);
    expect(setup.otpauthUrl).toContain("seller%40example.com");
    // The authenticator app labels the account "Listhouse".
    expect(setup.otpauthUrl.startsWith("otpauth://totp/Listhouse:seller%40example.com?")).toBe(true);
    expect(new URL(setup.otpauthUrl).searchParams.get("issuer")).toBe("Listhouse");
  });

  test("requires a valid 6-digit code — a wrong one leaves 2FA off and issues no codes", async () => {
    const setup = await beginTwoFactorSetup("u1");
    if (!setup.ok) throw new Error(setup.error);
    const wrong = totpAt(setup.secret) === "000000" ? "111111" : "000000";

    expect(await enableTwoFactor("u1", wrong)).toEqual({ ok: false, error: "invalid_code" });
    expect(await enableTwoFactor("u1", "")).toEqual({ ok: false, error: "invalid_code" });
    expect(await enableTwoFactor("u1", "12345")).toEqual({ ok: false, error: "invalid_code" });
    expect(db.users.get("u1")!.twoFactorEnabled).toBe(false);
    expect(db.codes).toHaveLength(0);
  });

  test("can't enable without starting setup first", async () => {
    expect(await enableTwoFactor("u1", "123456")).toEqual({ ok: false, error: "no_pending_setup" });
  });

  test("a valid code turns 2FA on, promotes the secret, and issues 10 hashed single-use recovery codes", async () => {
    const { secret, recoveryCodes } = await enable();

    const user = db.users.get("u1")!;
    expect(user.twoFactorEnabled).toBe(true);
    expect(user.twoFactorPendingSecret).toBeNull();
    expect(decryptTwoFactorSecret(user.twoFactorSecret!)).toBe(secret);
    expect(user.twoFactorSecret).not.toContain(secret);

    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const code of recoveryCodes) expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    expect(db.codes).toHaveLength(10);
    const stored = db.codes.map((c) => c.codeHash).join(" ");
    for (const code of recoveryCodes) {
      expect(stored).not.toContain(code);
      expect(stored).not.toContain(code.replace("-", ""));
    }
    expect(await countRemainingRecoveryCodes("u1")).toBe(10);
  });

  test("setup is refused once 2FA is already on", async () => {
    await enable();
    expect(await beginTwoFactorSetup("u1")).toEqual({ ok: false, error: "already_enabled" });
  });

  test("a missing encryption key fails setup with a clear error before anything is written", async () => {
    vi.stubEnv("TWO_FACTOR_ENCRYPTION_KEY", "");
    await expect(beginTwoFactorSetup("u1")).rejects.toThrow(/Missing TWO_FACTOR_ENCRYPTION_KEY/);
    expect(db.users.get("u1")!.twoFactorPendingSecret).toBeNull();
  });
});

describe("verify at sign-in", () => {
  test("accepts the current code", async () => {
    const { secret } = await enable();
    expect(await verifyTotpForSignIn(db.users.get("u1")!, totpAt(secret))).toBe(true);
  });

  test("rejects a wrong code", async () => {
    const { secret } = await enable();
    const wrong = totpAt(secret) === "000000" ? "111111" : "000000";
    expect(await verifyTotpForSignIn(db.users.get("u1")!, wrong)).toBe(false);
  });

  test("tolerates one step of clock drift, but not two", async () => {
    const { secret } = await enable();
    const now = Date.now();
    const key = base32Decode(secret);
    const step = timeStep(now);

    expect(await verifyTotpForSignIn(db.users.get("u1")!, hotp(key, step - 2), now)).toBe(false);
    expect(await verifyTotpForSignIn(db.users.get("u1")!, hotp(key, step + 1), now)).toBe(true);
  });

  test("a code can't be replayed — nor can an older one after a newer one was used", async () => {
    const { secret } = await enable();
    const now = Date.now();
    const key = base32Decode(secret);
    const step = timeStep(now);

    expect(await verifyTotpForSignIn(db.users.get("u1")!, hotp(key, step), now)).toBe(true);
    expect(await verifyTotpForSignIn(db.users.get("u1")!, hotp(key, step), now)).toBe(false);
    expect(await verifyTotpForSignIn(db.users.get("u1")!, hotp(key, step - 1), now)).toBe(false);
  });
});

describe("recovery codes", () => {
  test("each code works exactly once", async () => {
    const { recoveryCodes } = await enable();
    const [first, second] = recoveryCodes;

    expect(await consumeRecoveryCode("u1", first)).toBe(true);
    expect(await consumeRecoveryCode("u1", first)).toBe(false);
    expect(await countRemainingRecoveryCodes("u1")).toBe(9);

    expect(await consumeRecoveryCode("u1", second)).toBe(true);
    expect(await countRemainingRecoveryCodes("u1")).toBe(8);
  });

  test("concurrent use of the same code succeeds only once", async () => {
    const { recoveryCodes } = await enable();
    const results = await Promise.all([
      consumeRecoveryCode("u1", recoveryCodes[0]),
      consumeRecoveryCode("u1", recoveryCodes[0]),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test("case, spaces and the dash don't matter", async () => {
    const { recoveryCodes } = await enable();
    const typed = ` ${recoveryCodes[0].replace("-", " ").toLowerCase()} `;
    expect(await consumeRecoveryCode("u1", typed)).toBe(true);
  });

  test("one user's code never works for another account", async () => {
    seedUser({ id: "u2", email: "other@example.com", passwordHash });
    const { recoveryCodes } = await enable("u1");
    await enable("u2");
    expect(await consumeRecoveryCode("u2", recoveryCodes[0])).toBe(false);
    expect(await consumeRecoveryCode("u1", recoveryCodes[0])).toBe(true);
  });

  test("made-up or malformed codes are rejected", async () => {
    await enable();
    expect(await consumeRecoveryCode("u1", "AAAAA-AAAAA")).toBe(false);
    expect(await consumeRecoveryCode("u1", "short")).toBe(false);
    expect(await countRemainingRecoveryCodes("u1")).toBe(10);
  });
});

describe("disable", () => {
  test("requires the account password — missing or wrong leaves 2FA on", async () => {
    await enable();
    expect(await disableTwoFactor("u1", undefined)).toEqual({ ok: false, error: "password_required" });
    expect(await disableTwoFactor("u1", "wrong-password")).toEqual({ ok: false, error: "wrong_password" });

    const user = db.users.get("u1")!;
    expect(user.twoFactorEnabled).toBe(true);
    expect(user.twoFactorSecret).not.toBeNull();
    expect(db.codes).toHaveLength(10);
  });

  test("with the password: turns 2FA off, wipes the secret and every recovery code", async () => {
    const { secret, recoveryCodes } = await enable();
    expect(await disableTwoFactor("u1", "correct-password")).toEqual({ ok: true });

    const user = db.users.get("u1")!;
    expect(user).toMatchObject({
      twoFactorEnabled: false,
      twoFactorSecret: null,
      twoFactorPendingSecret: null,
      twoFactorLastUsedStep: null,
    });
    expect(db.codes).toHaveLength(0);
    expect(await consumeRecoveryCode("u1", recoveryCodes[1])).toBe(false);
    expect(await verifyTotpForSignIn(user, totpAt(secret))).toBe(false);
  });

  test("re-enabling issues a brand-new secret and codes", async () => {
    const first = await enable();
    await disableTwoFactor("u1", "correct-password");
    const second = await enable();

    expect(second.secret).not.toBe(first.secret);
    expect(second.recoveryCodes).not.toContain(first.recoveryCodes[0]);
    expect(await consumeRecoveryCode("u1", first.recoveryCodes[0])).toBe(false);
  });
});
