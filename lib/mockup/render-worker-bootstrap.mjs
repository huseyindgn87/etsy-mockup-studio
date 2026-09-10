/**
 * Boots `render.worker.ts` as a native-Node TypeScript worker.
 *
 * Node runs `.ts` directly (type stripping), but its ESM resolver needs explicit
 * extensions — and `lib/mockup/*.ts` imports each other extensionless
 * (`import "./types"`). This resolve hook appends `.ts` to those specifiers so
 * the worker can pull in the shared compositor unchanged. Passed to the worker
 * via `execArgv: ["--import", <this file>]`; it never touches the main app.
 */

import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { existsSync } from "node:fs";
      import { fileURLToPath } from "node:url";
      export async function resolve(specifier, context, next) {
        if (
          specifier[0] === "." &&
          !/\\.[a-z0-9]+$/i.test(specifier) &&
          context.parentURL
        ) {
          try {
            const candidate = new URL(specifier + ".ts", context.parentURL);
            if (existsSync(fileURLToPath(candidate))) {
              return next(specifier + ".ts", context);
            }
          } catch {}
        }
        return next(specifier, context);
      }
    `),
);
