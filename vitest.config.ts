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
  },
});
