import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    /** Set at sign-in from the "Keep me signed in" checkbox — see auth.ts and lib/auth/session-cookie.ts. */
    rememberMe: boolean;
  }
}
