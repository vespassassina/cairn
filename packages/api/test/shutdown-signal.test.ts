import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The property this whole change exists for (ADR-046, docs/LESSONS.md): a
// Cairn that is asked to stop closes SQLite, which checkpoints the write-ahead
// log and removes it. What Litestream then has to replicate is a finished
// file. Before this, Cairn had no signal handler at all and was killed
// mid-write, which is how a truncated transaction reached the Azure replica.
//
// This runs the real server as a real process and sends it a real SIGTERM,
// because the interesting behaviour is precisely the part a unit test stubs.

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const tsx = join(repoRoot, "node_modules", ".bin", "tsx");
const entry = join(repoRoot, "packages", "api", "src", "entry", "node.ts");

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-shutdown-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A port nothing is listening on, taken and released so the server can have it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

describe("stopping the server on SIGTERM", () => {
  it("closes the database, so no write-ahead log is left behind", async () => {
    const database = join(dir, "cairn.sqlite");
    const port = await freePort();
    const server = spawn(tsx, [entry], {
      env: {
        ...process.env,
        CAIRN_DB: database,
        CAIRN_PORT: String(port),
        CAIRN_HOST: "127.0.0.1",
        // The embedding model takes far longer to load than this test needs,
        // and none of it bears on shutting down (ADR-022).
        CAIRN_EMBEDDINGS: "off",
        CAIRN_SHUTDOWN_SECONDS: "10",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    server.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    server.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

    const exited = new Promise<number | null>((resolve) => {
      server.on("exit", (code) => resolve(code));
    });

    const deadline = Date.now() + 30_000;
    while (!output.includes("cairn listening") && Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`server exited early:\n${output}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(output, "the server never said it was listening").toContain("cairn listening");

    // Creating the schema is itself a write, so WAL mode has a log open.
    expect(existsSync(`${database}-wal`), "expected an open write-ahead log while running").toBe(
      true,
    );

    server.kill("SIGTERM");
    const code = await exited;

    expect(code, `server did not stop cleanly:\n${output}`).toBe(0);
    expect(output).toContain("stopping on SIGTERM");
    expect(output).toContain("closed the database");
    // The whole point. SQLite removes the log when the last connection closes,
    // so its absence is the evidence that the close really happened.
    expect(
      existsSync(`${database}-wal`),
      "the write-ahead log survived, so the database was not closed cleanly",
    ).toBe(false);
  }, 60_000);
});
