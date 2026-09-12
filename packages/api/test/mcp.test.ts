import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/app.js";
import { createContext, type AppContext } from "../src/context.js";
import { INSTRUCTIONS_BUDGET, SERVER_INSTRUCTIONS } from "../src/mcp/instructions.js";
import { replaceSection } from "../src/mcp/tools.js";

/**
 * Contract tests for the MCP tools, with realistic payloads (CLAUDE.md
 * verification step 3).
 *
 * They drive the Hono app through `app.fetch` rather than a socket, so they
 * exercise the same web standard Request and Response path every platform
 * uses, with no port to bind.
 */

const TOKEN = "test-token-0123456789abcdef";

let app: Hono;
let context: AppContext;
let nextId = 1;

async function rpc(method: string, params?: unknown, token = TOKEN) {
  const response = await app.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "user-agent": "claude-code/2.0.0",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

/** Call a tool and parse the JSON payload every tool returns as text. */
async function callTool(name: string, args: Record<string, unknown> = {}) {
  const { body } = await rpc("tools/call", { name, arguments: args });
  const result = body.result as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  return {
    isError: result.isError === true,
    data: JSON.parse(result.content[0]!.text) as Record<string, unknown>,
  };
}

beforeEach(async () => {
  context = await createContext({
    database: ":memory:",
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    workspaceId: "ws_test",
  });
  app = createApp({ context, token: TOKEN });
});

describe("transport and auth", () => {
  it("rejects a request with no token", async () => {
    const response = await app.fetch(
      new Request("http://localhost/mcp", { method: "POST" }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const { status } = await rpc("tools/list", undefined, "wrong-token-aaaaaaaaaaaa");
    expect(status).toBe(401);
  });

  it("answers initialize with the current protocol version", async () => {
    const { body } = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(body.result.serverInfo.name).toBe("cairn");
    expect(body.result.protocolVersion).toBeTruthy();
  });

  it("tells the client when to use Cairn, within a small budget", async () => {
    const { body } = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "2.0.0" },
    });
    const instructions = body.result.instructions as string;
    // The fixed text first, then the live summary (ADR-012).
    expect(instructions.startsWith(SERVER_INSTRUCTIONS)).toBe(true);
    expect(instructions.length).toBeLessThanOrEqual(INSTRUCTIONS_BUDGET);
    // Every tool the instructions name must exist, or the client is sent
    // looking for something that is not there.
    const { body: listed } = await rpc("tools/list");
    const names = new Set((listed.result.tools as Array<{ name: string }>).map((t) => t.name));
    const mentioned = instructions.match(/\b[a-z]+_[a-z_]+\b/g) ?? [];
    const tools = mentioned.filter((word) => word !== "version_conflict" && word !== "change_note");
    expect(tools.length).toBeGreaterThan(0);
    for (const name of tools) expect(names.has(name), name).toBe(true);
    expect(names.has("search")).toBe(true);
  });

  it("serves every tool from PRD section 8, plus history", async () => {
    const { body } = await rpc("tools/list");
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names.sort()).toEqual(
      [
        "create_collection",
        "create_page",
        "get_backlinks",
        "get_history",
        "get_neighbours",
        "get_page",
        "get_revision",
        "list_collections",
        "query_collection",
        "search",
        "update_page",
        "upsert_row",
      ].sort(),
    );
  });

  it("describes each tool and its inputs, since the description is the contract", async () => {
    const { body } = await rpc("tools/list");
    for (const tool of body.result.tools as Array<{
      name: string;
      description?: string;
      inputSchema: { properties?: Record<string, unknown> };
    }>) {
      expect(tool.description, `${tool.name} has no description`).toBeTruthy();
      expect(tool.description!.length).toBeGreaterThan(40);
    }
  });

  it("handles each request independently, as a stateless transport must", async () => {
    // No initialize first, and no session id: a serverless instance may see
    // only this one call.
    const { body } = await rpc("tools/list");
    expect(body.result.tools).toBeDefined();
  });
});

