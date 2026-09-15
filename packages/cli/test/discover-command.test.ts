import { beforeEach, describe, expect, it } from "vitest";
import { createApp, createContext, type AppContext } from "@cairn/api";
import { run, type Io } from "../src/main.js";

/**
 * `cairn discover` end to end (roadmap "Discovery by following citations",
 * ADR-041): a contract test with a realistic payload, per "Verification
 * before calling a task done" item 3.
 */

const CAIRN_BASE = "http://localhost:8787";
const FRIEND = { cairn: "1", name: "Peptide Lab", description: "peptide research notes", cites: ["https://stranger.example"] };
const STRANGER = { cairn: "1", name: "Stranger Cairn", cites: [] };

let context: AppContext;
let app: ReturnType<typeof createApp>;
let stdout: string;
let stderr: string;

function io(): Io {
  return {
    fetch: async (request) => {
      if (request.url.startsWith(CAIRN_BASE)) return app.fetch(request);
      if (request.url === "https://friend.example/.well-known/cairn.json") return Response.json(FRIEND);
      if (request.url === "https://stranger.example/.well-known/cairn.json") return Response.json(STRANGER);
      if (request.url === "https://dead.example/.well-known/cairn.json") return new Response(null, { status: 404 });
      throw new Error(`unexpected request in test: ${request.url}`);
    },
    env: { CAIRN_CREDENTIALS: "/nonexistent/cairn-test/credentials.json" },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: async () => null,
  };
}

async function cairn(...argv: string[]): Promise<number> {
  stdout = "";
  stderr = "";
  return run(argv, io());
}

beforeEach(async () => {
  context = await createContext({ database: ":memory:", workspaceId: "ws" });
  const trust = { enabled: true, hosts: ["localhost"] };
  app = createApp({ context, token: null, trust });
});

describe("discover", () => {
  it("refuses to run with no starting point", async () => {
    const code = await cairn("discover");
    expect(code).not.toBe(0);
    expect(stderr).toContain("no starting point");
  });

  it("walks from --from and records a newly found Cairn in Discovered cairns", async () => {
    const code = await cairn("discover", "--from", "https://friend.example", "--json");
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as { found: Array<{ url: string; name: string | null }>; visited: number };
    expect(json.found).toEqual([{ url: "https://stranger.example", name: "Stranger Cairn", discoveredVia: "https://friend.example", depth: 1 }]);
    expect(json.visited).toBe(2);

    const ws = context.workspaceId;
    const tables = await context.tables.list(ws);
    const table = tables.find((t) => t.name === "Discovered cairns")!;
    const rows = await context.tables.queryRows(ws, table.id, {});
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]!.values["url"]).toBe("https://stranger.example");
  });

  it("walks from Trusted cairns when --from is not given", async () => {
    await cairn("trust", "https://friend.example");
    const code = await cairn("discover", "--json");
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as { found: Array<{ url: string }> };
    expect(json.found.map((f) => f.url)).toEqual(["https://stranger.example"]);
  });

  it("does not report an already-trusted starting point as found, even when another starting point cites it", async () => {
    await cairn("trust", "https://friend.example");
    await cairn("trust", "https://stranger.example");
    const code = await cairn("discover", "--json");
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as { found: unknown[] };
    expect(json.found).toEqual([]);
  });

  it("respects --depth", async () => {
    const code = await cairn("discover", "--from", "https://friend.example", "--depth", "0", "--json");
    // depth must be positive, so 0 is refused rather than silently walking nothing
    expect(code).not.toBe(0);
    expect(stderr).toContain("--depth");
  });

  it("reports an unreachable address without failing the whole walk", async () => {
    const code = await cairn("discover", "--from", "https://dead.example", "--json");
    expect(code).toBe(0);
    const json = JSON.parse(stdout) as { unreachable: Array<{ url: string }> };
    expect(json.unreachable.map((u) => u.url)).toEqual(["https://dead.example"]);
  });
});
