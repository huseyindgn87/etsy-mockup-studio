/** Deliberately simple — good enough to catch typos, not a full RFC 5322 parser. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const MIN_PASSWORD_LENGTH = 8;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

export function isValidPassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH;
}

export interface RegistrationInput {
  email?: unknown;
  password?: unknown;
  confirmPassword?: unknown;
}

export type RegistrationError =
  | "invalid_email"
  | "weak_password"
  | "password_mismatch";

/** Field-level validation only. An already-registered email is never reported — see app/api/auth/register/route.ts. */
export function validateRegistration(
  input: RegistrationInput,
): { ok: true; email: string; password: string } | { ok: false; error: RegistrationError } {
  const email = typeof input.email === "string" ? normalizeEmail(input.email) : "";
  const password = typeof input.password === "string" ? input.password : "";
  const confirmPassword = typeof input.confirmPassword === "string" ? input.confirmPassword : "";

  if (!isValidEmail(email)) return { ok: false, error: "invalid_email" };
  if (!isValidPassword(password)) return { ok: false, error: "weak_password" };
  if (password !== confirmPassword) return { ok: false, error: "password_mismatch" };
  return { ok: true, email, password };
}

export const REGISTRATION_ERROR_MESSAGES: Record<RegistrationError, string> = {
  invalid_email: "Enter a valid email address.",
  weak_password: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
  password_mismatch: "Passwords don't match.",
};
