import { prisma } from "@/lib/db/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { isValidPassword, MIN_PASSWORD_LENGTH } from "@/lib/auth/validate";

export type ChangePasswordError =
  | "password_required"
  | "weak_password"
  | "password_mismatch"
  | "wrong_password";

export const CHANGE_PASSWORD_ERROR_MESSAGES: Record<ChangePasswordError, string> = {
  password_required: "Enter your current password.",
  weak_password: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
  password_mismatch: "New passwords don't match.",
  wrong_password: "Current password is incorrect.",
};

export const CHANGE_PASSWORD_ERROR_STATUS: Record<ChangePasswordError, number> = {
  password_required: 400,
  weak_password: 400,
  password_mismatch: 400,
  wrong_password: 403,
};

export async function changePassword(
  userId: string,
  input: { currentPassword?: unknown; newPassword?: unknown; confirmPassword?: unknown },
): Promise<{ ok: true } | { ok: false; error: ChangePasswordError }> {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const currentPassword = str(input.currentPassword);
  const newPassword = str(input.newPassword);
  const confirmPassword = str(input.confirmPassword);

  if (!currentPassword) return { ok: false, error: "password_required" };
  if (!isValidPassword(newPassword)) return { ok: false, error: "weak_password" };
  if (newPassword !== confirmPassword) return { ok: false, error: "password_mismatch" };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
    return { ok: false, error: "wrong_password" };
  }

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword) },
  });
  return { ok: true };
}
