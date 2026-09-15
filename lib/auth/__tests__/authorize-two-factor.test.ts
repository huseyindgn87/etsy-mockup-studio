import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/lib/db/prisma", async () => ({
  prisma: (await import("@/lib/account/__tests__/two-factor-fake-db")).fakePrisma,
}));

import { beginTwoFactorSetup, enableTwoFactor } from "@/lib/account/two-factor";
import { db, resetDb, seedUser } from "@/lib/account/__tests__/two-factor-fake-db";
import { authorizeCredentials } from "../authorize";
import { hashPassword } from "../password";
import { totpAt } from "../totp";
import { InvalidTwoFactorCodeError, TwoFactorRequiredError } from "../two-factor-errors";

const EMAIL = "seller@example.com";
const PASSWORD = "correct-password";
let passwordHash: string;
let secret: string;
let recoveryCodes: string[];

beforeEach(async () => {
  vi.stubEnv("TWO_FACTOR_ENCRYPTION_KEY", "test-two-factor-key-0123456789abcdef");
  passwordHash ??= await hashPassword(PASSWORD);
  resetDb();
  seedUser({ id: "u1", email: EMAIL, passwordHash });

  const setup = await beginTwoFactorSetup("u1");
  if (!setup.ok) throw new Error(setup.error);
  const enabled = await enableTwoFactor("u1", totpAt(setup.secret));
  if (!enabled.ok) throw new Error(enabled.error);
  secret = setup.secret;
  recoveryCodes = enabled.recoveryCodes;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("authorizeCredentials with two-factor auth on", () => {
  test("the right password alone is not enough — it asks for the second step", async () => {
    const attempt = authorizeCredentials(EMAIL, PASSWORD);
    await expect(attempt).rejects.toBeInstanceOf(TwoFactorRequiredError);
    await expect(authorizeCredentials(EMAIL, PASSWORD)).rejects.toMatchObject({ code: "two_factor_required" });
  });

  test("a wrong password fails plainly, without revealing that 2FA is on", async () => {
    expect(await authorizeCredentials(EMAIL, "wrong-password", false, { code: totpAt(secret) })).toBeNull();
  });

  test("password + current authenticator code signs in", async () => {
    const user = await authorizeCredentials(EMAIL, PASSWORD, true, { code: totpAt(secret) });
    expect(user).toEqual({ id: "u1", email: EMAIL, name: null, rememberMe: true });
  });

  test("a wrong code is rejected with invalid_two_factor_code", async () => {
    const wrong = totpAt(secret) === "000000" ? "111111" : "000000";
    await expect(authorizeCredentials(EMAIL, PASSWORD, false, { code: wrong })).rejects.toMatchObject({
      code: "invalid_two_factor_code",
    });
  });

  test("the same code can't be used for a second sign-in", async () => {
    const code = totpAt(secret);
    expect(await authorizeCredentials(EMAIL, PASSWORD, false, { code })).not.toBeNull();
    await expect(authorizeCredentials(EMAIL, PASSWORD, false, { code })).rejects.toBeInstanceOf(
      InvalidTwoFactorCodeError,
    );
  });

  test("a recovery code signs in once, and is rejected the second time", async () => {
    const recoveryCode = recoveryCodes[3];
    expect(await authorizeCredentials(EMAIL, PASSWORD, false, { recoveryCode })).toMatchObject({ id: "u1" });
    await expect(authorizeCredentials(EMAIL, PASSWORD, false, { recoveryCode })).rejects.toBeInstanceOf(
      InvalidTwoFactorCodeError,
    );
    expect(db.codes.filter((c) => c.usedAt !== null)).toHaveLength(1);
  });

  test("a wrong password never spends a recovery code", async () => {
    expect(await authorizeCredentials(EMAIL, "wrong-password", false, { recoveryCode: recoveryCodes[0] })).toBeNull();
    expect(db.codes.every((c) => c.usedAt === null)).toBe(true);
  });

  test("accounts without 2FA sign in with just the password", async () => {
    seedUser({ id: "u2", email: "no2fa@example.com", passwordHash });
    expect(await authorizeCredentials("no2fa@example.com", PASSWORD)).toMatchObject({ id: "u2" });
  });
});
