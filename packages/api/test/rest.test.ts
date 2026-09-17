import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { eventually } from "@cairn/core/testing";
import { createApp } from "../src/app.js";
import { createContext, type AppContext } from "../src/context.js";

/**
 * Contract tests for the REST API (ADR-013), with realistic payloads
 * (CLAUDE.md verification step 3). They drive the app through `app.fetch`,
 * the same web standard path every platform uses.
 */

const TOKEN = "test-token-0123456789abcdef";
const AGENT = "cairn-cli/0.1.0 (claude-code)";

let app: Hono;
let context: AppContext;

beforeEach(async () => {
  context = await createContext({ database: ":memory:", workspaceId: "ws_test" });
  app = createApp({ context, token: TOKEN });
});

interface Call {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  token?: string | null;
}

async function call(path: string, { method = "GET", body, headers = {}, token = TOKEN }: Call = {}) {
  const response = await app.fetch(
    new Request(`http://localhost/api/v1${path}`, {
      method,
      headers: {
        "user-agent": AGENT,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Markdown or an empty body.
  }
  return { status: response.status, headers: response.headers, json, text };
}

async function createBuildLog() {
  return call("/pages", {
    method: "POST",
    body: {
      title: "5 inch build log",
      body: "# 5 inch build log\n\n## Firmware\n\nFlashed old firmware on the ESC.\n\n## Motors\n\n2207 1750kv.",
      tags: ["fpv", "build"],
      change_note: "Started the log from the bench notes",
    },
  });
}

describe("health", () => {
  it("says whether semantic search is on (ADR-022)", async () => {
    const response = await app.fetch(new Request("http://localhost/health"));
    const json = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(json["semantic_search"]).toEqual({ vectors: "off", model: null, pending: 0, detail: null });
  });
});

describe("auth", () => {
  it("refuses a request with no token when local trust is off", async () => {
    const { status, json } = await call("/pages", { token: null });
    expect(status).toBe(401);
    expect(json["error"]).toBe("unauthorized");
  });

  it("lets a trusted local request in, and refuses a foreign Origin", async () => {
    app = createApp({ context, token: null, trust: { enabled: true, hosts: ["localhost"] } });
    expect((await call("/pages", { token: null })).status).toBe(200);
    const foreign = await call("/pages", { token: null, headers: { origin: "https://evil.example" } });
    expect(foreign.status).toBe(401);
  });

  it("is not caught by the console's sign-in", async () => {
    const { status, headers } = await call("/pages");
    expect(status).toBe(200);
    expect(headers.get("location")).toBeNull();
    expect(headers.get("content-type")).toContain("application/json");
  });
});

describe("pages", () => {
  it("creates a page, and returns its version as an ETag and its address", async () => {
    const created = await createBuildLog();
    expect(created.status).toBe(201);
    expect(created.headers.get("etag")).toBe(`"${String(created.json["version"])}"`);
    expect(created.headers.get("location")).toBe(`/api/v1/pages/${String(created.json["id"])}`);
    expect(created.json["updated_by"]).toEqual({ kind: "agent", name: AGENT });
  });

  it("reads a page as JSON, or as Markdown with a small header", async () => {
    const id = String((await createBuildLog()).json["id"]);
    const asJson = await call(`/pages/${id}`);
    expect(asJson.json["body"]).toContain("2207 1750kv");

    const asMarkdown = await call(`/pages/${id}?format=markdown`);
    expect(asMarkdown.headers.get("content-type")).toContain("text/markdown");
    expect(asMarkdown.text).toContain('title: "5 inch build log"');
    expect(asMarkdown.text).toContain("## Motors");
    expect(asMarkdown.headers.get("etag")).toBe(asJson.headers.get("etag"));
  });

  it("requires If-Match to edit, and refuses a wildcard", async () => {
    const id = String((await createBuildLog()).json["id"]);
    const missing = await call(`/pages/${id}`, { method: "PATCH", body: { content: "more" } });
    expect(missing.status).toBe(428);
    expect(missing.json["error"]).toBe("precondition_required");

    const wildcard = await call(`/pages/${id}`, {
      method: "PATCH",
      body: { content: "more" },
      headers: { "if-match": "*" },
    });
    expect(wildcard.status).toBe(400);
  });

  it("replaces one section and leaves the rest alone", async () => {
    const created = await createBuildLog();
    const id = String(created.json["id"]);
    const updated = await call(`/pages/${id}`, {
      method: "PATCH",
      headers: { "if-match": created.headers.get("etag")! },
      body: {
        mode: "replace_section",
        section: "Firmware",
        content: "BLHeli_32 32.9, flashed with the configurator.",
        change_note: "Recorded the firmware actually flashed",
      },
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get("etag")).not.toBe(created.headers.get("etag"));

    const body = String((await call(`/pages/${id}`)).json["body"]);
    expect(body).toContain("BLHeli_32");
    expect(body).not.toContain("old firmware");
    expect(body).toContain("2207 1750kv");
  });

  it("accepts a weak ETag in If-Match", async () => {
    const created = await createBuildLog();
    const updated = await call(`/pages/${String(created.json["id"])}`, {
      method: "PATCH",
      headers: { "if-match": `W/${created.headers.get("etag")!}` },
      body: { content: "Props: 5.1 inch tri-blade." },
    });
    expect(updated.status).toBe(200);
  });

  it("answers a stale version with 409 and the current content to merge", async () => {
    const created = await createBuildLog();
    const id = String(created.json["id"]);
    const stale = created.headers.get("etag")!;
    await call(`/pages/${id}`, {
      method: "PATCH",
      headers: { "if-match": stale },
      body: { content: "Someone else added this line." },
    });
    const conflict = await call(`/pages/${id}`, {
      method: "PATCH",
      headers: { "if-match": stale },
      body: { content: "My late edit." },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json["error"]).toBe("version_conflict");
    expect(JSON.stringify(conflict.json["current_content"])).toContain("Someone else");
    expect(conflict.json["message"]).toContain("If-Match");
  });

  it("names the missing section, and says when a heading is not there", async () => {
    const created = await createBuildLog();
    const id = String(created.json["id"]);
    const etag = created.headers.get("etag")!;
    const noSection = await call(`/pages/${id}`, {
      method: "PATCH",
      headers: { "if-match": etag },
      body: { mode: "replace_section", content: "x" },
    });
    expect(noSection.status).toBe(422);
    expect(noSection.json["fields"]).toEqual([{ field: "section", message: "required for replace_section" }]);

    const noHeading = await call(`/pages/${id}`, {
      method: "PATCH",
      headers: { "if-match": etag },
      body: { mode: "replace_section", section: "Battery", content: "x" },
    });
    expect(noHeading.status).toBe(404);
    expect(noHeading.json["message"]).toContain("Battery");
  });

  it("rejects malformed input with 400 before any domain rule runs", async () => {
    const badJson = await call("/pages", { method: "POST", body: "{not json" });
    expect(badJson.status).toBe(400);
    const badShape = await call("/pages", { method: "POST", body: { body: "no title" } });
    expect(badShape.status).toBe(400);
    expect(badShape.json["fields"]).toEqual([expect.objectContaining({ field: "title" })]);
    const badLimit = await call("/pages?limit=9999");
    expect(badLimit.status).toBe(400);
  });

  it("finds a page by search, eventually", async () => {
    await createBuildLog();
    const pages = await eventually(async () => {
      const { json } = await call("/search?q=firmware");
      const found = json["pages"] as Array<{ page_id: string }>;
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(pages[0]!.page_id).toMatch(/^pg_/);
    expect((await call("/search")).status).toBe(400);
  });

  it("names the query and suggests a next move when nothing matches (fault 6, console-and-search-polish)", async () => {
    const { json } = await call("/search?q=zzznosuchword");
    expect(json["pages"]).toEqual([]);
    expect(json["hint"]).toContain("zzznosuchword");
    expect(json["hint"]).toContain("synonym");
  });

  it("groups a page's matches together, capped at three passages, and never repeats a page (ADR-057, criteria 8, 9)", async () => {
    await call("/pages", {
      method: "POST",
      body: {
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
      },
    });

    const pages = await eventually(async () => {
      const { json } = await call("/search?q=zoetropic");
      const found = json["pages"] as Array<Record<string, unknown>>;
      expect(found.length).toBeGreaterThan(0);
      return found;
    });

    expect(pages).toHaveLength(1);
    const page = pages[0]!;
    const passages = page["passages"] as unknown[];
    expect(passages.length).toBeLessThanOrEqual(3);
    expect(page["more_passages"]).toBe(4 - passages.length);

    const ids = pages.map((p) => p["page_id"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns exactly as many pages as hold a topic, and says that is all there was (ADR-057, criterion 7)", async () => {
    for (const title of ["Alpha", "Beta", "Gamma"]) {
      await call("/pages", {
        method: "POST",
        body: { title, body: `# ${title}\n\nexactly3demoterm appears on this page.` },
      });
    }

    const pages = await eventually(async () => {
      const { json } = await call("/search?q=exactly3demoterm");
      const found = json["pages"] as unknown[];
      expect(found.length).toBeGreaterThan(0);
      return found;
    });

    expect(pages).toHaveLength(3);
    const { json } = await call("/search?q=exactly3demoterm");
    expect(json["truncated"]).toBe(false);
    expect(json["cursor"]).toBeNull();
  });

  it("keeps history, with a diff per version", async () => {
    const created = await createBuildLog();
    const id = String(created.json["id"]);
    const updated = await call(`/pages/${id}`, {
      method: "PATCH",
      headers: { "if-match": created.headers.get("etag")! },
      body: { mode: "replace_section", section: "Firmware", content: "BLHeli_32", change_note: "Firmware" },
    });
    const history = await call(`/pages/${id}/history`);
    const revisions = history.json["revisions"] as Array<{ version: string; note: string }>;
    expect(revisions.map((r) => r.note)).toEqual(["Firmware", "Started the log from the bench notes"]);

    const revision = await call(`/pages/${id}/revisions/${String(updated.json["version"])}`);
    expect(revision.json["diff"]).toContain("+ BLHeli_32");
    expect(revision.json["diff"]).toContain("- Flashed old firmware on the ESC.");
  });

  it("restores an old revision as a new one (ADR-045), rejecting a stale If-Match", async () => {
    const created = await createBuildLog();
    const id = String(created.json["id"]);
    const original = String(created.json["version"]);
    const updated = await call(`/pages/${id}`, {
      method: "PATCH",
      headers: { "if-match": created.headers.get("etag")! },
      body: { mode: "replace_section", section: "Firmware", content: "BLHeli_32", change_note: "Firmware" },
    });

    const stale = await call(`/pages/${id}/revisions/${original}/restore`, {
      method: "POST",
      headers: { "if-match": original },
      body: { change_note: "should fail" },
    });
    expect(stale.status).toBe(409);
    expect(stale.json["error"]).toBe("version_conflict");

    const restored = await call(`/pages/${id}/revisions/${original}/restore`, {
      method: "POST",
      headers: { "if-match": String(updated.json["version"]) },
      body: { change_note: "Back out the firmware change" },
    });
    expect(restored.status).toBe(200);
    const reread = await call(`/pages/${id}`);
    expect(reread.json["body"]).toContain("Flashed old firmware on the ESC.");
    expect(reread.json["body"]).not.toContain("BLHeli_32");

    const history = await call(`/pages/${id}/history`);
    const notes = (history.json["revisions"] as Array<{ note: string }>).map((r) => r.note);
    expect(notes[0]).toBe("Back out the firmware change");
  });

  it("deletes with If-Match, after which the page is gone", async () => {
    const created = await createBuildLog();
    const id = String(created.json["id"]);
    expect((await call(`/pages/${id}`, { method: "DELETE" })).status).toBe(428);
    const deleted = await call(`/pages/${id}`, {
      method: "DELETE",
      headers: { "if-match": created.headers.get("etag")! },
      body: { change_note: "Merged into the build index" },
    });
    expect(deleted.status).toBe(204);
    const gone = await call(`/pages/${id}`);
    expect(gone.status).toBe(404);
    expect(gone.json["error"]).toBe("not_found");
  });

  it("lists a deleted page, undeletes it with its history intact, and drops it from the list again (ADR-059)", async () => {
    const created = await createBuildLog();
    const id = String(created.json["id"]);
    await call(`/pages/${id}`, {
      method: "DELETE",
      headers: { "if-match": created.headers.get("etag")! },
      body: { change_note: "Merged into the build index" },
    });

    const neverDeleted = await call(`/pages/some-page-never-deleted/undelete`, { method: "POST" });
    expect(neverDeleted.status).toBe(422);
    expect(neverDeleted.json["error"]).toBe("not_deleted");

    const listed = await eventually(async () => {
      const { json } = await call("/pages/deleted");
      const found = (json["pages"] as Array<Record<string, unknown>>).find((p) => p["id"] === id);
      expect(found).toBeDefined();
      return found!;
    });
    expect(listed["deleted_by"]).toMatchObject({ kind: "agent" });

    const undeleted = await call(`/pages/${id}/undelete`, {
      method: "POST",
      body: { change_note: "Brought it back" },
    });
    expect(undeleted.status).toBe(201);
    const reread = await call(`/pages/${id}`);
    expect(reread.status).toBe(200);
    expect(reread.json["title"]).toBe("5 inch build log");

    const stillDeleted = await call("/pages/deleted");
    expect((stillDeleted.json["pages"] as Array<Record<string, unknown>>).some((p) => p["id"] === id)).toBe(false);

    const history = await call(`/pages/${id}/history`);
    const notes = (history.json["revisions"] as Array<{ note: string }>).map((r) => r.note);
    expect(notes).toContain("Merged into the build index");
    expect(notes).toContain("Started the log from the bench notes");
  });

  it("vacuums a page's older revisions, refusing a stale version (ADR-059)", async () => {
    const created = await createBuildLog();
    const id = String(created.json["id"]);
    const updated = await call(`/pages/${id}`, {
      method: "PATCH",
      headers: { "if-match": created.headers.get("etag")! },
      body: { mode: "replace_section", section: "Firmware", content: "BLHeli_32", change_note: "Firmware" },
    });

    const stale = await call(`/pages/${id}/vacuum`, {
      method: "POST",
      headers: { "if-match": String(created.json["version"]) },
    });
    expect(stale.status).toBe(409);
    expect(stale.json["error"]).toBe("version_conflict");

    const vacuumed = await call(`/pages/${id}/vacuum`, {
      method: "POST",
      headers: { "if-match": String(updated.json["version"]) },
    });
    expect(vacuumed.status).toBe(200);
    expect(vacuumed.json["revisions_removed"]).toBe(1);

    const history = await call(`/pages/${id}/history`);
    const revisions = history.json["revisions"] as unknown[];
    expect(revisions).toHaveLength(1);
  });
});

describe("publishing (ADR-032)", () => {
  it("publishes a page, and takes it down again, with its version each time", async () => {
    const created = await createBuildLog();
    const id = String(created.json["id"]);
    expect(created.json["public"]).toBe(false);

    const published = await call("/publish", {
      method: "POST",
      body: { id, public: true, version: created.json["version"], change_note: "Published" },
    });
    expect(published.status).toBe(200);
    expect(published.json["public"]).toBe(true);
    expect((await call(`/pages/${id}`)).json["public"]).toBe(true);

    const down = await call("/publish", {
      method: "POST",
      body: { id, public: false, version: published.json["version"], change_note: "Made private" },
    });
    expect(down.json["public"]).toBe(false);
  });

  it("refuses a stale version, so two people cannot publish past each other", async () => {
    const created = await createBuildLog();
    const id = String(created.json["id"]);
    const stale = String(created.json["version"]);
    await call(`/pages/${id}`, {
      method: "PATCH",
      body: { content: "more" },
      headers: { "if-match": `"${stale}"` },
    });
    const refused = await call("/publish", {
      method: "POST",
      body: { id, public: true, version: stale, change_note: "Published" },
    });
    expect(refused.status).toBe(409);
    expect(refused.json["error"]).toBe("version_conflict");
    expect((await call(`/pages/${id}`)).json["public"]).toBe(false);
  });

  it("answers 404 for a page that is not there", async () => {
    const missing = await call("/publish", {
      method: "POST",
      body: { id: "pg_missing", public: true, version: "v1", change_note: "Published" },
    });
    expect(missing.status).toBe(404);
  });

  it("does not publish through an ordinary write", async () => {
    const created = await createBuildLog();
    const id = String(created.json["id"]);
    await call(`/pages/${id}`, {
      method: "PUT",
      body: { title: "5 inch build log", body: "Rewritten.", public: true },
      headers: { "if-match": `"${String(created.json["version"])}"` },
    });
    expect((await call(`/pages/${id}`)).json["public"]).toBe(false);
  });
});

describe("tables in the tree and rows as links (ADR-024)", () => {
  it("creates a table under a page, moves it, and reports links from rows", async () => {
    const home = await call("/pages", { method: "POST", body: { title: "Peptides", body: "Hub.", change_note: "A home for the peptide tables" } });
    const homeId = String(home.json["id"]);
    const peptides = await call("/tables", {
      method: "POST",
      body: { name: "Peptides", parent_id: homeId, fields: [{ name: "name", type: "text", required: true }, { name: "page", type: "relation" }, { name: "related", type: "relation", target: "col_self_placeholder" }], change_note: "A table for the peptides" },
    });
    expect(peptides.status).toBe(422);
    expect(JSON.stringify(peptides.json)).toContain("related");

    const created = await call("/tables", {
      method: "POST",
      body: { name: "Peptides", parent_id: homeId, fields: [{ name: "name", type: "text", required: true }, { name: "page", type: "relation" }], change_note: "A table for the peptides" },
    });
    expect(created.status).toBe(201);
    expect(created.json["parent_id"]).toBe(homeId);
    const cid = String(created.json["id"]);

    const row = await call(`/tables/${cid}/rows/row_bpc`, { method: "PUT", body: { values: { name: "BPC-157", page: homeId }, change_note: "Linked to its page" } });
    expect(row.status).toBe(201);
    const links = await call(`/tables/${cid}/rows/row_bpc/links`);
    expect(links.json["outbound"]).toEqual([{ page_id: homeId, type: "relation", label: "page" }]);
    const backlinks = await call(`/pages/${homeId}/backlinks`);
    expect(backlinks.json["backlinks"]).toEqual([{ table_id: cid, row_id: "row_bpc", type: "relation", label: "page" }]);

    // A PUT that leaves out parent_id keeps the table where it is.
    const kept = await call(`/tables/${cid}`, {
      method: "PUT",
      headers: { "if-match": `"${String(created.json["version"])}"` },
      body: { name: "Peptides", fields: [{ name: "name", type: "text", required: true }, { name: "page", type: "relation" }], change_note: "No real change" },
    });
    expect(kept.json["parent_id"]).toBe(homeId);

    const moved = await call("/move", { method: "POST", body: { id: cid, parent_id: null, version: kept.json["version"], change_note: "Back to the top" } });
    expect(moved.status).toBe(200);
    expect(moved.json).toMatchObject({ kind: "table", parent_id: null });
  });

  it("will not move a page inside itself", async () => {
    const outer = await call("/pages", { method: "POST", body: { title: "Outer", body: "o" } });
    const inner = await call("/pages", { method: "POST", body: { title: "Inner", body: "i", parent_id: outer.json["id"] } });
    const result = await call("/move", { method: "POST", body: { id: outer.json["id"], parent_id: inner.json["id"], version: outer.json["version"] } });
    expect(result.status).toBe(422);
    expect(result.text).toContain("inside this one");
  });
});

describe("tables and rows", () => {
  async function createPrints() {
    const created = await call("/tables", {
      method: "POST",
      body: {
        name: "Prints",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "material", type: "select", options: ["PLA", "PETG", "TPU"] },
          { name: "grams", type: "number" },
          { name: "failed", type: "checkbox" },
        ],
        change_note: "A table for the prints",
      },
    });
    expect(created.status).toBe(201);
    return String(created.json["id"]);
  }

  it("creates rows, queries them, and names every bad field at once", async () => {
    const cid = await createPrints();
    for (const values of [
      { title: "Motor mount", material: "PETG", grams: 14, failed: false },
      { title: "Canopy", material: "TPU", grams: 22, failed: true },
      { title: "Antenna tube", material: "TPU", grams: 3, failed: false },
    ]) {
      expect((await call(`/tables/${cid}/rows`, { method: "POST", body: { values } })).status).toBe(201);
    }

    const tpu = await call(`/tables/${cid}/query`, {
      method: "POST",
      body: {
        where: [{ field: "material", op: "eq", value: "TPU" }],
        sort: [{ field: "grams", direction: "desc" }],
      },
    });
    const rows = tpu.json["rows"] as Array<{ values: Record<string, unknown> }>;
    expect(rows.map((row) => row.values["title"])).toEqual(["Canopy", "Antenna tube"]);

    const invalid = await call(`/tables/${cid}/rows`, {
      method: "POST",
      body: { values: { material: "Wood", grams: "heavy" } },
    });
    expect(invalid.status).toBe(422);
    const fields = (invalid.json["fields"] as Array<{ field: string }>).map((f) => f.field).sort();
    expect(fields).toEqual(["grams", "material", "title"]);
  });

  it("PUT creates at an id, conflicts without If-Match, and updates with it", async () => {
    const cid = await createPrints();
    const created = await call(`/tables/${cid}/rows/print_canopy`, {
      method: "PUT",
      body: { values: { title: "Canopy", grams: 22 } },
    });
    expect(created.status).toBe(201);

    const again = await call(`/tables/${cid}/rows/print_canopy`, {
      method: "PUT",
      body: { values: { title: "Canopy v2" } },
    });
    expect(again.status).toBe(409);

    const updated = await call(`/tables/${cid}/rows/print_canopy`, {
      method: "PUT",
      headers: { "if-match": created.headers.get("etag")! },
      body: { values: { title: "Canopy v2", grams: 19 }, change_note: "Thinner walls" },
    });
    expect(updated.status).toBe(200);

    const history = await call(`/tables/${cid}/rows/print_canopy/history`);
    const revisions = history.json["revisions"] as Array<{ version: string }>;
    expect(revisions).toHaveLength(2);
    const revision = await call(
      `/tables/${cid}/rows/print_canopy/revisions/${String(updated.json["version"])}`,
    );
    expect(revision.json["diff"]).toContain("+ grams: 19");

    const deleted = await call(`/tables/${cid}/rows/print_canopy`, {
      method: "DELETE",
      headers: { "if-match": updated.headers.get("etag")! },
    });
    expect(deleted.status).toBe(204);
  });
});

describe("the paths from before tables were called tables (ADR-026)", () => {
  it("answers under /collections as under /tables", async () => {
    const created = await call("/collections", { method: "POST", body: { name: "Old client", fields: [{ name: "title", type: "text" }], change_note: "A table via the old path" } });
    expect(created.status).toBe(201);
    const cid = String(created.json["id"]);
    expect((await call(`/collections/${cid}/rows`, { method: "POST", body: { values: { title: "Still works" } } })).status).toBe(201);

    const old = await call("/collections");
    expect((old.json["collections"] as Array<{ id: string }>).map((t) => t.id)).toContain(cid);
    const current = await call("/tables");
    expect((current.json["tables"] as Array<{ id: string }>).map((t) => t.id)).toContain(cid);
    const rows = await call(`/tables/${cid}/rows`);
    expect(JSON.stringify(rows.json)).toContain("Still works");
  });
});

describe("freshness (ADR-028)", () => {
  it("marks a page verified on PATCH, sets an exact time on PUT, and shows it everywhere", async () => {
    const created = await call("/pages", {
      method: "POST",
      body: { title: "Ipamorelin", body: "A growth hormone secretagogue." },
    });
    expect(created.json["verified_at"]).toBeNull();
    const id = String(created.json["id"]);
    expect((await call(`/pages/${id}?format=markdown`)).text).toContain("verified: never");

    const checked = await call(`/pages/${id}`, {
      method: "PATCH",
      headers: { "if-match": created.headers.get("etag")! },
      body: { content: "", verified: true, change_note: "Checked against the 2019 trial" },
    });
    expect(checked.status).toBe(200);
    expect(checked.json["verified_at"]).toBe(checked.json["updated_at"]);
    const revision = await call(`/pages/${id}/revisions/${String(checked.json["version"])}`);
    expect(revision.json["verified"]).toBe(true);
    expect((await call(`/pages/${id}?format=markdown`)).text).toContain(`verified: ${String(checked.json["verified_at"])}`);

    const pages = await eventually(async () => {
      const { json } = await call("/search?q=secretagogue");
      const found = json["pages"] as Array<Record<string, unknown>>;
      expect(found.length).toBeGreaterThan(0);
      return found;
    });
    expect(pages[0]!["verified_at"]).toBe(checked.json["verified_at"]);

    const kept = await call(`/pages/${id}`, {
      method: "PUT",
      headers: { "if-match": checked.headers.get("etag")! },
      body: { title: "Ipamorelin", body: "Edited, not re-checked." },
    });
    expect(kept.json["verified_at"]).toBe(checked.json["verified_at"]);

    const set = await call(`/pages/${id}`, {
      method: "PUT",
      headers: { "if-match": kept.headers.get("etag")! },
      body: { title: "Ipamorelin", body: "Edited, not re-checked.", verified_at: "2026-03-01T10:00:00Z" },
    });
    expect(set.json["verified_at"]).toBe("2026-03-01T10:00:00.000Z");
    const bad = await call(`/pages/${id}`, {
      method: "PUT",
      headers: { "if-match": set.headers.get("etag")! },
      body: { title: "Ipamorelin", body: "x", verified_at: "soon" },
    });
    expect(bad.status).toBe(422);
  });
});

describe("edit times (ADR-030)", () => {
  it("returns edited_at, takes an exact one on PUT, and gives revisions their parent", async () => {
    const parent = await call("/pages", { method: "POST", body: { title: "Peptides", body: "Hub." } });
    const created = await call("/pages", {
      method: "POST",
      body: { title: "Thymosin", body: "v1", parent_id: parent.json["id"] },
    });
    expect(Date.parse(String(created.json["edited_at"]))).not.toBeNaN();
    const id = String(created.json["id"]);

    const synced = await call(`/pages/${id}`, {
      method: "PUT",
      headers: { "if-match": created.headers.get("etag")! },
      body: { title: "Thymosin", body: "v2", parent_id: parent.json["id"], edited_at: "2026-09-14T08:00:00.123Z" },
    });
    expect(synced.status).toBe(200);
    // Before the page's own edit time, so moved just past it.
    expect(Date.parse(String(synced.json["edited_at"]))).toBeGreaterThan(Date.parse(String(created.json["edited_at"])));
    expect((await call(`/pages/${id}`)).json["edited_at"]).toBe(synced.json["edited_at"]);
    const exported = await call("/export/pages");
    const row = (exported.json["pages"] as Array<Record<string, unknown>>).find((page) => page["id"] === id);
    expect(row?.["edited_at"]).toBe(synced.json["edited_at"]);

    const revision = await call(`/pages/${id}/revisions/${String(created.json["version"])}`);
    expect(revision.json["parent_id"]).toBe(parent.json["id"]);

    const bad = await call(`/pages/${id}`, {
      method: "PUT",
      headers: { "if-match": synced.headers.get("etag")! },
      body: { title: "Thymosin", body: "v3", edited_at: "soon" },
    });
    expect(bad.status).toBe(422);
  });

  it("takes an exact edit time for a row, with the whole row only", async () => {
    const table = await call("/tables", { method: "POST", body: { name: "Doses", fields: [{ name: "name", type: "text" }], change_note: "A table for doses" } });
    const cid = String(table.json["id"]);
    const put = await call(`/tables/${cid}/rows/row_1`, {
      method: "PUT",
      body: { values: { name: "BPC-157" }, sources: [], edited_at: "2026-09-01T10:00:00Z" },
    });
    expect(put.status).toBe(201);
    expect(put.json["edited_at"]).toBe("2026-09-01T10:00:00.000Z");
    expect((await call(`/tables/${cid}/rows/row_1`)).json["edited_at"]).toBe("2026-09-01T10:00:00.000Z");
    const listed = await call(`/tables/${cid}/rows`);
    expect((listed.json["rows"] as Array<Record<string, unknown>>)[0]!["edited_at"]).toBe("2026-09-01T10:00:00.000Z");

    const mixed = await call(`/tables/${cid}/rows/row_1`, {
      method: "PUT",
      headers: { "if-match": put.headers.get("etag")! },
      body: { values: { name: "BPC-157" }, add_sources: ["Smith 2021"], edited_at: "2026-09-02T10:00:00Z" },
    });
    expect(mixed.status).toBe(400);
  });
});

describe("sources (ADR-027)", () => {
  const PAPER = "https://pubmed.ncbi.nlm.nih.gov/12345/";
  const CITE = "Smith 2021, J Pept Sci";

  it("creates a page with sources, adds to them on PATCH, and replaces them on PUT", async () => {
    const created = await call("/pages", {
      method: "POST",
      body: { title: "BPC-157", body: "# BPC-157\n\nA gastric peptide.", sources: [PAPER] },
    });
    expect(created.status).toBe(201);
    expect(created.json["sources"]).toEqual([PAPER]);
    const id = String(created.json["id"]);

    const patched = await call(`/pages/${id}`, {
      method: "PATCH",
      headers: { "if-match": created.headers.get("etag")! },
      body: { content: "", sources: [CITE, PAPER], change_note: "Cited the review" },
    });
    expect(patched.status).toBe(200);
    expect(patched.json["sources"]).toEqual([PAPER, CITE]);
    expect((await call(`/pages/${id}`)).json["body"]).toBe("# BPC-157\n\nA gastric peptide.");

    const revision = await call(`/pages/${id}/revisions/${String(patched.json["version"])}`);
    expect(revision.json["sources_added"]).toEqual([CITE]);
    expect(revision.json["sources_removed"]).toBeUndefined();

    const markdown = await call(`/pages/${id}?format=markdown`);
    expect(markdown.text).toContain(`sources: ${JSON.stringify([PAPER, CITE])}`);

    const kept = await call(`/pages/${id}`, {
      method: "PUT",
      headers: { "if-match": patched.headers.get("etag")! },
      body: { title: "BPC 157", body: "Retitled." },
    });
    expect(kept.json["sources"]).toEqual([PAPER, CITE]);

    const replaced = await call(`/pages/${id}`, {
      method: "PUT",
      headers: { "if-match": kept.headers.get("etag")! },
      body: { title: "BPC 157", body: "Retitled.", sources: [CITE] },
    });
    expect(replaced.json["sources"]).toEqual([CITE]);
    const dropped = await call(`/pages/${id}/revisions/${String(replaced.json["version"])}`);
    expect(dropped.json["sources_removed"]).toEqual([PAPER]);
  });

  it("refuses a source too long to be a citation", async () => {
    const response = await call("/pages", {
      method: "POST",
      body: { title: "Quote", body: "", sources: ["x".repeat(501)] },
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.json)).toContain("cite it, do not quote it");
  });

  it("replaces a row's sources with sources, adds with add_sources, and refuses both", async () => {
    const table = await call("/tables", {
      method: "POST",
      body: { name: "Peptides", fields: [{ name: "name", type: "text", required: true }], change_note: "A table for the peptides" },
    });
    const cid = String(table.json["id"]);
    const created = await call(`/tables/${cid}/rows`, {
      method: "POST",
      body: { values: { name: "BPC-157" }, sources: [PAPER] },
    });
    expect(created.json["sources"]).toEqual([PAPER]);
    const rid = String(created.json["id"]);

    const added = await call(`/tables/${cid}/rows/${rid}`, {
      method: "PUT",
      headers: { "if-match": created.headers.get("etag")! },
      body: { values: { name: "BPC-157" }, add_sources: [CITE] },
    });
    expect(added.status).toBe(200);
    expect(added.json["sources"]).toEqual([PAPER, CITE]);

    const both = await call(`/tables/${cid}/rows/${rid}`, {
      method: "PUT",
      headers: { "if-match": added.headers.get("etag")! },
      body: { values: { name: "BPC-157" }, sources: [], add_sources: [CITE] },
    });
    expect(both.status).toBe(400);

    const cleared = await call(`/tables/${cid}/rows/${rid}`, {
      method: "PUT",
      headers: { "if-match": added.headers.get("etag")! },
      body: { values: { name: "BPC-157" }, sources: [] },
    });
    expect(cleared.json["sources"]).toEqual([]);
    const revision = await call(`/tables/${cid}/rows/${rid}/revisions/${String(cleared.json["version"])}`);
    expect(revision.json["sources_removed"]).toEqual([PAPER, CITE]);
  });
});

describe("changes feed", () => {
  it("lists changes newest first, filters by actor, and stops at since", async () => {
    const first = await createBuildLog();
    const firstAt = String(first.json["updated_at"]);
    // Owner write through the service, to show the actor filter.
    await context.pages.create(context.workspaceId, { title: "Owner note", body: "x" }, {
      actor: { kind: "user", id: "owner", label: "Owner" },
      note: "Written in the console",
    });
    await call("/pages", { method: "POST", body: { title: "Second agent page", change_note: "Later" } });

    const all = await eventually(async () => {
      const { json } = await call("/changes");
      const changes = json["changes"] as Array<Record<string, unknown>>;
      expect(changes).toHaveLength(3);
      return json;
    });
    const changes = all["changes"] as Array<Record<string, unknown>>;
    // Newest first. Writes in the same millisecond have no defined order, so
    // check the times never increase rather than naming the first title.
    const times = changes.map((change) => Date.parse(String(change["at"])));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(changes.map((change) => change["title"]).sort()).toEqual(
      ["5 inch build log", "Owner note", "Second agent page"],
    );
    const second = changes.find((change) => change["title"] === "Second agent page")!;
    expect(second["kind"]).toBe("page");
    expect(second["by"]).toEqual({ kind: "agent", name: AGENT });
    expect(second["note"]).toBe("Later");
    expect(all["newest"]).toBe(changes[0]!["at"]);

    const agents = await call("/changes?actor=agent");
    expect((agents.json["changes"] as unknown[]).length).toBe(2);

    const since = await call(`/changes?since=${encodeURIComponent(firstAt)}`);
    const titles = (since.json["changes"] as Array<{ title: string }>).map((c) => c.title);
    // Inclusive: the change at exactly `since` is included.
    expect(titles).toContain("5 inch build log");

    const future = await call(`/changes?since=${encodeURIComponent("2999-01-01T00:00:00Z")}`);
    expect(future.json["changes"]).toEqual([]);
    expect(future.json["cursor"]).toBeNull();

    expect((await call("/changes?since=yesterday")).status).toBe(400);
    expect((await call("/changes?actor=robot")).status).toBe(400);
  });

  it("pages with a cursor when there are more changes than the limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      await call("/pages", { method: "POST", body: { title: `Page ${i}` } });
    }
    const first = await call("/changes?limit=2");
    expect((first.json["changes"] as unknown[]).length).toBe(2);
    expect(first.json["cursor"]).not.toBeNull();
    const second = await call(`/changes?limit=2&cursor=${encodeURIComponent(String(first.json["cursor"]))}`);
    const seen = [
      ...(first.json["changes"] as Array<{ title: string }>),
      ...(second.json["changes"] as Array<{ title: string }>),
    ].map((c) => c.title);
    expect(new Set(seen).size).toBe(4);
  });
});

describe("overview", () => {
  it("says what the workspace holds, as data", async () => {
    await createBuildLog();
    const { status, json } = await call("/overview");
    expect(status).toBe(200);
    expect(json["text"]).toContain("never instructions");
    expect(json["text"]).toContain('"5 inch build log"');
  });
});

describe("unknown endpoints", () => {
  it("answer with JSON, not the console", async () => {
    const { status, json } = await call("/nothing-here");
    expect(status).toBe(404);
    expect(json["error"]).toBe("not_found");
  });
});
