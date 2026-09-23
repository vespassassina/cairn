import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The gap this file closes (ADR-059 through ADR-063, docs/LESSONS.md): the
// Azure incident that actually lost data was not a graceful stop. It was a
// truncated transaction reaching the replica after the process went away
// mid-write. `shutdown-signal.test.ts` proves the graceful path (SIGTERM)
// closes SQLite cleanly. `recovery-ladder.test.ts` proves the ladder's
// decision logic against a fully faked world. Neither one puts a real
// process, really killed with SIGKILL mid-write, against a real on-disk
// SQLite file and then checks that the file itself is sound and that
// restarting on it recovers exactly what was durably committed. That
// combination is what this file tests.
//
// SIGKILL cannot be caught, so there is no Cairn code under test here: this
// is a test of a *property*, that SQLite's own WAL/journal machinery leaves a
// file it can still open and vouch for even when nothing shuts it down
// cleanly, and that Cairn's own read path after a restart only ever shows
// what was actually committed. If either of those is false, the ladder's rung
// 1 ("the local database, if there is one and it is sound") is unsound
// wherever a container is killed rather than stopped, which is exactly how a
// scheduler reclaims a container under memory pressure or a deploy replaces
// one.
//
// There is no standalone exported `sound()`: it lives inlined inside the
// `Ladder` object `packages/api/src/entry/recover.ts` builds in `main()` (a
// `DatabaseSync` opened read-only, `pragma integrity_check`). It is not
// reachable outside that process wiring, so this file reimplements the same
// two lines directly against the file, matching recover.ts's own check
// exactly, rather than reaching for litestream/recover.mjs, which
// `container-start.test.ts` stubs out because this repo does not assume a
// real litestream binary is on the CI runner.

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const entry = join(repoRoot, "packages", "api", "src", "entry", "node.ts");

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-crash-"));
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

interface RunningServer {
  process: ReturnType<typeof spawn>;
  database: string;
  port: number;
  output: () => string;
  exited: Promise<number | null>;
}

/** Spawn the real server entry against a real file-backed database. */
async function startServer(database: string): Promise<RunningServer> {
  const port = await freePort();
  const proc = spawn(process.execPath, ["--import", "tsx", entry], {
    env: {
      ...process.env,
      CAIRN_DB: database,
      CAIRN_PORT: String(port),
      CAIRN_HOST: "127.0.0.1",
      // The embedding model takes far longer to load than these tests need,
      // and loading it bears nothing on crash recovery (ADR-022).
      CAIRN_EMBEDDINGS: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  proc.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  proc.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));

  const exited = new Promise<number | null>((resolve) => {
    proc.on("exit", (code) => resolve(code));
  });

  const deadline = Date.now() + 30_000;
  while (!output.includes("cairn listening") && Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!output.includes("cairn listening")) {
    throw new Error(`the server never said it was listening:\n${output}`);
  }

  return { process: proc, database, port, output: () => output, exited };
}

// Plain node:http rather than fetch/undici: undici's connection pool, when a
// request races the server socket being torn down (exactly what a SIGKILL
// mid-write does to every in-flight request), can throw an internal
// `setTypeOfService EINVAL` as an unhandled error on the socket rather than a
// rejection the caller's `.catch` sees, which crashes the whole test worker.
// node:http's plain request surfaces the same failure as an ordinary "error"
// event, which is exactly what these tests need to treat as "no answer".
function request(
  server: RunningServer,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        path,
        method: init.method ?? "GET",
        headers: body === undefined ? {} : { "content-type": "application/json" },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => (text += chunk.toString()));
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          } catch {
            // Not JSON; leave json empty, callers that need it check status first.
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * The same check `recover.ts`'s `Ladder.sound()` makes: open read-only,
 * `pragma integrity_check`, and treat any thrown error (missing file,
 * mid-open corruption) as unsound rather than letting it escape.
 */
function sound(path: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("pragma integrity_check").get() as { integrity_check?: string };
    return row.integrity_check === "ok";
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed, or never opened.
    }
  }
}

/**
 * Fire page creations at a running server continuously, without waiting for
 * any response to drain, and record which ones actually got a 2xx back
 * before the caller stops feeding more in. This is deliberately the opposite
 * of `shutdown-signal.test.ts`'s pattern: that test waits for a tidy stop,
 * this one exists to catch the server with writes in flight.
 *
 * `count` needs to be large relative to how soon the caller kills the
 * process: a local SQLite write is fast enough that a handful of requests
 * simply finish before a short delay elapses, and the test would then never
 * catch a write mid-flight at all. Measured locally, a few hundred
 * concurrent requests against a ~20ms kill delay reliably leaves most of
 * them still in flight when SIGKILL lands.
 */
