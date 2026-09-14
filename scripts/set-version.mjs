#!/usr/bin/env node
/**
 * Sets Cairn's version everywhere it is written: `pnpm set-version 0.1.5`.
 *
 * The root package.json holds the version of a release, the server image and
 * the CLI together. The CLI's package.json, the `VERSION` the CLI prints and
 * sends in its user agent, and the version the server reports on `/health`
 * and to MCP clients all follow it. A test fails when any of them differs, and
 * the release job refuses a tag that does not match.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  process.stderr.write("usage: pnpm set-version <major.minor.patch>, such as 0.1.5\n");
  process.exit(2);
}

function rewrite(relative, pattern, replacement) {
  const path = join(repo, relative);
  const text = readFileSync(path, "utf8");
  if (!pattern.test(text)) throw new Error(`cannot find the version in ${relative}`);
  writeFileSync(path, text.replace(pattern, replacement));
  process.stdout.write(`  ${relative}\n`);
}

process.stdout.write(`setting ${version} in:\n`);
rewrite("package.json", /"version": "[^"]*"/, `"version": "${version}"`);
rewrite("packages/cli/package.json", /"version": "[^"]*"/, `"version": "${version}"`);
rewrite("packages/cli/src/main.ts", /export const VERSION = "[^"]*";/, `export const VERSION = "${version}";`);
rewrite("packages/api/src/app.ts", /const SERVER_INFO = \{ name: "cairn", version: "[^"]*" \};/, `const SERVER_INFO = { name: "cairn", version: "${version}" };`);
process.stdout.write(`then add a changelog entry, commit, and tag v${version}\n`);
