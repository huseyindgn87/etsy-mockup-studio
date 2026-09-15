import { cache } from "react";
import { auth } from "@/auth";
import { prisma } from "@/lib/db/prisma";
import { coerceTheme, type Theme } from "./theme";

export interface CurrentUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  theme: Theme;
}

/**
 * The signed-in account, read fresh from the DB — not from the session JWT,
 * whose `email` is frozen at sign-in and goes stale after a change on
 * /settings. `cache`d per request, so the root layout (theme), the app
 * layout (account menu) and /settings share one query.
 *
 * Server-only — pulls in Prisma.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, firstName: true, lastName: true, theme: true },
  });
  if (!user) return null;
  return { ...user, theme: coerceTheme(user.theme) };
});