describe("page tools", () => {
  it("creates, reads and searches a page", async () => {
    const created = await callTool("create_page", {
      title: "Print log",
      body: "# Failures\n\nFirst layer lifted, bed adhesion was poor.",
      tags: ["printing"],
    });
    expect(created.isError).toBe(false);
    const pageId = created.data["id"] as string;
    expect(created.data["version"]).toBeTruthy();

    const found = await callTool("search", { query: "adhesion" });
    expect(found.data["mode"]).toBe("keyword");
    const hits = found.data["hits"] as Array<Record<string, unknown>>;
    expect(hits[0]!["page_id"]).toBe(pageId);
    expect(hits[0]!["heading_path"]).toEqual(["Print log", "Failures"]);

    const read = await callTool("get_page", { page_id: pageId });
    expect(read.data["body"]).toContain("bed adhesion");
    expect(read.data["version"]).toBe(created.data["version"]);
  });

  it("tells Claude to retry differently when nothing matches", async () => {
    const result = await callTool("search", { query: "zzzznotaword" });
    expect(result.data["hits"]).toEqual([]);
    expect(result.data["hint"]).toContain("synonyms");
  });

  it("returns a usable error for a page that does not exist", async () => {
    const result = await callTool("get_page", { page_id: "pg_nope" });
    expect(result.isError).toBe(true);
    expect(result.data["error"]).toBe("not_found");
    expect(result.data["message"]).toContain("search");
  });

  it("appends without losing the rest of the page", async () => {
    const created = await callTool("create_page", {
      title: "Notes",
      body: "existing content",
    });
    const updated = await callTool("update_page", {
      page_id: created.data["id"],
      version: created.data["version"],
      mode: "append",
      content: "new line",
    });
    expect(updated.isError).toBe(false);

    const read = await callTool("get_page", { page_id: created.data["id"] });
    expect(read.data["body"]).toBe("existing content\n\nnew line");
  });

  it("replaces one section and leaves the others alone", async () => {
    const created = await callTool("create_page", {
      title: "Quad build",
      body: "# ESC\n\nold firmware\n\n# Motors\n\n2207 1750kv",
    });
    await callTool("update_page", {
      page_id: created.data["id"],
      version: created.data["version"],
      mode: "replace_section",
      section: "ESC",
      content: "BLHeli_32, flashed 2026-09-01",
    });

    const read = await callTool("get_page", { page_id: created.data["id"] });
    const body = read.data["body"] as string;
    expect(body).toContain("BLHeli_32");
    expect(body).not.toContain("old firmware");
    expect(body).toContain("2207 1750kv");
  });

  it("reports a missing section instead of writing in the wrong place", async () => {
    const created = await callTool("create_page", { title: "P", body: "# A\n\nx" });
    const result = await callTool("update_page", {
      page_id: created.data["id"],
      version: created.data["version"],
      mode: "replace_section",
      section: "Nonexistent",
      content: "y",
    });
    expect(result.isError).toBe(true);
    expect(result.data["error"]).toBe("not_found");
  });

  it("returns the current content on a version conflict so Claude can merge", async () => {
    const created = await callTool("create_page", { title: "Shared", body: "v1" });
    await callTool("update_page", {
      page_id: created.data["id"],
      version: created.data["version"],
      mode: "replace_body",
      content: "v2 from someone else",
    });

    const stale = await callTool("update_page", {
      page_id: created.data["id"],
      version: created.data["version"],
      mode: "replace_body",
      content: "v2 from Claude",
    });

    expect(stale.isError).toBe(true);
    expect(stale.data["error"]).toBe("version_conflict");
    expect(stale.data["current_version"]).toBeTruthy();
    expect(JSON.stringify(stale.data["current_content"])).toContain("someone else");
  });

  it("reads backlinks and neighbours from links written in the body", async () => {
    const target = await callTool("create_page", { title: "Target", body: "target" });
    const source = await callTool("create_page", {
      title: "Source",
      body: `see [[${target.data["id"]}]] for context`,
    });

    const backlinks = await callTool("get_backlinks", { page_id: target.data["id"] });
    expect((backlinks.data["backlinks"] as unknown[]).length).toBe(1);

    const neighbours = await callTool("get_neighbours", { page_id: source.data["id"] });
    const outbound = neighbours.data["outbound"] as Array<Record<string, unknown>>;
    expect(outbound.map((e) => e["page_id"])).toContain(target.data["id"]);
  });

  it("includes backlinks in get_page when asked", async () => {
    const target = await callTool("create_page", { title: "Hub", body: "hub" });
    await callTool("create_page", {
      title: "Spoke",
      body: `[[${target.data["id"]}]]`,
    });

    const read = await callTool("get_page", {
      page_id: target.data["id"],
      include_backlinks: true,
    });
    expect((read.data["backlinks"] as unknown[]).length).toBe(1);
  });

  it("truncates a long page and offers an offset to continue", async () => {
    const body = "paragraph of text.\n\n".repeat(2_000);
    const created = await callTool("create_page", { title: "Long", body });

    const first = await callTool("get_page", { page_id: created.data["id"] });
    expect(first.data["truncated"]).toBe(true);
    expect(first.data["next_offset"]).toBeGreaterThan(0);

    const second = await callTool("get_page", {
      page_id: created.data["id"],
      offset: first.data["next_offset"],
    });
    expect((second.data["body"] as string).length).toBeGreaterThan(0);
  });
});

