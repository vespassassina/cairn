import { beforeEach, describe, expect, it } from "vitest";
import { createApp, createContext, OWNER, type AppContext } from "@cairn/api";
import { run, type Io } from "../src/main.js";

/**
 * `cairn check-sources` end to end (roadmap "Citations kept correct",
 * ADR-036): a contract test with a realistic payload, per "Verification
 * before calling a task done" item 3.
 */

const BY = { actor: OWNER, note: null };
const CAIRN_BASE = "http://localhost:8787";

let context: AppContext;
let app: ReturnType<typeof createApp>;
let stdout: string;
let stderr: string;

function io(): Io {
  return {
    fetch: async (request) => {
      if (request.url.startsWith(CAIRN_BASE)) return app.fetch(request);
      if (request.url === "https://example.com/alive") return new Response(null, { status: 200 });
      if (request.url === "https://example.com/gone") return new Response(null, { status: 404 });
      if (request.url.startsWith("https://archive.org/wayback/available")) {
        return Response.json({ archived_snapshots: { closest: { available: true, url: "https://web.archive.org/web/2021/https://example.com/gone" } } });
      }
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
  const ws = context.workspaceId;
  await context.pages.create(
    ws,
    { title: "TB-500", body: "Research only.", sources: ["https://example.com/alive", "https://example.com/gone", "Smith 2021, J Pept Sci"] },
    BY,
    "pg_tb-500",
  );
  const table = await context.tables.create(ws, { name: "Peptides", fields: [{ name: "name", type: "text", required: true }] }, BY, "col_peptides");
  await context.tables.upsertRow(ws, table.id, { values: { name: "BPC-157" }, sources: ["10.1038/does-not-exist"] }, BY, { id: "row_bpc" });
});

describe("check-sources", () => {
  it("reports dead sources with an archived copy, and leaves plain citations unchecked", async () => {
    const code = await cairn("check-sources", "--json");
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as { checked: number; dead: Array<{ href: string; ok: boolean; status?: number; archived?: string | null }> };
    expect(report.checked).toBe(3); // the alive link, the dead link and the DOI; not the plain citation
    expect(report.dead).toHaveLength(2);
    const gone = report.dead.find((d) => d.href === "https://example.com/gone")!;
    expect(gone.status).toBe(404);
    expect(gone.archived).toBe("https://web.archive.org/web/2021/https://example.com/gone");
    const doi = report.dead.find((d) => d.href === "https://doi.org/10.1038/does-not-exist")!;
    expect(doi.ok).toBe(false);
  });

  it("prints a plain-text summary without --json", async () => {
    const code = await cairn("check-sources");
    expect(code).toBe(0);
    expect(stdout).toContain("dead source");
    expect(stdout).toContain("https://example.com/gone");
    expect(stdout).toContain("archived copy: https://web.archive.org/web/2021/https://example.com/gone");
    expect(stdout).toContain('on page "TB-500"');
  });
});
