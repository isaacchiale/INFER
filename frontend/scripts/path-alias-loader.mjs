/**
 * Node module-resolution hook: resolves the `@/*` -> `src/*` alias that
 * tsconfig.json / vite-tsconfig-paths already provide at build time, plus
 * bundler-style extensionless imports (`@/lib/foo` -> `src/lib/foo.ts`).
 * Registered via ../scripts/register-path-alias.mjs so `node --test` can run
 * source files directly without Vite.
 */

import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC_URL = new URL("../src/", import.meta.url);
const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];

function fileExists(url) {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
}

function resolveExtensionless(url) {
  if (fileExists(url)) return url;
  for (const ext of EXTENSIONS) {
    const candidate = new URL(url.href + ext);
    if (fileExists(candidate)) return candidate;
  }
  for (const ext of EXTENSIONS) {
    const candidate = new URL(`${url.href}/index${ext}`);
    if (fileExists(candidate)) return candidate;
  }
  return url;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const target = resolveExtensionless(new URL(specifier.slice(2), SRC_URL));
    return nextResolve(target.href, context);
  }
  return nextResolve(specifier, context);
}
