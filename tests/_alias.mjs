/**
 * node --test bootstrap: make the project's source modules importable
 * without a bundler —
 * - `@/…` (the wxt/tsconfig alias) resolves into src/,
 * - extensionless imports (source style) fall back to `<path>.ts`, then
 *   `<path>/index.ts`.
 * Registered via the package.json test script (`--import ./tests/_alias.mjs`).
 */
import { register } from "node:module";

register(new URL("data:text/javascript," + encodeURIComponent(`
  const SRC = ${JSON.stringify(new URL("../src/", import.meta.url).href)};
  export async function resolve(specifier, context, nextResolve) {
    const candidates = [];
    if (specifier.startsWith("@/")) {
      const base = SRC + specifier.slice(2);
      candidates.push(base + ".ts", base + "/index.ts", base);
    } else {
      candidates.push(specifier);
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[a-z]+$/.test(specifier)) {
        candidates.push(specifier + ".ts", specifier + "/index.ts");
      }
    }
    let lastErr;
    for (const candidate of candidates) {
      try {
        return await nextResolve(candidate, context);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }
`)));
