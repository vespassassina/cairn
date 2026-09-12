#!/usr/bin/env node
/**
 * Bundle the Node server into one file, dist/server/server.mjs (ADR-018).
 *
 * The workspace packages point at their TypeScript source, which plain Node
 * cannot run. The container needs neither the sources nor node_modules: one
 * bundled file and Node's built-in SQLite are the whole server.
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(repo, "packages", "api", "src", "entry", "node.ts")],
  outfile: join(repo, "dist", "server", "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  legalComments: "linked",
  // Some bundled dependencies still call require(); give them one.
  banner: { js: "import { createRequire as __cairnRequire } from 'node:module'; const require = __cairnRequire(import.meta.url);" },
  logLevel: "warning",
});
process.stdout.write("bundled dist/server/server.mjs\n");
