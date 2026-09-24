import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { eventually } from "@cairn/core/testing";
import { encode as encodePng } from "@jsquash/png";
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
    // Words that name an error or a field, not a tool.
    const tools = mentioned.filter((word) => !["version_conflict", "change_note", "verified_at"].includes(word));
    expect(tools.length).toBeGreaterThan(0);
    for (const name of tools) expect(names.has(name), name).toBe(true);
    expect(names.has("search")).toBe(true);
  });

  it("serves every tool from PRD section 8, plus history and move", async () => {
    const { body } = await rpc("tools/list");
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names.sort()).toEqual(
      [
        "create_table",
        "create_page",
        "create_page_from_template",
        "delete_page",
        "get_today_note",
        "get_backlinks",
        "get_changes",
        "get_history",
        "get_neighbours",
        "get_page",
        "get_revision",
        "list_children",
        "list_deleted_pages",
        "list_stale_pages",
        "list_tables",
        "move",
        "query_table",
        "search",
        "undelete_page",
        "update_page",
        "update_table",
        "upsert_row",
        "vacuum_page",
        "create_attachment",
        "confirm_attachment_upload",
        "get_attachment",
        "list_attachments",
        "delete_attachment",
        "list_synonyms",
        "add_synonym",
        "remove_synonym",
      ].sort(),
    );
    // No tool publishes a page, on purpose: publishing is the owner's action,
    // never an agent's (ADR-032 decision 5).
    expect(names.some((name) => name.includes("publish"))).toBe(false);
  });

  it("does not let an agent publish what it wrote", async () => {
    const created = await rpc("tools/call", {
      name: "create_page",
      arguments: { title: "Notes", body: "Text.", change_note: "First" },
    });
    const id = JSON.parse(created.body.result.content[0].text).id as string;
    // Even asked for it by name, and even with the field on the payload.
    const asked = await rpc("tools/call", {
      name: "update_page",
      arguments: { id, title: "Notes", body: "Text.", change_note: "Try", public: true },
    });
    expect(asked.status).toBe(200);
    expect((await context.store.getPage(context.workspaceId, id))!.public).toBe(false);
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
    const pages = found.data["pages"] as Array<Record<string, unknown>>;
    expect(pages[0]!["page_id"]).toBe(pageId);
    const passages = pages[0]!["passages"] as Array<Record<string, unknown>>;
    expect(passages[0]!["heading_path"]).toEqual(["Print log", "Failures"]);

    const read = await callTool("get_page", { page_id: pageId });
    expect(read.data["body"]).toContain("bed adhesion");
    expect(read.data["version"]).toBe(created.data["version"]);
  });

  it("tells Claude to retry differently when nothing matches", async () => {
    const result = await callTool("search", { query: "zzzznotaword" });
    expect(result.data["pages"]).toEqual([]);
    expect(result.data["hint"]).toContain("zzzznotaword");
    expect(result.data["hint"]).toContain("synonyms");
  });

  it("groups a page's matches together, capped at three passages, and never repeats a page (ADR-057, criteria 8, 9)", async () => {
    await callTool("create_page", {
      title: "Zoetropic notes",
      body: [
        "## First",
        "",
        "zoetropic appears here first.",
        "",
        "## Second",
        "",
        "zoetropic appears here too.",
        "",
        "## Third",
        "",
        "zoetropic and more zoetropic.",
        "",
        "## Fourth",
        "",
        "a fourth zoetropic mention.",
      ].join("\n"),
    });

    const found = await callTool("search", { query: "zoetropic" });
    const pages = found.data["pages"] as Array<Record<string, unknown>>;
    expect(pages).toHaveLength(1);
    const passages = pages[0]!["passages"] as unknown[];
    expect(passages.length).toBeLessThanOrEqual(3);
    expect(pages[0]!["more_passages"]).toBe(4 - passages.length);

    const ids = pages.map((p) => p["page_id"]);
    expect(new Set(ids).size).toBe(ids.length);
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

  it("reads a link to another Cairn's published page as a cairn_link neighbour (ADR-038)", async () => {
    const source = await callTool("create_page", {
      title: "Source",
      body: "see [their notes](https://other.example.com/w/pg_notes) for context",
    });

    const neighbours = await callTool("get_neighbours", { page_id: source.data["id"] });
    const outbound = neighbours.data["outbound"] as Array<Record<string, unknown>>;
    expect(outbound).toContainEqual({
      cairn_url: "https://other.example.com/w/pg_notes",
      type: "cairn_link",
      label: "their notes",
    });
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

describe("templates and daily notes (ADR-075)", () => {
  it("creates a page from a template with create_page_from_template, substituting {{date}} and {{title}}", async () => {
    const template = await callTool("create_page", {
      title: "Meeting notes",
      body: "# {{title}}\n\nDate: {{date}}\n\n## Attendees\n",
    });
    const templateId = template.data["id"] as string;

    const created = await callTool("create_page_from_template", {
      template_id: templateId,
      title: "Standup with Sam",
    });
    expect(created.isError).toBe(false);
    expect(created.data["title"]).toBe("Standup with Sam");

    const today = new Date().toISOString().slice(0, 10);
    const read = await callTool("get_page", { page_id: created.data["id"] as string });
    expect(read.data["body"]).toBe(`# Standup with Sam\n\nDate: ${today}\n\n## Attendees\n`);

    const missing = await callTool("create_page_from_template", { template_id: "pg_nope", title: "X" });
    expect(missing.isError).toBe(true);
  });

  it("finds or creates today's daily note with get_today_note, never duplicating it the same day", async () => {
    const first = await callTool("get_today_note");
    expect(first.isError).toBe(false);
    expect(first.data["created"]).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect(first.data["title"]).toBe(today);

    const second = await callTool("get_today_note");
    expect(second.data["created"]).toBe(false);
    expect(second.data["id"]).toBe(first.data["id"]);
  });
});

describe("tables in the tree and rows as links (ADR-024)", () => {
  it("puts a table under a page, links rows to rows, and finds the backlinks", async () => {
    const home = await callTool("create_page", { title: "Peptides", body: "Everything about peptides." });
    const homeId = home.data["id"] as string;
    const peptides = await callTool("create_table", {
      name: "Peptides",
      fields: [{ name: "name", type: "text", required: true }],
      change_note: "A table for the peptides",
    });
    const peptidesId = peptides.data["id"] as string;
    const stacks = await callTool("create_table", {
      name: "Stacks",
      parent_id: homeId,
      fields: [
        { name: "title", type: "text", required: true },
        { name: "components", type: "relation", target: peptidesId, multiple: true },
      ],
      change_note: "A table for the stacks",
    });
    const stacksId = stacks.data["id"] as string;

    const bpc = await callTool("upsert_row", { table_id: peptidesId, values: { name: "BPC-157" } });
    const tb = await callTool("upsert_row", { table_id: peptidesId, values: { name: "TB-500" } });
    const wolverine = await callTool("upsert_row", {
      table_id: stacksId,
      values: { title: "Wolverine", components: [bpc.data["id"], tb.data["id"]] },
      change_note: "The healing stack",
    });
    expect(wolverine.isError).toBe(false);

    const backlinks = await callTool("get_backlinks", { table_id: peptidesId, row_id: bpc.data["id"] });
    expect(backlinks.data["backlinks"]).toEqual([
      { table_id: stacksId, row_id: wolverine.data["id"], type: "relation", label: "components" },
    ]);
    const around = await callTool("get_neighbours", { table_id: stacksId, row_id: wolverine.data["id"] });
    expect((around.data["outbound"] as unknown[]).length).toBe(2);

    const listed = await callTool("list_tables");
    const placed = (listed.data["tables"] as Array<Record<string, unknown>>).find((c) => c["id"] === stacksId)!;
    expect(placed["parent_id"]).toBe(homeId);

    const moved = await callTool("move", { id: peptidesId, parent_id: homeId, version: peptides.data["version"], change_note: "Group under Peptides" });
    expect(moved.data).toMatchObject({ kind: "table", id: peptidesId, parent_id: homeId });
  });

  it("refuses a bad move, naming the field", async () => {
    const page = await callTool("create_page", { title: "Alone", body: "x" });
    const result = await callTool("move", { id: page.data["id"], parent_id: "pg_nowhere", version: page.data["version"] });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.data)).toContain("parent_id");
  });

  it("asks for an id when get_backlinks has none", async () => {
    const result = await callTool("get_backlinks", {});
    expect(result.isError).toBe(true);
  });
});

describe("table tools", () => {
  it("creates a table, upserts rows and queries them", async () => {
    const table = await callTool("create_table", {
      name: "Prints",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "grams", type: "number" },
        { name: "material", type: "select", options: ["pla", "petg"] },
      ],
      change_note: "A table for the prints",
    });
    const tableId = table.data["id"] as string;

    const listed = await callTool("list_tables");
    expect((listed.data["tables"] as Array<{ id: string }>)[0]!.id).toBe(tableId);

    for (const values of [
      { title: "Bracket", grams: 12.5, material: "pla" },
      { title: "Enclosure", grams: 210, material: "petg" },
    ]) {
      const row = await callTool("upsert_row", { table_id: tableId, values });
      expect(row.isError).toBe(false);
    }

    const heavy = await callTool("query_table", {
      table_id: tableId,
      where: [{ field: "grams", op: "gt", value: 100 }],
      sort: [{ field: "grams", direction: "desc" }],
    });
    const rows = heavy.data["rows"] as Array<{ values: Record<string, unknown> }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.values["title"]).toBe("Enclosure");
  });

  it("names every invalid field at once so one retry fixes them all", async () => {
    const table = await callTool("create_table", {
      name: "Prints",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "printed", type: "date", required: true },
        { name: "material", type: "select", options: ["pla", "petg"] },
      ],
      change_note: "A table for the prints",
    });

    const result = await callTool("upsert_row", {
      table_id: table.data["id"],
      values: { material: "nylon" },
    });

    expect(result.isError).toBe(true);
    expect(result.data["error"]).toBe("validation_failed");
    const fields = result.data["fields"] as Array<{ field: string }>;
    expect(fields.map((f) => f.field).sort()).toEqual(["material", "printed", "title"]);
  });

  it("updates an existing row by id and version", async () => {
    const table = await callTool("create_table", {
      name: "Parts",
      fields: [{ name: "title", type: "text", required: true }],
      change_note: "A table for the parts",
    });
    const row = await callTool("upsert_row", {
      table_id: table.data["id"],
      values: { title: "First" },
    });

    const updated = await callTool("upsert_row", {
      table_id: table.data["id"],
      row_id: row.data["id"],
      version: row.data["version"],
      values: { title: "Second" },
    });
    expect(updated.isError).toBe(false);
    expect((updated.data["values"] as Record<string, unknown>)["title"]).toBe("Second");

    const stale = await callTool("upsert_row", {
      table_id: table.data["id"],
      row_id: row.data["id"],
      version: row.data["version"],
      values: { title: "Third" },
    });
    expect(stale.isError).toBe(true);
    expect(stale.data["error"]).toBe("version_conflict");
  });
});

