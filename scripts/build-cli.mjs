#!/usr/bin/env node
/**
 * Build the `cairn` CLI as standalone executables (ADR-014).
 *
 *   pnpm build:cli            every target
 *   pnpm build:cli host       only this machine's platform
 *   pnpm build:cli linux-x64 windows-x64
 *
 * Output goes to dist/cli/, with a SHA256SUMS file. Each executable carries
 * its own runtime, so it runs without Node installed.
 *
 * Bun does the compiling, because it cross-compiles for every platform from
 * any one of them. It is a build tool only: nothing in Cairn runs on Bun. The
 * version is pinned, and fetched with npx when Bun is not installed.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BUN_VERSION = "1.4.2";

/** Our name for each target, and Bun's. */
const TARGETS = {
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64",
  "darwin-arm64": "bun-darwin-arm64",
  "windows-x64": "bun-windows-x64",
};

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repo, "packages", "cli", "src", "bin.ts");
const out = join(repo, "dist", "cli");
const windows = process.platform === "win32";

function hostTarget() {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  const name = `${os}-${process.arch}`;
  if (!(name in TARGETS)) {
    throw new Error(`no CLI target for this machine (${process.platform} ${process.arch})`);
  }
  return name;
}

/**
 * Bun on the PATH at the pinned version, or the pinned version through npx.
 *
 * Bun is a real executable and runs without a shell. npx is a .cmd script on
 * Windows, which Node only runs through a shell, so that path quotes every
 * argument: a folder such as C:\Users\Jo Smith would otherwise split in two.
 */
function bunCommand() {
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim() === BUN_VERSION) {
    return { command: "bun", prefix: [], shell: false };
  }
  return { command: "npx", prefix: ["--yes", `bun@${BUN_VERSION}`], shell: windows };
}

function quoted(args, shell) {
  return shell ? args.map((arg) => `"${arg.replace(/"/g, '\\"')}"`) : args;
}

function main() {
  const requested = process.argv.slice(2);
  const names =
    requested.length === 0
      ? Object.keys(TARGETS)
      : requested.map((name) => (name === "host" ? hostTarget() : name));
  for (const name of names) {
    if (!(name in TARGETS)) {
      throw new Error(`unknown target "${name}". Known: host, ${Object.keys(TARGETS).join(", ")}`);
    }
  }

  const version = JSON.parse(readFileSync(join(repo, "packages", "cli", "package.json"), "utf8")).version;
  const bun = bunCommand();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const sums = [];
  for (const name of names) {
    const file = `cairn-${name}${name.startsWith("windows") ? ".exe" : ""}`;
    const path = join(out, file);
    process.stdout.write(`building ${file}\n`);
    const args = [...bun.prefix, "build", "--compile", "--minify", `--target=${TARGETS[name]}`, entry, "--outfile", path];
    const result = spawnSync(bun.command, quoted(args, bun.shell), {
      // Bun prints a progress line per download; show its output only on failure.
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      shell: bun.shell,
    });
    if (result.status !== 0) throw new Error(`bun failed for ${name}\n${result.stdout}${result.stderr}`);
    sums.push(`${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${file}`);
  }

  writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
  process.stdout.write(`cairn ${version}: ${names.length} executable(s) in ${out}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
