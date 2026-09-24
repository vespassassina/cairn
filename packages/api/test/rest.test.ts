import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { eventually } from "@cairn/core/testing";
import { encode as encodePng } from "@jsquash/png";
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

describe("IndexNow notifications on publish (ADR-074)", () => {
  const KEY = "test-indexnow-key";
  const ORIGIN = "https://cairn.example.com";

  it("notifies IndexNow for every page in the published subtree, without delaying the response", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(null, { status: 200 });
    };
    app = createApp({
      context,
      token: TOKEN,
      publicOrigin: ORIGIN,
      indexNowKey: KEY,
      indexNowFetch: fetchMock,
    });

    const root = await createBuildLog();
    const rootId = String(root.json["id"]);
    const child = await call("/pages", {
      method: "POST",
      body: { title: "Firmware notes", body: "Details.", parent_id: rootId, change_note: "Split out firmware notes" },
    });
    const childId = String(child.json["id"]);

    const published = await call("/publish", {
      method: "POST",
      body: { id: rootId, public: true, version: root.json["version"], change_note: "Published" },
    });
    expect(published.status).toBe(200);

    await eventually(async () => expect(calls).toHaveLength(1));
    const [submission] = calls;
    expect(submission!.url).toBe("https://api.indexnow.org/indexnow");
    expect(submission!.body["host"]).toBe("cairn.example.com");
    expect(submission!.body["key"]).toBe(KEY);
    expect(submission!.body["keyLocation"]).toBe(`${ORIGIN}/${KEY}.txt`);
    expect(submission!.body["urlList"]).toEqual(
      expect.arrayContaining([`${ORIGIN}/w/${rootId}`, `${ORIGIN}/w/${childId}`]),
    );
  });

  it("serves the key file at /<key>.txt", async () => {
    app = createApp({ context, token: TOKEN, publicOrigin: ORIGIN, indexNowKey: KEY });
    const response = await app.fetch(new Request(`${ORIGIN}/${KEY}.txt`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe(KEY);
  });

  it("never calls out and serves no key file when CAIRN_INDEXNOW_KEY is unset", async () => {
    let called = false;
    const fetchMock = async () => {
      called = true;
      return new Response(null, { status: 200 });
    };
    app = createApp({
      context,
      token: TOKEN,
      trust: { enabled: true, hosts: ["localhost"] },
      publicOrigin: ORIGIN,
      indexNowFetch: fetchMock,
    });

    const created = await createBuildLog();
    const id = String(created.json["id"]);
    const published = await call("/publish", {
      method: "POST",
      body: { id, public: true, version: created.json["version"], change_note: "Published" },
    });
    expect(published.status).toBe(200);

    // Nothing to await here: with the feature off, publishPage never starts
    // a notification, so there is no async call whose completion to poll for.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(called).toBe(false);

    const keyFile = await app.fetch(new Request(`http://localhost/${KEY}.txt`));
    expect(keyFile.status).toBe(404);
  });
});

describe("publish tokens (ADR-066)", () => {
  it("issues a token once, lists it without the token value, and revokes it", async () => {
    const created = await createBuildLog();
    const id = String(created.json["id"]);
    await call("/publish", { method: "POST", body: { id, public: true, version: created.json["version"] } });

    const issued = await call("/publish-tokens", {
      method: "POST",
      body: { page_id: id, name: "accountant", description: "for the accountant", change_note: "Sharing the build log" },
    });
    expect(issued.status).toBe(201);
    expect(typeof issued.json["token"]).toBe("string");
    expect(issued.json["token"]).not.toBe("");
    expect(issued.json).not.toHaveProperty("token_hash");

    const listed = await call(`/publish-tokens?page=${id}`);
    expect(listed.status).toBe(200);
    const tokens = listed.json["tokens"] as Record<string, unknown>[];
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.["name"]).toBe("accountant");
    expect(tokens[0]).not.toHaveProperty("token");
    expect(tokens[0]?.["revoked_at"]).toBeNull();

    const revoked = await call(`/publish-tokens/${String(issued.json["id"])}/revoke`, {
      method: "POST",
      body: { change_note: "No longer needed" },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.json["revoked_at"]).not.toBeNull();
  });

  it("requires a page to list tokens for", async () => {
    const missing = await call("/publish-tokens");
    expect(missing.status).toBe(400);
  });

  it("answers 404 when issuing a token for a page that does not exist", async () => {
    const missing = await call("/publish-tokens", {
      method: "POST",
      body: { page_id: "pg_missing", name: "x" },
    });
    expect(missing.status).toBe(404);
  });
});