describe("sources (ADR-027)", () => {
  const PAPER = "https://pubmed.ncbi.nlm.nih.gov/12345/";
  const CITE = "Smith 2021, J Pept Sci";

  it("records where a page's facts came from, and adds to them on update", async () => {
    const created = await callTool("create_page", {
      title: "BPC-157",
      body: "# BPC-157\n\nA gastric peptide studied for tendon healing.",
      sources: [PAPER],
      change_note: "Started from the review",
    });
    expect(created.data["sources"]).toEqual([PAPER]);

    const updated = await callTool("update_page", {
      page_id: created.data["id"],
      version: created.data["version"],
      mode: "append",
      content: "## Dosing\n\nStudied at 10 mcg/kg in rats.",
      sources: [CITE],
      change_note: "Added dosing from Smith",
    });
    expect(updated.isError).toBe(false);
    expect(updated.data["sources"]).toEqual([PAPER, CITE]);

    const read = await callTool("get_page", { page_id: created.data["id"] });
    expect(read.data["sources"]).toEqual([PAPER, CITE]);

    const revision = await callTool("get_revision", {
      page_id: created.data["id"],
      version: updated.data["version"],
    });
    expect(revision.data["sources_added"]).toEqual([CITE]);
  });

  it("adds to a row's sources on upsert, and leaves empty lists out of a query", async () => {
    const table = await callTool("create_table", {
      name: "Peptides",
      fields: [{ name: "name", type: "text", required: true }],
      change_note: "A table for the peptides",
    });
    const row = await callTool("upsert_row", {
      table_id: table.data["id"],
      values: { name: "BPC-157" },
      sources: [PAPER],
    });
    const updated = await callTool("upsert_row", {
      table_id: table.data["id"],
      row_id: row.data["id"],
      version: row.data["version"],
      values: { name: "BPC-157" },
      sources: [CITE],
    });
    expect(updated.data["sources"]).toEqual([PAPER, CITE]);
    await callTool("upsert_row", { table_id: table.data["id"], values: { name: "TB-500" } });

    const query = await callTool("query_table", { table_id: table.data["id"] });
    const rows = query.data["rows"] as Array<Record<string, unknown>>;
    expect(rows.find((r) => (r["values"] as Record<string, unknown>)["name"] === "BPC-157")!["sources"]).toEqual([
      PAPER,
      CITE,
    ]);
    expect(rows.find((r) => (r["values"] as Record<string, unknown>)["name"] === "TB-500")).not.toHaveProperty("sources");
  });

  it("refuses a quotation passed off as a source, as an input error", async () => {
    const { body } = await rpc("tools/call", {
      name: "create_page",
      arguments: { title: "Quote", body: "x", sources: ["x".repeat(501)] },
    });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("sources");
  });
});

