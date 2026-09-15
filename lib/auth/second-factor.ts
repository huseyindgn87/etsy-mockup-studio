import { prisma } from "@/lib/db/prisma";
import { hashRecoveryCode, isWellFormedRecoveryCode } from "./recovery-codes";
import { verifyTotp } from "./totp";
import { decryptTwoFactorSecret } from "./two-factor-key";

/**
 * The sign-in half of two-factor auth: verifying a TOTP code or spending a
 * recovery code. Kept apart from lib/account/two-factor.ts (setup/enable/
 * disable) so auth.ts doesn't pull in the QR-code library.
 *
 * Server-only — pulls in Prisma.
 */

export interface SecondFactorUser {
  id: string;
  twoFactorSecret: string | null;
  twoFactorLastUsedStep: number | null;
}

/**
 * Accepts a valid code only if its time step is newer than the last one
 * accepted, and records it with a conditional update — so the same code
 * (or an older one) can't be replayed, even by two concurrent sign-ins.
 */
export async function verifyTotpForSignIn(
  user: SecondFactorUser,
  code: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!user.twoFactorSecret) return false;
  const step = verifyTotp(decryptTwoFactorSecret(user.twoFactorSecret), code, nowMs);
  if (step === null) return false;
  if (user.twoFactorLastUsedStep !== null && step <= user.twoFactorLastUsedStep) return false;

  const { count } = await prisma.user.updateMany({
    where: {
      id: user.id,
      OR: [{ twoFactorLastUsedStep: null }, { twoFactorLastUsedStep: { lt: step } }],
    },
    data: { twoFactorLastUsedStep: step },
  });
  return count === 1;
}

/**
 * Spends a recovery code: one conditional update marks it used only if it
 * exists for this user and hasn't been used — a second attempt with the same
 * code (sequential or concurrent) matches nothing and fails.
 */
export async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  if (!isWellFormedRecoveryCode(code)) return false;
  const { count } = await prisma.twoFactorRecoveryCode.updateMany({
    where: { userId, codeHash: hashRecoveryCode(code), usedAt: null },
    data: { usedAt: new Date() },
  });
  return count === 1;
}

export async function verifySecondFactor(
  user: SecondFactorUser,
  input: { code?: string; recoveryCode?: string },
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (input.recoveryCode) return consumeRecoveryCode(user.id, input.recoveryCode);
  if (input.code) return verifyTotpForSignIn(user, input.code, nowMs);
  return false;
}

export async function countRemainingRecoveryCodes(userId: string): Promise<number> {
  return prisma.twoFactorRecoveryCode.count({ where: { userId, usedAt: null } });
}
