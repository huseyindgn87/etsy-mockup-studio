import { auth } from "@/auth";

/**
 * Admins are listed by user id in `ADMIN_USER_IDS` (comma- or space-separated),
 * not by email: there is no email verification, so anyone could register — or
 * change their email to — an admin address that isn't taken yet. Unset or
 * empty means nobody is an admin.
 */
export function parseAdminUserIds(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(/[\s,]+/).filter(Boolean));
}

export function isAdminUserId(id: string | null | undefined, raw = process.env.ADMIN_USER_IDS): boolean {
  if (!id) return false;
  return parseAdminUserIds(raw).has(id);
}

/** Server-only. True when the signed-in app user is listed in `ADMIN_USER_IDS`. */
export async function isCurrentUserAdmin(): Promise<boolean> {
  const session = await auth();
  return isAdminUserId(session?.user?.id);
}
