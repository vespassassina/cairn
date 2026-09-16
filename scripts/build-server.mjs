#!/usr/bin/env node
/**
 * Bundle the Node server into dist/server/ (ADR-018, ADR-022).
 *
 * The workspace packages point at their TypeScript source, which plain Node
 * cannot run, so everything is bundled into server.mjs. Two dependencies
 * cannot be bundled, because they load native code from their own folders:
 * sqlite-vec (the vector extension) and transformers.js (ONNX Runtime). They
 * stay external, and dist/server/package.json pins the exact versions this
 * workspace installed, for `npm install` in the container build.
 *
 * fetch-model.mjs downloads the embedding model with the server's own
 * settings, so the image can ship it.
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(repo, "dist", "server");

const EXTERNAL = ["sqlite-vec", "@huggingface/transformers"];

/** The version of a package as installed for the package that depends on it. */
function installedVersion(name, from) {
  const require = createRequire(join(repo, "packages", from, "package.json"));
  let dir = dirname(require.resolve(name));
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.name === name) return pkg.version;
    } catch {
      // Not a package root yet.
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot find the installed version of ${name}`);
    dir = parent;
  }
}

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  legalComments: "linked",
  external: EXTERNAL,
  // Some bundled dependencies still call require(); give them one.
  banner: { js: "import { createRequire as __cairnRequire } from 'node:module'; const require = __cairnRequire(import.meta.url);" },
  logLevel: "warning",
};

await build({
  ...common,
  entryPoints: [join(repo, "packages", "api", "src", "entry", "node.ts")],
  outfile: join(out, "server.mjs"),
});
await build({
  ...common,
  entryPoints: [join(repo, "packages", "adapter-embeddings-local", "src", "fetch-model.ts")],
  outfile: join(out, "fetch-model.mjs"),
});
// The start script runs this before the server, to bring a database back when
// the replica will not give it one it can vouch for (ADR-051).
await build({
  ...common,
  entryPoints: [join(repo, "packages", "api", "src", "entry", "recover.ts")],
  outfile: join(out, "recover.mjs"),
});

writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "cairn-server",
      private: true,
      type: "module",
      license: "PolyForm-Noncommercial-1.0.0",
      dependencies: {
        "sqlite-vec": installedVersion("sqlite-vec", "adapter-sqlite"),
        "@huggingface/transformers": installedVersion("@huggingface/transformers", "adapter-embeddings-local"),
      },
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(
  "bundled dist/server/server.mjs, recover.mjs and fetch-model.mjs, with package.json for the native dependencies\n",
);
