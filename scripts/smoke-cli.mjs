#!/usr/bin/env node
/**
 * Smoke test for a built `cairn` executable, on whatever OS this runs on.
 *
 *   pnpm smoke:cli                     the host build in dist/cli
 *   pnpm smoke:cli path/to/cairn       a specific executable
 *
 * Starts a Cairn server on a spare port with an empty database in a temporary
 * folder, runs the executable against it the way an agent would, checks the
 * output, and stops the server. Written in Node rather than shell so the same
 * script runs on Windows, macOS and Linux in CI (ADR-014).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8797;
const URL_BASE = `http://localhost:${PORT}`;

function hostExecutable() {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform];
  return join(repo, "dist", "cli", `cairn-${os}-${process.arch}${os === "windows" ? ".exe" : ""}`);
}

const executable = process.argv[2] ?? hostExecutable();
const dataDir = mkdtempSync(join(tmpdir(), "cairn-smoke-"));

function cairn(args, input) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    env: { ...process.env, CAIRN_URL: URL_BASE, CAIRN_AGENT: "smoke-test" },
    ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input }),
  });
  if (result.error) throw result.error;
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function check(label, condition, detail) {
  if (!condition) throw new Error(`${label}\n${detail ?? ""}`);
  process.stdout.write(`ok   ${label}\n`);
}

async function waitForHealth(server) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited with ${server.exitCode}`);
    try {
      const response = await fetch(`${URL_BASE}/health`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("server did not answer /health within 30 seconds");
}

async function main() {
  process.stdout.write(`smoke testing ${executable}\n`);

  const version = cairn(["-V"]);
  check("prints its version", version.code === 0 && /^cairn \d+\.\d+\.\d+/.test(version.out), version.err);

  const offline = cairn(["overview"]);
  check("says plainly when no server is running", offline.code === 1 && offline.err.includes("cannot reach Cairn"), offline.err);

  const server = spawn(process.execPath, ["--import", "tsx", join("packages", "api", "src", "entry", "node.ts")], {
    cwd: repo,
    env: { ...process.env, CAIRN_DB: join(dataDir, "smoke.sqlite"), CAIRN_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (chunk) => (serverLog += chunk));
  server.stderr.on("data", (chunk) => (serverLog += chunk));

  try {
    await waitForHealth(server).catch((error) => {
      throw new Error(`${error.message}\n${serverLog}`);
    });

    const created = cairn(
      ["create", "--title", "Smoke test page", "--tag", "smoke", "--note", "Smoke test"],
      "## Firmware\r\n\r\nBLHeli_32 on the bench.\r\n",
    );
    const match = /^ok (\S+) version (\S+)/.exec(created.out);
    check("creates a page from piped input", created.code === 0 && match !== null, created.err);
    const [, id] = match;

    const read = cairn(["read", id]);
    check("reads it back as Markdown", read.code === 0 && read.out.includes("BLHeli_32"), read.err);
    check("stores Windows line endings as plain newlines", !read.out.includes("\r"), JSON.stringify(read.out));

    const appended = cairn(["append", id, "--text", "Props: 5.1 inch.", "--note", "Smoke append"]);
    check("appends without a version", appended.code === 0, appended.err);

    let found = false;
    for (let attempt = 0; attempt < 40 && !found; attempt += 1) {
      found = cairn(["search", "BLHeli_32"]).out.includes(id);
      if (!found) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    check("finds it by search", found);

    const changes = cairn(["changes", "--agents"]);
    check(
      "lists the change, attributed to the CLI",
      changes.code === 0 && changes.out.includes(id) && changes.out.includes("cairn-cli/") && changes.out.includes("smoke-test"),
      changes.out + changes.err,
    );

    const conflict = cairn(["write", id, "--version", "not-the-version", "--text", "stale"]);
    check("refuses a stale version", conflict.code === 1 && conflict.err.includes("version_conflict"), conflict.err);

    process.stdout.write("smoke test passed\n");
  } finally {
    await stop(server);
    removeDataDir();
  }
}

/**
 * Stop the server and wait until it has exited. kill() only sends the signal,
 * and on Windows a file the server still holds open, such as its SQLite
 * database, cannot be deleted.
 */
async function stop(server) {
  if (server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
}

/** Cleanup is not what is under test, so a failure here only warns. */
function removeDataDir() {
  try {
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) {
    process.stderr.write(`warning: could not remove ${dataDir}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