describe("freshness (ADR-028)", () => {
  const PAPER = "https://pubmed.ncbi.nlm.nih.gov/12345/";

  it("marks a page verified with an update that changes nothing else, and shows it in history", async () => {
    const created = await callTool("create_page", {
      title: "Thymosin beta-4",
      body: "# Thymosin beta-4\n\nStudied for wound repair.",
      change_note: "Started a page",
    });
    expect(created.data["verified_at"]).toBeNull();

    const checked = await callTool("update_page", {
      page_id: created.data["id"],
      version: created.data["version"],
      mode: "append",
      content: "",
      verified: true,
      change_note: "Re-read the 2021 review: still right",
    });
    expect(checked.isError).toBe(false);
    expect(checked.data["verified_at"]).toBe(checked.data["updated_at"]);

    const read = await callTool("get_page", { page_id: created.data["id"] });
    expect(read.data["body"]).toBe("# Thymosin beta-4\n\nStudied for wound repair.");
    expect(read.data["verified_at"]).toBe(checked.data["verified_at"]);

    const revision = await callTool("get_revision", {
      page_id: created.data["id"],
      version: checked.data["version"],
    });
    expect(revision.data["verified"]).toBe(true);
    const first = await callTool("get_revision", {
      page_id: created.data["id"],
      version: created.data["version"],
    });
    expect(first.data).not.toHaveProperty("verified");
  });

  it("counts a page created with sources as verified, and says so in search hits only when set", async () => {
    const cited = await callTool("create_page", {
      title: "Selank",
      body: "An anxiolytic heptapeptide, sold as a nasal spray.",
      sources: [PAPER],
    });
    expect(cited.data["verified_at"]).toBe(cited.data["updated_at"]);
    await callTool("create_page", { title: "Semax", body: "A nootropic heptapeptide, also a nasal spray." });

    const found = await callTool("search", { query: "heptapeptide" });
    const pages = found.data["pages"] as Array<Record<string, unknown>>;
    expect(pages.find((page) => page["page_id"] === cited.data["id"])!["verified_at"]).toBe(cited.data["verified_at"]);
    expect(pages.find((page) => page["page_id"] !== cited.data["id"])).not.toHaveProperty("verified_at");
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
    const table = await callTool("create_table", {
      name: "Parts",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "grams", type: "number" },
      ],
      change_note: "A table for the parts",
    });
    const row = await callTool("upsert_row", {
      table_id: table.data["id"],
      values: { title: "Bracket", grams: 12 },
    });
    const updated = await callTool("upsert_row", {
      table_id: table.data["id"],
      row_id: row.data["id"],
      version: row.data["version"],
      values: { title: "Bracket", grams: 14 },
      change_note: "Weighed it after printing",
    });

    const history = await callTool("get_history", {
      table_id: table.data["id"],
      row_id: row.data["id"],
    });
    expect((history.data["revisions"] as unknown[]).length).toBe(2);

    const revision = await callTool("get_revision", {
      table_id: table.data["id"],
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

describe("agent navigation (ADR-058)", () => {
  it("lists immediate children only, title order, with a working cursor", async () => {
    const home = await callTool("create_page", { title: "Home", body: "x" });
    const homeId = home.data["id"] as string;
    const bravo = await callTool("create_page", { title: "Bravo", body: "x", parent_id: homeId });
    await callTool("create_page", { title: "Alpha", body: "x", parent_id: homeId });
    // A grandchild must not appear in Home's own listing.
    await callTool("create_page", { title: "Grandchild", body: "x", parent_id: bravo.data["id"] as string });

    const first = await callTool("list_children", { page_id: homeId, limit: 1 });
    expect((first.data["children"] as Array<Record<string, unknown>>).map((c) => c["title"])).toEqual(["Alpha"]);
    expect(first.data["cursor"]).toBeTruthy();

    const rest = await callTool("list_children", { page_id: homeId, cursor: first.data["cursor"] as string });
    const titles = (rest.data["children"] as Array<Record<string, unknown>>).map((c) => c["title"]);
    expect(titles).toEqual(["Bravo"]);
    expect((rest.data["children"] as Array<Record<string, unknown>>)[0]!["has_children"]).toBe(true);
  });

  it("agrees with cairn collections (REST GET /pages?parent=root) on the top-level pages (acceptance criterion 8)", async () => {
    await callTool("create_page", { title: "Root A", body: "x" });
    await callTool("create_page", { title: "Root B", body: "x" });
    const nested = await callTool("create_page", { title: "Root C", body: "x" });
    await callTool("create_page", { title: "Nested", body: "x", parent_id: nested.data["id"] as string });

    const viaTool = await callTool("list_children", {});
    const restResponse = await app.fetch(
      new Request("http://localhost/api/v1/pages?parent=root", {
        headers: { authorization: `Bearer ${TOKEN}`, "user-agent": "cairn-cli/0.1.0 (claude-code)" },
      }),
    );
    const viaRest = (await restResponse.json()) as { pages: Array<Record<string, unknown>> };

    const toolTitles = (viaTool.data["children"] as Array<Record<string, unknown>>).map((c) => c["title"]).sort();
    const restTitles = viaRest.pages.map((p) => p["title"]).sort();
    expect(toolTitles).toEqual(restTitles);
    expect(toolTitles).toEqual(["Root A", "Root B", "Root C"]);
  });

  it("reports a page's children, capped and counted (acceptance criterion 9)", async () => {
    const home = await callTool("create_page", { title: "Home", body: "x" });
    const homeId = home.data["id"] as string;
    for (let i = 0; i < 10; i++) {
      await callTool("create_page", { title: `Child ${String(i).padStart(2, "0")}`, body: "x", parent_id: homeId });
    }
    const page = await callTool("get_page", { page_id: homeId });
    expect((page.data["children"] as unknown[]).length).toBe(8);
    expect(page.data["more_children"]).toBe(2);
  });

  it("deletes a childless page, keeping its history reachable", async () => {
    const page = await callTool("create_page", { title: "Gone soon", body: "x" });
    const id = page.data["id"] as string;
    const deleted = await callTool("delete_page", { page_id: id, version: page.data["version"], change_note: "No longer needed" });
    expect(deleted.isError).toBe(false);
    expect(deleted.data["deleted"]).toBe(id);

    const revision = await callTool("get_revision", { page_id: id, version: page.data["version"] as string });
    expect(revision.isError).toBe(false);
  });

  it("refuses to delete a page with children, naming how many", async () => {
    const home = await callTool("create_page", { title: "Home", body: "x" });
    await callTool("create_page", { title: "Child", body: "x", parent_id: home.data["id"] as string });
    const result = await callTool("delete_page", {
      page_id: home.data["id"],
      version: home.data["version"],
      change_note: "Try to remove it anyway",
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.data)).toContain("1");
  });

  it("refuses to delete a page with a stale version", async () => {
    const page = await callTool("create_page", { title: "Stale target", body: "x" });
    await callTool("update_page", { page_id: page.data["id"], version: page.data["version"], mode: "replace_body", content: "y", change_note: "bump" });
    const result = await callTool("delete_page", {
      page_id: page.data["id"],
      version: page.data["version"],
      change_note: "Using the old version",
    });
    expect(result.isError).toBe(true);
    expect(result.data["error"]).toBe("version_conflict");
  });

  it("lists a deleted page, undeletes it with its history intact, and drops it from the list again (ADR-059)", async () => {
    const page = await callTool("create_page", { title: "Undelete me", body: "x" });
    const id = page.data["id"] as string;
    await callTool("delete_page", { page_id: id, version: page.data["version"], change_note: "Gone for now" });

    const listed = await callTool("list_deleted_pages");
    expect(listed.isError).toBe(false);
    const found = (listed.data["pages"] as Array<Record<string, unknown>>).find((p) => p["id"] === id);
    expect(found).toBeDefined();
    expect(found!["title"]).toBe("Undelete me");

    const undeleted = await callTool("undelete_page", { page_id: id, change_note: "Turns out we need it" });
    expect(undeleted.isError).toBe(false);

    const read = await callTool("get_page", { page_id: id });
    expect(read.isError).toBe(false);
    expect(read.data["title"]).toBe("Undelete me");

    const history = await callTool("get_history", { page_id: id });
    const notes = (history.data["revisions"] as Array<{ note: string }>).map((r) => r.note);
    expect(notes).toContain("Gone for now");

    const stillDeleted = await callTool("list_deleted_pages");
    expect((stillDeleted.data["pages"] as Array<Record<string, unknown>>).some((p) => p["id"] === id)).toBe(false);
  });

  it("lists pages in freshness order with list_stale_pages, never verified first (ADR-073)", async () => {
    const never = await callTool("create_page", { title: "Retatrutide notes", body: "Not yet checked." });
    const older = await callTool("create_page", { title: "Semaglutide notes", body: "Checked a while ago." });
    const newer = await callTool("create_page", { title: "Tirzepatide notes", body: "Checked recently." });

    const olderPage = await context.pages.get(context.workspaceId, older.data["id"] as string);
    await context.pages.update(
      context.workspaceId,
      older.data["id"] as string,
      { title: olderPage.title, body: olderPage.body, parentId: olderPage.parentId, tags: olderPage.tags, verifiedAt: "2020-01-01T00:00:00Z" },
      olderPage.version,
      { actor: { kind: "agent", id: "test", label: "test" }, note: "backdate for test" },
    );
    const newerPage = await context.pages.get(context.workspaceId, newer.data["id"] as string);
    await context.pages.update(
      context.workspaceId,
      newer.data["id"] as string,
      { title: newerPage.title, body: newerPage.body, parentId: newerPage.parentId, tags: newerPage.tags, verifiedAt: "2024-01-01T00:00:00Z" },
      newerPage.version,
      { actor: { kind: "agent", id: "test", label: "test" }, note: "backdate for test" },
    );

    const listed = await callTool("list_stale_pages");
    expect(listed.isError).toBe(false);
    const ids = (listed.data["pages"] as Array<Record<string, unknown>>).map((p) => p["id"]);
    expect(ids.indexOf(never.data["id"])).toBeLessThan(ids.indexOf(older.data["id"]));
    expect(ids.indexOf(older.data["id"])).toBeLessThan(ids.indexOf(newer.data["id"]));
    expect(listed.data["never_verified_count"]).toBeGreaterThanOrEqual(1);
    expect(listed.data["oldest_verified_at"]).toBe("2020-01-01T00:00:00.000Z");
    expect(listed.data["cursor"]).toBeDefined();
    expect(listed.data["truncated"]).toBeDefined();

    const firstPage = await callTool("list_stale_pages", { limit: 1 });
    expect((firstPage.data["pages"] as unknown[]).length).toBe(1);
    expect((firstPage.data["pages"] as Array<Record<string, unknown>>)[0]!["id"]).toBe(never.data["id"]);
    expect(firstPage.data["cursor"]).toBeTruthy();
  });

  it("lists, adds and removes per-collection synonyms, expanding search either way (ADR-077)", async () => {
    const collection = await callTool("create_page", { title: "Peptides", body: "Root." });
    const collectionId = collection.data["id"] as string;

    const empty = await callTool("list_synonyms", { collection_id: collectionId });
    expect(empty.isError).toBe(false);
    expect(empty.data["synonyms"]).toEqual([]);

    const added = await callTool("add_synonym", {
      collection_id: collectionId,
      term: "GLP-1",
      synonym: "glucagon-like peptide 1",
      change_note: "Common abbreviation",
    });
    expect(added.isError).toBe(false);
    const addedPair = added.data["synonym"] as Record<string, unknown>;
    expect(addedPair["term"]).toBe("glp-1");
    expect(addedPair["synonym"]).toBe("glucagon-like peptide 1");
    expect(addedPair["collection_id"]).toBe(collectionId);

    const listed = await callTool("list_synonyms", { collection_id: collectionId });
    expect((listed.data["synonyms"] as unknown[]).length).toBe(1);

    const onlySynonym = await callTool("create_page", {
      title: "Semaglutide",
      body: "A glucagon-like peptide 1 receptor agonist.",
    });
    await eventually(async () => {
      const found = await callTool("search", { query: "GLP-1" });
      expect(
        (found.data["pages"] as Array<Record<string, unknown>>).some((p) => p["page_id"] === onlySynonym.data["id"]),
      ).toBe(true);
    });

    const removed = await callTool("remove_synonym", {
      collection_id: collectionId,
      term: "GLP-1",
      synonym: "glucagon-like peptide 1",
    });
    expect(removed.isError).toBe(false);

    const afterRemove = await callTool("list_synonyms", { collection_id: collectionId });
    expect(afterRemove.data["synonyms"]).toEqual([]);
  });

  it("refuses undelete_page for a page that still exists, naming restore instead", async () => {
    const page = await callTool("create_page", { title: "Still here", body: "x" });
    const result = await callTool("undelete_page", { page_id: page.data["id"] as string });
    expect(result.isError).toBe(true);
    expect(result.data["error"]).toBe("not_deleted");
    expect(result.data["message"]).toContain("restore");
  });

  it("refuses undelete_page for an id with no deletion in its history, naming the fix", async () => {
    const result = await callTool("undelete_page", { page_id: "pg_never_existed" });
    expect(result.isError).toBe(true);
    expect(result.data["error"]).toBe("not_deleted");
    expect(result.data["message"]).toContain("cairn deleted");
  });

  it("vacuums a page's older revisions and compacts, refusing a stale version", async () => {
    const page = await callTool("create_page", { title: "Vacuum me", body: "x" });
    const updated = await callTool("update_page", {
      page_id: page.data["id"],
      version: page.data["version"],
      mode: "replace_body",
      content: "new body",
      change_note: "Rewrote it",
    });

    const stale = await callTool("vacuum_page", { page_id: page.data["id"] as string, version: page.data["version"] as string });
    expect(stale.isError).toBe(true);
    expect(stale.data["error"]).toBe("version_conflict");

    const vacuumed = await callTool("vacuum_page", { page_id: page.data["id"] as string, version: updated.data["version"] as string });
    expect(vacuumed.isError).toBe(false);
    expect(vacuumed.data["revisions_removed"]).toBe(1);

    const history = await callTool("get_history", { page_id: page.data["id"] as string });
    expect((history.data["revisions"] as unknown[]).length).toBe(1);
  });

  it("refuses create_table with no change note, naming the argument (acceptance criterion 12)", async () => {
    const { body } = await rpc("tools/call", {
      name: "create_table",
      arguments: { name: "No note", fields: [{ name: "title", type: "text" }] },
    });
    const result = body.result as { isError?: boolean; content?: Array<{ type: string; text: string }> };
    // Zod rejects the call before the handler runs, so the SDK returns a
    // protocol-level error rather than the tool's own JSON error body.
    expect(result.isError === true || body.error !== undefined).toBe(true);
    const message = result.isError ? result.content![0]!.text : JSON.stringify(body.error);
    expect(message).toContain("change_note");
  });

  it("updates a table's schema over MCP, keeping existing rows", async () => {
    const table = await callTool("create_table", {
      name: "Filaments",
      fields: [{ name: "material", type: "text", required: true }],
      change_note: "Track filament",
    });
    const row = await callTool("upsert_row", { table_id: table.data["id"], values: { material: "PLA" } });

    const updated = await callTool("update_table", {
      table_id: table.data["id"],
      version: table.data["version"],
      name: "Filaments",
      fields: [
        { name: "material", type: "select", required: true, options: ["PLA", "PETG", "TPU"] },
        { name: "grams", type: "number" },
      ],
      change_note: "Make material a pick list, track weight",
    });
    expect(updated.isError).toBe(false);
    expect((updated.data["fields"] as Array<Record<string, unknown>>).map((f) => f["name"])).toEqual([
      "material",
      "grams",
    ]);

    const stillThere = await callTool("query_table", { table_id: table.data["id"] });
    expect((stillThere.data["rows"] as Array<Record<string, unknown>>)[0]!["id"]).toBe(row.data["id"]);
  });

  it("reaches the changes feed over MCP, newest first", async () => {
    const a = await callTool("create_page", { title: "Feed A", body: "x" });
    await callTool("create_page", { title: "Feed B", body: "x" });

    const changes = await callTool("get_changes", { limit: 5 });
    expect(changes.isError).toBe(false);
    const items = changes.data["changes"] as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items[0]!["at"] >= items[items.length - 1]!["at"]).toBe(true);

    const since = await callTool("get_changes", { since: a.data["updated_at"] as string });
    expect(since.isError).toBe(false);
  });
});

describe("attachments (ADR-064)", () => {
  const SHA = "d".repeat(64);

  function fakeStore() {
    const blobs = new Map<string, Uint8Array>();
    return {
      async head(key: string) {
        const found = blobs.get(key);
        return found === undefined ? null : { bytes: found.length };
      },
      async uploadUrl(key: string) {
        return `https://blob.example/${key}?upload`;
      },
      async downloadUrl(key: string, _expires: number, filename: string) {
        return `https://blob.example/${key}?download&filename=${encodeURIComponent(filename)}`;
      },
      async put(key: string, bytes: Uint8Array) {
        blobs.set(key, bytes);
      },
      async get(key: string) {
        return blobs.get(key) ?? null;
      },
      land(key: string, bytes: number | Uint8Array) {
        blobs.set(key, typeof bytes === "number" ? new Uint8Array(bytes) : bytes);
      },
    };
  }

  /** A tiny real PNG, through the real codec (ADR-068), so a thumbnail actually generates. */
  async function tinyPng(): Promise<Uint8Array> {
    const width = 40;
    const height = 30;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 30;
      data[i + 1] = 90;
      data[i + 2] = 200;
      data[i + 3] = 255;
    }
    return new Uint8Array(await encodePng({ data, width, height }));
  }

  it("is refused with a clear error when this Cairn has no attachment storage configured", async () => {
    const created = await callTool("create_page", { title: "Print log", body: "x" });
    const attempt = await callTool("create_attachment", {
      page_id: created.data["id"],
      filename: "a.png",
      sha256: SHA,
      content_type: "image/png",
      bytes: 5,
    });
    expect(attempt.isError).toBe(true);
    expect(JSON.stringify(attempt.data)).toContain("CAIRN_ATTACHMENTS_TO");
  });

  it("starts, confirms, reads, lists and deletes an attachment with a realistic payload", async () => {
    const store = fakeStore();
    context.attachmentsStore = store;
    const page = await callTool("create_page", { title: "Wiring notes", body: "x" });
    const pageId = page.data["id"] as string;
    const png = await tinyPng();

    const created = await callTool("create_attachment", {
      page_id: pageId,
      filename: "esc-wiring.png",
      alt_text: "the ESC wiring diagram",
      sha256: SHA,
      content_type: "image/png",
      bytes: png.length,
    });
    expect(created.isError).toBe(false);
    expect(created.data["status"]).toBe("pending");
    expect(created.data["upload_url"]).toContain(`sha256/${SHA}`);
    const id = created.data["id"] as string;

    store.land(`sha256/${SHA}`, png);
    const confirmed = await callTool("confirm_attachment_upload", { attachment_id: id });
    expect(confirmed.isError).toBe(false);
    expect(confirmed.data["status"]).toBe("committed");

    const fetched = await callTool("get_attachment", { attachment_id: id });
    expect(fetched.data["download_url"]).toContain("esc-wiring.png");

    // Off the critical path (decision 6): poll for the thumbnail the way
    // every other derived field in this suite does (hard rule 11).
    const withThumbnail = await eventually(async () => {
      const again = await callTool("get_attachment", { attachment_id: id });
      if (again.data["thumbnail_url"] === null) throw new Error("thumbnail not generated yet");
      return again;
    });
    expect(withThumbnail.data["thumbnail_key"]).toBe(`sha256/${SHA}-thumb`);
    expect(withThumbnail.data["thumbnail_url"]).toContain(`sha256/${SHA}-thumb`);

    const listed = await callTool("list_attachments", { page_id: pageId });
    const attachments = listed.data["attachments"] as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!["filename"]).toBe("esc-wiring.png");

    // The thumbnail write above moved the row's version on; delete must use
    // the version as of the last read.
    const deleted = await callTool("delete_attachment", { attachment_id: id, version: withThumbnail.data["version"] as string });
    expect(deleted.isError).toBe(false);
    const afterDelete = await callTool("list_attachments", { page_id: pageId });
    expect(afterDelete.data["attachments"]).toEqual([]);
  });

  it("confirm reports a clear error when nothing was uploaded yet", async () => {
    context.attachmentsStore = fakeStore();
    const page = await callTool("create_page", { title: "Wiring notes", body: "x" });
    const created = await callTool("create_attachment", {
      page_id: page.data["id"],
      filename: "a.png",
      sha256: SHA,
      content_type: "image/png",
      bytes: 12,
    });
    const attempt = await callTool("confirm_attachment_upload", { attachment_id: created.data["id"] });
    expect(attempt.isError).toBe(true);
  });
});
