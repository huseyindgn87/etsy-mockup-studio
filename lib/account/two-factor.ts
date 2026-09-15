import QRCode from "qrcode";
import { prisma } from "@/lib/db/prisma";
import { APP_NAME } from "@/lib/brand";
import { verifyPassword } from "@/lib/auth/password";
import { generateRecoveryCodes, hashRecoveryCode } from "@/lib/auth/recovery-codes";
import { generateTotpSecret, otpauthUri, verifyTotp } from "@/lib/auth/totp";
import { decryptTwoFactorSecret, encryptTwoFactorSecret } from "@/lib/auth/two-factor-key";

/**
 * Enabling and disabling TOTP two-factor auth from /settings. The sign-in
 * check lives in lib/auth/second-factor.ts.
 *
 * Server-only — pulls in Prisma.
 */

/** The label authenticator apps show next to the code. */
export const TWO_FACTOR_ISSUER = APP_NAME;

export type TwoFactorError =
  | "not_found"
  | "already_enabled"
  | "not_enabled"
  | "no_pending_setup"
  | "invalid_code"
  | "password_required"
  | "wrong_password";

export const TWO_FACTOR_ERROR_MESSAGES: Record<TwoFactorError, string> = {
  not_found: "Account not found.",
  already_enabled: "Two-factor authentication is already on.",
  not_enabled: "Two-factor authentication is already off.",
  no_pending_setup: "No setup in progress — start again.",
  invalid_code: "That code didn't match. Enter the current 6-digit code from your authenticator app.",
  password_required: "Enter your password to disable two-factor authentication.",
  wrong_password: "Password is incorrect.",
};

export const TWO_FACTOR_ERROR_STATUS: Record<TwoFactorError, number> = {
  not_found: 404,
  already_enabled: 409,
  not_enabled: 409,
  no_pending_setup: 409,
  invalid_code: 400,
  password_required: 400,
  wrong_password: 403,
};

type Failure = { ok: false; error: TwoFactorError };

/**
 * Step 1: generate a secret and store it (encrypted) as *pending* — 2FA is
 * not on yet. Returns the secret for manual entry plus the QR code (a PNG
 * data URL, rendered server-side) to scan. Restarting setup replaces any
 * earlier pending secret.
 */
export async function beginTwoFactorSetup(
  userId: string,
): Promise<{ ok: true; secret: string; otpauthUrl: string; qrDataUrl: string } | Failure> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, twoFactorEnabled: true },
  });
  if (!user) return { ok: false, error: "not_found" };
  if (user.twoFactorEnabled) return { ok: false, error: "already_enabled" };

  const secret = generateTotpSecret();
  // Encrypt first: a missing key throws here, before anything is written.
  const sealed = encryptTwoFactorSecret(secret);
  await prisma.user.update({ where: { id: userId }, data: { twoFactorPendingSecret: sealed } });

  const otpauthUrl = otpauthUri({ secret, accountName: user.email, issuer: TWO_FACTOR_ISSUER });
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: "M", margin: 1, width: 224 });
  return { ok: true, secret, otpauthUrl, qrDataUrl };
}

/**
 * Step 2: a valid code for the pending secret turns 2FA on and issues a fresh
 * set of recovery codes — returned in plain text exactly once, stored only as
 * hashes.
 */
export async function enableTwoFactor(
  userId: string,
  rawCode: unknown,
  nowMs: number = Date.now(),
): Promise<{ ok: true; recoveryCodes: string[] } | Failure> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { twoFactorEnabled: true, twoFactorPendingSecret: true },
  });
  if (!user) return { ok: false, error: "not_found" };
  if (user.twoFactorEnabled) return { ok: false, error: "already_enabled" };
  if (!user.twoFactorPendingSecret) return { ok: false, error: "no_pending_setup" };

  const code = typeof rawCode === "string" ? rawCode : "";
  const step = verifyTotp(decryptTwoFactorSecret(user.twoFactorPendingSecret), code, nowMs);
  if (step === null) return { ok: false, error: "invalid_code" };

  const recoveryCodes = generateRecoveryCodes();
  await prisma.$transaction([
    prisma.twoFactorRecoveryCode.deleteMany({ where: { userId } }),
    prisma.twoFactorRecoveryCode.createMany({
      data: recoveryCodes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })),
    }),
    prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: true,
        twoFactorSecret: user.twoFactorPendingSecret,
        twoFactorPendingSecret: null,
        twoFactorLastUsedStep: null,
      },
    }),
  ]);
  return { ok: true, recoveryCodes };
}

/** Turns 2FA off after re-checking the account password; wipes the secret and every recovery code. */
export async function disableTwoFactor(userId: string, rawPassword: unknown): Promise<{ ok: true } | Failure> {
  const password = typeof rawPassword === "string" ? rawPassword : "";
  if (!password) return { ok: false, error: "password_required" };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, twoFactorEnabled: true },
  });
  if (!user) return { ok: false, error: "not_found" };
  if (!(await verifyPassword(password, user.passwordHash))) return { ok: false, error: "wrong_password" };
  if (!user.twoFactorEnabled) return { ok: false, error: "not_enabled" };

  await prisma.$transaction([
    prisma.twoFactorRecoveryCode.deleteMany({ where: { userId } }),
    prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorPendingSecret: null,
        twoFactorLastUsedStep: null,
      },
    }),
  ]);
  return { ok: true };
}
