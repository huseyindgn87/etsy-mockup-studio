import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** `@/` mirrors the tsconfig path alias so route handlers can be unit-tested. */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    server: {
      deps: {
        // next-auth's ESM build imports "next/server" without an extension,
        // which Node's resolver rejects; letting Vite transform it resolves
        // it. Needed since lib/auth/two-factor-errors.ts extends next-auth's
        // own CredentialsSignin (the class Auth.js checks with instanceof).
        inline: ["next-auth"],
      },
    },
  },
});
