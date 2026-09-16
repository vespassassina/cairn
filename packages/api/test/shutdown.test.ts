import { createServer, get, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { runShutdown } from "../src/entry/shutdown.js";

// Stopping tidily is what keeps a truncated transaction out of the Litestream
// replica (ADR-046, docs/LESSONS.md). The rules worth holding: the socket
// closes before the steps run, the steps run in order, and running out of time
// says which step was left undone rather than hanging until the platform
// kills us.

const open: Server[] = [];

afterEach(() => {
  for (const server of open.splice(0)) server.close();
});

/** A real listening server, so the drain behaviour under test is the real one. */
async function listening(handler: Parameters<typeof createServer>[1]): Promise<Server> {
  const server = createServer(handler);
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function port(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("not listening on a port");
  return address.port;
}

/** Fire a request and resolve once it has a response, or reject on failure. */
function request(at: number): Promise<number> {
  return new Promise((resolve, reject) => {
    get({ host: "127.0.0.1", port: at }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    }).on("error", reject);
  });
}

describe("runShutdown", () => {
  it("stops listening, then runs the steps in order", async () => {
    const server = await listening((_, response) => response.end("ok"));
    const at = port(server);
    const ran: string[] = [];
    const log: string[] = [];

    const code = await runShutdown(
      {
        servers: [server],
        steps: [
          { name: "backed up", run: async () => void ran.push("backed up") },
          { name: "closed the database", run: async () => void ran.push("closed the database") },
        ],
        budgetMs: 5000,
        log: (line) => log.push(line),
      },
      "SIGTERM",
    );

    expect(code).toBe(0);
    expect(ran).toEqual(["backed up", "closed the database"]);
    // The socket is gone, so nothing new can arrive while the steps run.
    await expect(request(at)).rejects.toThrow();
    expect(log.join("\n")).toContain("requests in flight have finished");
  });

  it("lets a request already in flight finish before closing the database", async () => {
    let release: (() => void) | null = null;
    const server = await listening((_, response) => {
      release = () => response.end("late");
    });
    const inFlight = request(port(server));
    // Wait for the handler to actually be running, not merely dispatched.
    while (release === null) await new Promise((r) => setTimeout(r, 5));

    const order: string[] = [];
    const shutdown = runShutdown(
      {
        servers: [server],
        steps: [{ name: "closed the database", run: async () => void order.push("closed") }],
        budgetMs: 5000,
        log: () => {},
      },
      "SIGTERM",
    );

    // Still open: the database must not close under a request that is running.
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual([]);

    (release as () => void)();
    order.push("answered");
    await expect(inFlight).resolves.toBe(200);
    await expect(shutdown).resolves.toBe(0);
    expect(order).toEqual(["answered", "closed"]);
  });

  it("reports a step that fails, carries on, and exits non-zero", async () => {
    const server = await listening((_, response) => response.end("ok"));
    const ran: string[] = [];
    const log: string[] = [];

    const code = await runShutdown(
      {
        servers: [server],
        steps: [
          {
            name: "backed up",
            run: () => Promise.reject(new Error("blob storage refused the write")),
          },
          { name: "closed the database", run: async () => void ran.push("closed") },
        ],
        budgetMs: 5000,
        log: (line) => log.push(line),
      },
      "SIGTERM",
    );

    expect(code).toBe(1);
    // Closing the database matters more than the backup, so a failed backup
    // must never be the reason the database is left open.
    expect(ran).toEqual(["closed"]);
    expect(log.join("\n")).toContain("blob storage refused the write");
  });

  it("abandons a step that runs out of time, names it, and still runs the steps after it", async () => {
    const server = await listening((_, response) => response.end("ok"));
    const log: string[] = [];
    const ran: string[] = [];

    const code = await runShutdown(
      {
        servers: [server],
        steps: [
          // A backup stuck on blob storage, which is the real case: the
          // network gives no answer and no error.
          { name: "backed up", run: () => new Promise<void>(() => {}) },
          {
            name: "closed the database",
            run: async () => {
              ran.push("closed");
            },
          },
        ],
        budgetMs: 150,
        log: (line) => log.push(line),
      },
      "SIGTERM",
    );

    expect(code).toBe(1);
    const said = log.join("\n");
    expect(said).toContain('"backed up"');
    expect(said).toContain("ran out of time");
    // The point of the whole file. A step that hangs gets its own share of the
    // budget and no more, so it cannot starve the step that closes the
    // database, which is the one that leaves Litestream a finished file.
    // Before this, the hanging step took the entire remaining budget and the
    // close survived only by however many milliseconds rounding left it.
    expect(ran).toEqual(["closed"]);
    expect(said).toContain("closed the database, in");
  });

  it("skips a step there is genuinely no time for, and says which", async () => {
    const server = await listening((_, response) => response.end("ok"));
    const log: string[] = [];
    const ran: string[] = [];

    // No budget at all: every step is skipped, and each is named. Saying so is
    // the whole value here, because the platform is about to kill us anyway
    // and the log is all anybody will have.
    const code = await runShutdown(
      {
        servers: [server],
        steps: [
          { name: "backed up", run: async () => void ran.push("backed up") },
          { name: "closed the database", run: async () => void ran.push("closed") },
        ],
        budgetMs: 0,
        log: (line) => log.push(line),
      },
      "SIGTERM",
    );

    expect(code).toBe(1);
    expect(ran).toEqual([]);
    const said = log.join("\n");
    expect(said).toContain('no time left for "backed up"');
    expect(said).toContain('no time left for "closed the database"');
    expect(said).toContain("CAIRN_SHUTDOWN_SECONDS");
  });

  it("gives up on a request that will not finish rather than overrun the budget", async () => {
    const server = await listening(() => {
      // Never responds: a handler stuck on something outside our control.
    });
    const pending = request(port(server)).catch(() => -1);
    await new Promise((r) => setTimeout(r, 20));

    const log: string[] = [];
    const started = Date.now();
    const code = await runShutdown(
      {
        servers: [server],
        steps: [{ name: "closed the database", run: async () => {} }],
        budgetMs: 200,
        log: (line) => log.push(line),
      },
      "SIGTERM",
    );

    // The whole point: bounded. Being killed mid-write is the thing we avoid.
    expect(Date.now() - started).toBeLessThan(2000);
    expect(code).toBe(0);
    expect(log.join("\n")).toContain("abandoned");
    server.closeAllConnections();
    await pending;
  });
});