describe("collection tools", () => {
  it("creates a collection, upserts rows and queries them", async () => {
    const collection = await callTool("create_collection", {
      name: "Prints",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "grams", type: "number" },
        { name: "material", type: "select", options: ["pla", "petg"] },
      ],
    });
    const collectionId = collection.data["id"] as string;

    const listed = await callTool("list_collections");
    expect((listed.data["collections"] as Array<{ id: string }>)[0]!.id).toBe(collectionId);

    for (const values of [
      { title: "Bracket", grams: 12.5, material: "pla" },
      { title: "Enclosure", grams: 210, material: "petg" },
    ]) {
      const row = await callTool("upsert_row", { collection_id: collectionId, values });
      expect(row.isError).toBe(false);
    }

    const heavy = await callTool("query_collection", {
      collection_id: collectionId,
      where: [{ field: "grams", op: "gt", value: 100 }],
      sort: [{ field: "grams", direction: "desc" }],
    });
    const rows = heavy.data["rows"] as Array<{ values: Record<string, unknown> }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.values["title"]).toBe("Enclosure");
  });

  it("names every invalid field at once so one retry fixes them all", async () => {
    const collection = await callTool("create_collection", {
      name: "Prints",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "printed", type: "date", required: true },
        { name: "material", type: "select", options: ["pla", "petg"] },
      ],
    });

    const result = await callTool("upsert_row", {
      collection_id: collection.data["id"],
      values: { material: "nylon" },
    });

    expect(result.isError).toBe(true);
    expect(result.data["error"]).toBe("validation_failed");
    const fields = result.data["fields"] as Array<{ field: string }>;
    expect(fields.map((f) => f.field).sort()).toEqual(["material", "printed", "title"]);
  });

  it("updates an existing row by id and version", async () => {
    const collection = await callTool("create_collection", {
      name: "Parts",
      fields: [{ name: "title", type: "text", required: true }],
    });
    const row = await callTool("upsert_row", {
      collection_id: collection.data["id"],
      values: { title: "First" },
    });

    const updated = await callTool("upsert_row", {
      collection_id: collection.data["id"],
      row_id: row.data["id"],
      version: row.data["version"],
      values: { title: "Second" },
    });
    expect(updated.isError).toBe(false);
    expect((updated.data["values"] as Record<string, unknown>)["title"]).toBe("Second");

    const stale = await callTool("upsert_row", {
      collection_id: collection.data["id"],
      row_id: row.data["id"],
      version: row.data["version"],
      values: { title: "Third" },
    });
    expect(stale.isError).toBe(true);
    expect(stale.data["error"]).toBe("version_conflict");
  });
});