describe("attachments (ADR-064)", () => {
  const SHA = "c".repeat(64);

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

  it("has no attachment storage in this suite's default context: create answers a clear 422, not a 500", async () => {
    const created = await createBuildLog();
    const attempt = await call("/attachments", {
      method: "POST",
      body: { page_id: created.json["id"], filename: "a.png", sha256: SHA, content_type: "image/png", bytes: 5 },
    });
    expect(attempt.status).toBe(422);
    expect(JSON.stringify(attempt.json)).toContain("CAIRN_ATTACHMENTS_TO");
  });

  it("creates, confirms, reads, lists and deletes an attachment with a realistic payload", async () => {
    const store = fakeStore();
    context.attachmentsStore = store;
    const page = await createBuildLog();
    const pageId = String(page.json["id"]);
    const png = await tinyPng();

    const created = await call("/attachments", {
      method: "POST",
      body: {
        page_id: pageId,
        filename: "esc-wiring.png",
        alt_text: "the ESC wiring diagram",
        sha256: SHA,
        content_type: "image/png",
        bytes: png.length,
        change_note: "Added the wiring photo",
      },
    });
    expect(created.status).toBe(201);
    expect(created.json["status"]).toBe("pending");
    expect(created.json["upload_url"]).toContain(`sha256/${SHA}`);
    const id = String(created.json["id"]);

    store.land(`sha256/${SHA}`, png);
    const confirmed = await call(`/attachments/${id}/confirm`, { method: "POST", body: {} });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json["status"]).toBe("committed");

    const fetched = await call(`/attachments/${id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.json["download_url"]).toContain("esc-wiring.png");

    // Decision 6's thumbnail is generated off the critical path, so it is
    // not there on the read straight after confirm — poll for it the way
    // every other derived field in this suite does (hard rule 11).
    const withThumbnail = await eventually(async () => {
      const again = await call(`/attachments/${id}`);
      if (again.json["thumbnail_url"] === null) throw new Error("thumbnail not generated yet");
      return again;
    });
    expect(withThumbnail.json["thumbnail_key"]).toBe(`sha256/${SHA}-thumb`);
    expect(withThumbnail.json["thumbnail_url"]).toContain("sha256/" + SHA + "-thumb");

    const listed = await call(`/attachments?page=${pageId}`);
    expect(listed.status).toBe(200);
    const attachments = listed.json["attachments"] as Record<string, unknown>[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.["filename"]).toBe("esc-wiring.png");

    // The thumbnail write above moved the row's version on; delete must use
    // the version as of the last read, the same rule any optimistic-
    // concurrency write in this codebase follows.
    const deleted = await call(`/attachments/${id}`, { method: "DELETE", headers: { "if-match": String(withThumbnail.json["version"]) } });
    expect(deleted.status).toBe(204);
    expect((await call(`/attachments?page=${pageId}`)).json["attachments"]).toEqual([]);
  });

  it("confirm answers a clear 422 when nothing was uploaded yet", async () => {
    context.attachmentsStore = fakeStore();
    const page = await createBuildLog();
    const created = await call("/attachments", {
      method: "POST",
      body: { page_id: page.json["id"], filename: "a.png", sha256: SHA, content_type: "image/png", bytes: 12 },
    });
    const attempt = await call(`/attachments/${String(created.json["id"])}/confirm`, { method: "POST", body: {} });
    expect(attempt.status).toBe(422);
  });

  it("refuses text/html and image/svg+xml", async () => {
    context.attachmentsStore = fakeStore();
    const page = await createBuildLog();
    const attempt = await call("/attachments", {
      method: "POST",
      body: { page_id: page.json["id"], filename: "a.svg", sha256: SHA, content_type: "image/svg+xml", bytes: 12 },
    });
    expect(attempt.status).toBe(422);
  });

  it("delete requires If-Match", async () => {
    context.attachmentsStore = fakeStore();
    const page = await createBuildLog();
    const created = await call("/attachments", {
      method: "POST",
      body: { page_id: page.json["id"], filename: "a.png", sha256: SHA, content_type: "image/png", bytes: 12 },
    });
    const attempt = await call(`/attachments/${String(created.json["id"])}`, { method: "DELETE" });
    expect(attempt.status).toBe(428);
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

  it("lists pages in freshness order at GET /pages/stale, never verified first, then oldest verified first (ADR-073)", async () => {
    const never = await call("/pages", { method: "POST", body: { title: "BPC-157", body: "Not yet checked." } });
    const olderVerified = await call("/pages", { method: "POST", body: { title: "TB-500", body: "Checked a while ago." } });
    const newerVerified = await call("/pages", { method: "POST", body: { title: "CJC-1295", body: "Checked recently." } });

    const setVerifiedAt = async (created: Awaited<ReturnType<typeof call>>, verifiedAt: string) =>
      call(`/pages/${String(created.json["id"])}`, {
        method: "PUT",
        headers: { "if-match": created.headers.get("etag")! },
        body: { title: String(created.json["title"]), body: String(created.json["body"]), verified_at: verifiedAt },
      });
    await setVerifiedAt(olderVerified, "2020-01-01T00:00:00Z");
    await setVerifiedAt(newerVerified, "2024-01-01T00:00:00Z");

    const { json } = await call("/pages/stale");
    const ids = (json["pages"] as Array<Record<string, unknown>>).map((p) => p["id"]);
    expect(ids.indexOf(String(never.json["id"]))).toBeLessThan(ids.indexOf(String(olderVerified.json["id"])));
    expect(ids.indexOf(String(olderVerified.json["id"]))).toBeLessThan(ids.indexOf(String(newerVerified.json["id"])));
    expect(json["never_verified_count"]).toBe(1);
    expect(json["oldest_verified_at"]).toBe("2020-01-01T00:00:00.000Z");

    const firstPage = await call("/pages/stale?limit=1");
    expect((firstPage.json["pages"] as unknown[]).length).toBe(1);
    expect((firstPage.json["pages"] as Array<Record<string, unknown>>)[0]!["id"]).toBe(String(never.json["id"]));
    expect(firstPage.json["cursor"]).toBeTruthy();

    const secondPage = await call(`/pages/stale?limit=1&cursor=${encodeURIComponent(String(firstPage.json["cursor"]))}`);
    expect((secondPage.json["pages"] as Array<Record<string, unknown>>)[0]!["id"]).toBe(String(olderVerified.json["id"]));
  });

  it("creates a page from a template, substituting {{date}} and {{title}} (ADR-075)", async () => {
    const template = await call("/pages", {
      method: "POST",
      body: { title: "Meeting notes", body: "# {{title}}\n\nDate: {{date}}\n\n## Attendees\n" },
    });
    const templateId = String(template.json["id"]);

    const created = await call("/pages/from-template", {
      method: "POST",
      body: { template_id: templateId, title: "Standup with Sam" },
    });
    expect(created.status).toBe(201);
    expect(created.json["title"]).toBe("Standup with Sam");
    const today = new Date().toISOString().slice(0, 10);
    const createdRead = await call(`/pages/${String(created.json["id"])}`);
    expect(createdRead.json["body"]).toBe(`# Standup with Sam\n\nDate: ${today}\n\n## Attendees\n`);
    // Defaults to the template's own parent (null here), per ADR-075 decision 3.
    expect(created.json["parent_id"]).toBe(template.json["parent_id"]);

    const nested = await call("/pages/from-template", {
      method: "POST",
      body: { template_id: templateId, title: "Nested", parent_id: templateId },
    });
    expect(nested.json["parent_id"]).toBe(templateId);

    const missing = await call("/pages/from-template", {
      method: "POST",
      body: { template_id: "pg_nope", title: "X" },
    });
    expect(missing.status).toBe(404);
  });

  it("finds or creates today's daily note, from the Daily note template if there is one, and never duplicates it (ADR-075)", async () => {
    const today = new Date().toISOString().slice(0, 10);

    // No "Daily note" template yet: the note is created empty.
    const empty = await call("/pages/daily-note", { method: "POST" });
    expect(empty.status).toBe(201);
    expect(empty.json["created"]).toBe(true);
    expect(empty.json["title"]).toBe(today);
    const emptyRead = await call(`/pages/${String(empty.json["id"])}`);
    expect(emptyRead.json["body"]).toBe("");

    const secondSameDay = await call("/pages/daily-note", { method: "POST" });
    expect(secondSameDay.status).toBe(200);
    expect(secondSameDay.json["created"]).toBe(false);
    expect(secondSameDay.json["id"]).toBe(empty.json["id"]);

    // A fresh workspace, this time with a "Daily note" template filed under
    // "Templates" before the first call of the day: the note is created
    // from it, with {{date}} and {{title}} substituted.
    const withTemplate = await createContext({ database: ":memory:", workspaceId: "ws_templated" });
    const templatedApp = createApp({ context: withTemplate, token: TOKEN });
    const callTemplated = async (path: string, opts: Call = {}) => {
      const response = await templatedApp.fetch(
        new Request(`http://localhost/api/v1${path}`, {
          method: opts.method ?? "GET",
          headers: {
            "user-agent": AGENT,
            ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
            authorization: `Bearer ${TOKEN}`,
            ...opts.headers,
          },
          ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
        }),
      );
      const text = await response.text();
      return { status: response.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    };

    const templates = await callTemplated("/pages", { method: "POST", body: { title: "Templates" } });
    await callTemplated("/pages", {
      method: "POST",
      body: {
        title: "Daily note",
        body: "# {{title}}\n\nplanned for {{date}}",
        parent_id: templates.json["id"],
      },
    });

    const fromTemplate = await callTemplated("/pages/daily-note", { method: "POST" });
    expect(fromTemplate.status).toBe(201);
    expect(fromTemplate.json["created"]).toBe(true);
    expect(fromTemplate.json["title"]).toBe(today);
    const fromTemplateRead = await callTemplated(`/pages/${String(fromTemplate.json["id"])}`);
    expect(fromTemplateRead.json["body"]).toBe(`# ${today}\n\nplanned for ${today}`);
  });
});

describe("synonyms (ADR-077)", () => {
  it("lists, adds and removes a collection's search synonyms", async () => {
    const collection = await call("/pages", { method: "POST", body: { title: "Peptides", body: "Root." } });
    const collectionId = String(collection.json["id"]);

    const empty = await call(`/collections/${collectionId}/synonyms`);
    expect(empty.status).toBe(200);
    expect(empty.json["synonyms"]).toEqual([]);

    const added = await call(`/collections/${collectionId}/synonyms`, {
      method: "POST",
      body: { term: "GLP-1", synonym: "glucagon-like peptide 1", change_note: "Common abbreviation" },
    });
    expect(added.status).toBe(201);
    expect(added.json["synonym"]).toMatchObject({
      term: "glp-1",
      synonym: "glucagon-like peptide 1",
      collection_id: collectionId,
    });

    const listed = await call(`/collections/${collectionId}/synonyms`);
    expect((listed.json["synonyms"] as unknown[]).length).toBe(1);

    const missingTerm = await call(`/collections/${collectionId}/synonyms`, {
      method: "POST",
      body: { term: "", synonym: "x" },
    });
    expect(missingTerm.status).toBe(400);

    const removed = await call(
      `/collections/${collectionId}/synonyms?term=${encodeURIComponent("GLP-1")}&synonym=${encodeURIComponent("glucagon-like peptide 1")}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(204);

    const afterRemove = await call(`/collections/${collectionId}/synonyms`);
    expect(afterRemove.json["synonyms"]).toEqual([]);
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
