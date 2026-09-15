import { prisma } from "@/lib/db/prisma";
import { isTheme, type Theme } from "./theme";

export const MAX_NAME_LENGTH = 100;

export interface ProfileUpdate {
  firstName?: string | null;
  lastName?: string | null;
  theme?: Theme;
}

export type ProfileError = "invalid_name" | "name_too_long" | "invalid_theme" | "empty";

export const PROFILE_ERROR_MESSAGES: Record<ProfileError, string> = {
  invalid_name: "Names must be text.",
  name_too_long: `Names can be at most ${MAX_NAME_LENGTH} characters.`,
  invalid_theme: "Theme must be Light or Dark.",
  empty: "Nothing to update.",
};

/**
 * Partial update — only keys present in `input` are touched. Names are
 * trimmed, and blank becomes `null`. Theme must be exactly "light" or "dark".
 */
export function validateProfileUpdate(
  input: Record<string, unknown>,
): { ok: true; data: ProfileUpdate } | { ok: false; error: ProfileError } {
  const data: ProfileUpdate = {};

  for (const key of ["firstName", "lastName"] as const) {
    if (!(key in input)) continue;
    const value = input[key];
    if (value === null) {
      data[key] = null;
      continue;
    }
    if (typeof value !== "string") return { ok: false, error: "invalid_name" };
    const trimmed = value.trim();
    if (trimmed.length > MAX_NAME_LENGTH) return { ok: false, error: "name_too_long" };
    data[key] = trimmed || null;
  }

  if ("theme" in input) {
    if (!isTheme(input.theme)) return { ok: false, error: "invalid_theme" };
    data.theme = input.theme;
  }

  if (Object.keys(data).length === 0) return { ok: false, error: "empty" };
  return { ok: true, data };
}

export async function updateProfile(
  userId: string,
  input: Record<string, unknown>,
): Promise<
  | { ok: true; profile: { firstName: string | null; lastName: string | null; theme: string } }
  | { ok: false; error: ProfileError }
> {
  const result = validateProfileUpdate(input);
  if (!result.ok) return result;

  const profile = await prisma.user.update({
    where: { id: userId },
    data: result.data,
    select: { firstName: true, lastName: true, theme: true },
  });
  return { ok: true, profile };
}