describe("replaceSection", () => {
  it("stops at the next heading of the same or higher level", () => {
    const body = "# A\n\nold a\n\n## A1\n\nnested\n\n# B\n\nkeep b";
    const result = replaceSection(body, "A", "new a")!;
    expect(result).toContain("new a");
    expect(result).not.toContain("nested");
    expect(result).toContain("keep b");
  });

  it("matches a heading regardless of case and level", () => {
    expect(replaceSection("### Fixes\n\nold", "fixes", "new")).toContain("new");
  });

  it("returns null when the heading is not there", () => {
    expect(replaceSection("# A\n\nx", "B", "y")).toBeNull();
  });
});

describe("history tools (ADR-008)", () => {
  it("attributes every write to the calling agent, with its change note", async () => {
    const created = await callTool("create_page", {
      title: "Print log",
      body: "first",
      change_note: "Started a log for the H2S",
    });
    expect((created.data["updated_by"] as Record<string, unknown>)["kind"]).toBe("agent");
    expect((created.data["updated_by"] as Record<string, unknown>)["name"]).toBe(
      "claude-code/2.0.0",
    );

    const history = await callTool("get_history", { page_id: created.data["id"] });
    const revisions = history.data["revisions"] as Array<Record<string, unknown>>;
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!["note"]).toBe("Started a log for the H2S");
    expect((revisions[0]!["by"] as Record<string, unknown>)["kind"]).toBe("agent");
  });

  it("lists a page's versions newest first and diffs one against the last", async () => {
    const created = await callTool("create_page", {
      title: "Quad build",
      body: "# ESC\n\nold firmware\n\n# Motors\n\n2207 1750kv",
    });
    const updated = await callTool("update_page", {
      page_id: created.data["id"],
      version: created.data["version"],
      mode: "replace_section",
      section: "ESC",
      content: "BLHeli_32",
      change_note: "Recorded the firmware flashed today",
    });

    const history = await callTool("get_history", { page_id: created.data["id"] });
    const revisions = history.data["revisions"] as Array<Record<string, unknown>>;
    expect(revisions.map((r) => r["version"])).toEqual([
      updated.data["version"],
      created.data["version"],
    ]);

    const revision = await callTool("get_revision", {
      page_id: created.data["id"],
      version: updated.data["version"],
    });
    const diff = revision.data["diff"] as string;
    expect(diff).toContain("- old firmware");
    expect(diff).toContain("+ BLHeli_32");
    expect(revision.data["note"]).toBe("Recorded the firmware flashed today");

    const first = await callTool("get_revision", {
      page_id: created.data["id"],
      version: created.data["version"],
    });
    expect(first.data["diff"]).toBeNull();
    expect(first.data["body"]).toContain("old firmware");
  });

  it("gives row history and a field diff", async () => {
    const collection = await callTool("create_collection", {
      name: "Parts",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "grams", type: "number" },
      ],
    });
    const row = await callTool("upsert_row", {
      collection_id: collection.data["id"],
      values: { title: "Bracket", grams: 12 },
    });
    const updated = await callTool("upsert_row", {
      collection_id: collection.data["id"],
      row_id: row.data["id"],
      version: row.data["version"],
      values: { title: "Bracket", grams: 14 },
      change_note: "Weighed it after printing",
    });

    const history = await callTool("get_history", {
      collection_id: collection.data["id"],
      row_id: row.data["id"],
    });
    expect((history.data["revisions"] as unknown[]).length).toBe(2);

    const revision = await callTool("get_revision", {
      collection_id: collection.data["id"],
      row_id: row.data["id"],
      version: updated.data["version"],
    });
    expect(revision.data["diff"]).toContain("+ grams: 14");
  });

  it("asks for an id rather than guessing when none is given", async () => {
    const result = await callTool("get_history", {});
    expect(result.isError).toBe(true);
    expect(result.data["error"]).toBe("validation_failed");
  });

  it("reports an unknown version as not found", async () => {
    const created = await callTool("create_page", { title: "P", body: "x" });
    const result = await callTool("get_revision", {
      page_id: created.data["id"],
      version: "no-such-version",
    });
    expect(result.isError).toBe(true);
    expect(result.data["error"]).toBe("not_found");
  });
});