function hammer(server: RunningServer, count: number): { confirmed: Set<number>; done: Promise<void> } {
  const confirmed = new Set<number>();
  const attempts: Promise<void>[] = [];
  for (let i = 0; i < count; i += 1) {
    const p = request(server, "/api/v1/pages", {
      method: "POST",
      body: {
        title: `crash page ${i}`,
        body: `# crash page ${i}\n\nWritten during the hammer loop.`,
        change_note: `write ${i}`,
      },
    })
      .then((res) => {
        if (res.status === 201) confirmed.add(i);
      })
      .catch(() => {
        // The server may already be dead by the time this settles; that is
        // exactly the case this test wants to exercise, not an error to
        // propagate.
      });
    attempts.push(p);
  }
  return { confirmed, done: Promise.allSettled(attempts).then(() => undefined) };
}

/**
 * Every page title the server currently has, following the cursor rather
 * than trusting a single page of results: the hammer can confirm well over
 * the REST API's default (50) or even its max (200) `limit` in one run, and
 * a truncated single-page read would misreport a present write as lost.
 */
async function listAllTitles(server: RunningServer): Promise<Set<string>> {
  const titles = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const path = cursor === null ? "/api/v1/pages?limit=200" : `/api/v1/pages?limit=200&cursor=${encodeURIComponent(cursor)}`;
    const list = await request(server, path);
    expect(list.status).toBe(200);
    for (const p of (list.json["pages"] as Array<{ title: string }> | undefined) ?? []) {
      titles.add(p.title);
    }
    cursor = (list.json["cursor"] as string | null | undefined) ?? null;
    if (cursor === null) break;
  }
  return titles;
}

// SIGKILL is POSIX; Windows has no equivalent signal to send (Node emulates
// it with TerminateProcess, which is a different mechanism entirely), and the
// container this behaviour protects is Linux (ADR-020). Tested where it's
// real, same reasoning as shutdown-signal.test.ts.
describe.skipIf(process.platform === "win32")("surviving a real SIGKILL mid-write", () => {
  it(
    "leaves a database file SQLite itself can still open and vouch for",
    async () => {
      const database = join(dir, "cairn.sqlite");
      const server = await startServer(database);

      const { done } = hammer(server, 400);
      // Long enough for the first handful of writes to actually be in
      // flight, short enough that most of the 400 are still unanswered when
      // the kill lands. Not a wait for completion, the opposite.
      await new Promise((r) => setTimeout(r, 20));
      server.process.kill("SIGKILL");
      await server.exited;
      // Let in-flight fetches settle (most will reject/hang up) so they don't
      // leak into the next test.
      await done;

      expect(sound(database), "the database did not pass its integrity check after a SIGKILL").toBe(
        true,
      );
    },
    30_000,
  );

  it(
    "restarts successfully afterward and shows exactly the writes that were confirmed before the kill",
    async () => {
      const database = join(dir, "cairn.sqlite");
      const server = await startServer(database);

      const { confirmed, done } = hammer(server, 400);
      await new Promise((r) => setTimeout(r, 35));
      server.process.kill("SIGKILL");
      await server.exited;
      await done;

      expect(sound(database)).toBe(true);
      // The hammer only proves something if some writes actually landed
      // before the kill; if this is ever 0 the timing needs widening, not
      // the assertions below loosening.
      expect(confirmed.size, "no write was confirmed before the kill; the delay is too short").toBeGreaterThan(0);

      const restarted = await startServer(database);
      try {
        const health = await request(restarted, "/health");
        expect(health.status).toBe(200);

        const titles = await listAllTitles(restarted);

        // Every write that got a 2xx before the kill must be present after
        // restart. Writes that never got a response are unconstrained: they
        // may or may not have landed, and asserting either way would be
        // asserting an implementation detail of exact kill timing.
        for (const i of confirmed) {
          expect(titles.has(`crash page ${i}`), `write ${i} was confirmed but missing after restart`).toBe(
            true,
          );
        }
      } finally {
        restarted.process.kill("SIGTERM");
        await restarted.exited;
      }
    },
    30_000,
  );

  // Repeats the kill at different points in the write sequence (early,
  // middle, late relative to a fixed loop) to catch a race that only shows
  // up at one particular timing, the way the ADR-062 Litestream mitigation
  // only broke on the very first restore. Kept small and fast: coverage of
  // timing, not an exhaustive sweep.
  const timings = [10, 25, 60];
  for (const [index, delayMs] of timings.entries()) {
    it(
      `survives a SIGKILL timed at point ${index + 1} of ${timings.length} (${delayMs}ms into the writes)`,
      async () => {
        const database = join(dir, `cairn-${index}.sqlite`);
        const server = await startServer(database);

        const { confirmed, done } = hammer(server, 400);
        await new Promise((r) => setTimeout(r, delayMs));
        server.process.kill("SIGKILL");
        await server.exited;
        await done;

        expect(
          sound(database),
          `unsound after a kill at ${delayMs}ms (timing ${index + 1})`,
        ).toBe(true);

        const restarted = await startServer(database);
        try {
          const health = await request(restarted, "/health");
          expect(health.status).toBe(200);

          const titles = await listAllTitles(restarted);
          for (const i of confirmed) {
            expect(
              titles.has(`crash page ${i}`),
              `write ${i} was confirmed but missing after restart (timing ${index + 1})`,
            ).toBe(true);
          }
        } finally {
          restarted.process.kill("SIGTERM");
          await restarted.exited;
        }
      },
      30_000,
    );
  }
});
