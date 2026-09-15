import { beforeEach, describe, expect, it } from "vitest";
import { createApp, createContext, type AppContext } from "@cairn/api";
import { run, type Io } from "../src/main.js";

/**
 * `cairn trust` end to end (roadmap "A local trusted friends catalog",
 * ADR-037): a contract test with a realistic payload, per "Verification
 * before calling a task done" item 3.
 */

const CAIRN_BASE = "http://localhost:8787";
const PEER_DESCRIPTION = { cairn: "1", name: "Peptide Lab", description: "peptide research notes" };

let context: AppContext;
let app: ReturnType<typeof createApp>;
let stdout: string;
let stderr: string;

function io(): Io {
  return {
    fetch: async (request) => {
      if (request.url.startsWith(CAIRN_BASE)) return app.fetch(request);
      if (request.url === "https://friend.example/.well-known/cairn.json") return Response.json(PEER_DESCRIPTION);
      if (request.url === "https://stranger.example/.well-known/cairn.json") return new Response(null, { status: 404 });
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

describe("trust", () => {
  it("creates the Trusted cairns table on first use and adds a row", async () => {
    const code = await cairn("trust", "https://friend.example", "--note", "shares peptide sourcing", "--json");
    expect(code).toBe(0);
    const row = JSON.parse(stdout) as { values: Record<string, unknown> };
    expect(row.values["url"]).toBe("https://friend.example");
    expect(row.values["name"]).toBe("Peptide Lab");
    expect(row.values["note"]).toBe("shares peptide sourcing");
    expect(row.values["added_at"]).toBeTruthy();

    const tables = await cairn("tables", "--json");
    expect(tables).toBe(0);
    const list = JSON.parse(stdout) as { tables: Array<{ name: string }> };
    expect(list.tables.some((t) => t.name === "Trusted cairns")).toBe(true);
  });

  it("updates the existing row instead of duplicating it when trusted again", async () => {
    await cairn("trust", "https://friend.example");
    const code = await cairn("trust", "https://friend.example", "--note", "now also cites us", "--json");
    expect(code).toBe(0);

    const ws = context.workspaceId;
    const tables = await context.tables.list(ws);
    const table = tables.find((t) => t.name === "Trusted cairns")!;
    const rows = await context.tables.queryRows(ws, table.id, {});
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0]!.values["note"]).toBe("now also cites us");
  });

  it("refuses an address that is not a Cairn", async () => {
    const code = await cairn("trust", "https://stranger.example");
    expect(code).not.toBe(0);
    expect(stderr).toContain("answered 404");
  });

  it("prints a plain-text confirmation without --json", async () => {
    const code = await cairn("trust", "https://friend.example");
    expect(code).toBe(0);
    expect(stdout).toContain("trusted Peptide Lab (https://friend.example)");
    expect(stdout).toContain("peptide research notes");
  });
});
