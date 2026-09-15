import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db/prisma";
import { authorizeCredentials } from "@/lib/auth/authorize";
import { REMEMBER_ME_MAX_AGE_SECONDS } from "@/lib/auth/session-cookie";

/**
 * App-account auth (separate from the Etsy OAuth connection — see
 * lib/etsy/session.ts). Credentials-only today, so sessions are JWT-backed
 * (the Prisma adapter's `Session` table isn't read on the hot path; it's
 * there for the adapter's schema contract and any future provider that
 * needs it).
 *
 * `session.maxAge` here is the ceiling Auth.js itself writes into every
 * session cookie — matches "Keep me signed in" checked. When it's
 * unchecked, `lib/auth/session-cookie.ts`'s `applyRememberMeCookiePolicy`
 * (wired up in app/api/auth/[...nextauth]/route.ts) strips the cookie's
 * expiry back out afterward, based on `rememberMe` carried in the token
 * below — Auth.js has no config knob to vary the cookie's `Max-Age` per
 * sign-in directly.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt", maxAge: REMEMBER_ME_MAX_AGE_SECONDS },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        rememberMe: { label: "Keep me signed in", type: "checkbox" },
        // Second step for accounts with two-factor auth on — see lib/auth/authorize.ts.
        code: { label: "Authentication code", type: "text" },
        recoveryCode: { label: "Recovery code", type: "text" },
      },
      authorize: (credentials) =>
        authorizeCredentials(credentials?.email, credentials?.password, credentials?.rememberMe, {
          code: credentials?.code,
          recoveryCode: credentials?.recoveryCode,
        }),
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.id = user.id as string;
        token.rememberMe = (user as { rememberMe?: boolean }).rememberMe ?? false;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) session.user.id = token.id as string;
      return session;
    },
  },
});
