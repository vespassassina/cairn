import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/app.js";
import { createContext, OWNER, type AppContext } from "../src/context.js";

/**
 * Review console tests (ADR-009). Driven through `app.fetch`, like the MCP
 * contract tests, so they exercise the real request path.
 *
 * The security cases matter most: agents write page content, so the console
 * must render hostile content inert and refuse forms from anywhere else.
 */

const TOKEN = "test-token-0123456789abcdef";
const ORIGIN = "http://localhost";
const AGENT = {
  actor: { kind: "agent" as const, id: "mcp:dev", label: "claude-code/2.0.0" },
  note: "Summarised the adhesion failures",
};

let app: Hono;
let context: AppContext;
let cookie: string;

async function signIn(): Promise<string> {
  const response = await app.fetch(
    new Request(`${ORIGIN}/login`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: TOKEN, next: "/" }),
    }),
  );
  const set = response.headers.get("set-cookie") ?? "";
  return set.split(";")[0]!;
}

async function get(path: string) {
  const response = await app.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie } }));
  return { status: response.status, headers: response.headers, html: await response.text() };
}

async function post(path: string, fields: Record<string, string | string[]>, origin = ORIGIN) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) body.append(key, entry);
  }
  const response = await app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        cookie,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    }),
  );
  return {
    status: response.status,
    location: response.headers.get("location"),
    html: await response.text(),
  };
}

beforeEach(async () => {
  context = await createContext({
    database: ":memory:",
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    workspaceId: "ws_console",
  });
  app = createApp({ context, token: TOKEN });
  cookie = await signIn();
});

describe("sign-in and request safety", () => {
  it("sends a visitor without a session to sign in", async () => {
    const response = await app.fetch(new Request(`${ORIGIN}/pages`));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login?next=%2Fpages");
  });

  it("rejects a wrong token", async () => {
    const response = await app.fetch(
      new Request(`${ORIGIN}/login`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: "wrong-token-aaaaaaaaaaaa" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("sets an HttpOnly, SameSite=Strict cookie that is not the token itself", async () => {
    const response = await app.fetch(
      new Request(`${ORIGIN}/login`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: TOKEN }),
      }),
    );
    const set = response.headers.get("set-cookie") ?? "";
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(set).not.toContain(TOKEN);
  });

  it("refuses a form post from another origin", async () => {
    const page = await context.pages.create(context.workspaceId, { title: "P", body: "x" }, {
      actor: OWNER,
    });
    const result = await post(
      `/p/${page.id}/edit`,
      { title: "P", body: "defaced", version: page.version },
      "https://evil.example",
    );
    expect(result.status).toBe(403);
    expect((await context.pages.get(context.workspaceId, page.id)).body).toBe("x");
  });

  it("never redirects to another site after sign-in", async () => {
    const response = await app.fetch(
      new Request(`${ORIGIN}/login`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: TOKEN, next: "//evil.example/" }),
      }),
    );
    expect(response.headers.get("location")).toBe("/");
  });

  it("sends a strict Content-Security-Policy with every console page", async () => {
    const { headers } = await get("/");
    const csp = headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("leaves MCP behind its own bearer check, not the console sign-in", async () => {
    const response = await app.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
  });

  it("serves artifactkit and Cairn styles as one stylesheet", async () => {
    const response = await app.fetch(new Request(`${ORIGIN}/assets/console.css`));
    const css = await response.text();
    expect(response.headers.get("content-type")).toContain("text/css");
    expect(css).toContain("ak-theme-start");
    expect(css).toContain(".cairn-diff");
  });

  it("serves the tab icon without sign-in, and links it from every page", async () => {
    const icon = await app.fetch(new Request(`${ORIGIN}/assets/favicon.svg`));
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(await icon.text()).toContain("<svg");

    const ico = await app.fetch(new Request(`${ORIGIN}/favicon.ico`));
    expect(ico.status).toBe(301);
    expect(ico.headers.get("location")).toBe("/assets/favicon.svg");

    const login = await app.fetch(new Request(`${ORIGIN}/login`));
    expect(await login.text()).toContain('rel="icon" href="/assets/favicon.svg"');
    expect((await get("/pages")).html).toContain('rel="icon" href="/assets/favicon.svg"');
  });

  it("gives every page a full head, named Cairn for home screens and bookmarks", async () => {
    const pages = [await (await app.fetch(new Request(`${ORIGIN}/login`))).text(), (await get("/")).html, (await get("/pages")).html];
    for (const html of pages) {
      expect(html.startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain('<meta name="viewport"');
      expect(html).toContain('<meta name="description"');
      expect(html).toContain('<meta name="application-name" content="Cairn">');
      expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Cairn">');
      expect(html).toContain('<link rel="apple-touch-icon" href="/assets/icon-180.png">');
      expect(html).toContain('<link rel="manifest" href="/assets/manifest.webmanifest">');
    }
    expect(pages[0]).toContain("<title>Sign in · Cairn</title>");
    expect(pages[1]).toContain("<title>Cairn</title>");
    expect(pages[2]).toContain("<title>Pages · Cairn</title>");

    const png = await app.fetch(new Request(`${ORIGIN}/assets/icon-180.png`));
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(Array.from(new Uint8Array(await png.arrayBuffer()).slice(1, 4), (b) => String.fromCharCode(b)).join("")).toBe("PNG");
    const manifest = await (await app.fetch(new Request(`${ORIGIN}/assets/manifest.webmanifest`))).json();
    expect(manifest).toMatchObject({ name: "Cairn", short_name: "Cairn", start_url: "/" });
  });

  it("answers an unknown address with a page, not bare text", async () => {
    const { status, html } = await get("/no-such-place");
    expect(status).toBe(404);
    expect(html).toContain("<title>Not found · Cairn</title>");
    expect(html).toContain("That address does not exist");
    const api = await app.fetch(new Request(`${ORIGIN}/api/v1/no-such-endpoint`, { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(api.headers.get("content-type")).toContain("application/json");
  });
});

describe("rendering untrusted page content", () => {
  it("shows raw HTML as text instead of running it", async () => {
    const page = await context.pages.create(
      context.workspaceId,
      { title: "Injected", body: 'Hello <script>alert("x")</script> <img src=x onerror=alert(1)>' },
      AGENT,
    );
    const { html } = await get(`/p/${page.id}`);
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  it("drops javascript: and data: links", async () => {
    const page = await context.pages.create(
      context.workspaceId,
      { title: "Links", body: "[a](javascript:alert(1)) [b](data:text/html,x) [c](https://ok.example)" },
      AGENT,
    );
    const { html } = await get(`/p/${page.id}`);
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('href="data:');
    expect(html).toContain('href="https://ok.example"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it("resolves wiki links to titles and marks links to missing pages", async () => {
    const target = await context.pages.create(
      context.workspaceId,
      { title: "BPC-157", body: "x" },
      { actor: OWNER },
      "pg_bpc",
    );
    const page = await context.pages.create(
      context.workspaceId,
      { title: "Stack", body: "Use [[pg_bpc]] with [[pg_missing|TB-500]]. `[[pg_code]]`" },
      { actor: OWNER },
    );
    const { html } = await get(`/p/${page.id}`);
    expect(html).toContain(`<a href="/p/${target.id}">BPC-157</a>`);
    expect(html).toMatch(/<a href="\/p\/pg_missing" class="cairn-missing"[^>]*>TB-500<\/a>/);
    expect(html).toContain("<code>[[pg_code]]</code>");
  });

  it("escapes search snippets, marking only the matches", async () => {
    await context.pages.create(
      context.workspaceId,
      { title: "Snip", body: "adhesion <b>bold</b> problems" },
      { actor: OWNER },
    );
    const { html } = await get("/search?q=adhesion");
    expect(html).toContain("<mark>adhesion</mark>");
    expect(html).not.toContain("<b>bold</b>");
  });
});

describe("reviewing and editing", () => {
  it("lists agent changes with their notes, and filters to agents", async () => {
    await context.pages.create(context.workspaceId, { title: "By agent", body: "x" }, AGENT);
    await context.pages.create(context.workspaceId, { title: "By owner", body: "y" }, {
      actor: OWNER,
    });

    const all = await get("/");
    expect(all.html).toContain("By agent");
    expect(all.html).toContain("By owner");
    expect(all.html).toContain("Summarised the adhesion failures");

    const agents = await get("/?who=agent");
    expect(agents.html).toContain("By agent");
    expect(agents.html).not.toContain("By owner");
  });

  it("renders a page in read mode with backlinks and who changed it last", async () => {
    const hub = await context.pages.create(context.workspaceId, { title: "Hub", body: "hub" }, {
      actor: OWNER,
    });
    await context.pages.create(
      context.workspaceId,
      { title: "Spoke", body: `see [[${hub.id}]]` },
      AGENT,
    );
    const { status, html } = await get(`/p/${hub.id}`);
    expect(status).toBe(200);
    expect(html).toContain("Linked from");
    expect(html).toContain(">Spoke</a>");
    expect(html).toContain("person");
    expect(html).toContain(`href="/p/${hub.id}/edit"`);
  });

  it("saves an edit with a version check, as the owner, with a note", async () => {
    const page = await context.pages.create(context.workspaceId, { title: "Log", body: "one" }, AGENT);
    const result = await post(`/p/${page.id}/edit`, {
      title: "Log",
      body: "one\r\ntwo",
      tags: "printing, #h2s",
      version: page.version,
      note: "Added the second print",
    });
    expect(result.status).toBe(303);
    expect(result.location).toBe(`/p/${page.id}?saved=1`);

    const saved = await context.pages.get(context.workspaceId, page.id);
    expect(saved.body).toBe("one\ntwo");
    expect(saved.tags).toEqual(["printing", "h2s"]);
    expect(saved.updatedBy.kind).toBe("user");
    const [latest] = await context.pages.history(context.workspaceId, page.id);
    expect(latest!.note).toBe("Added the second print");
  });

  it("keeps the owner's text and shows the difference when an agent saved first", async () => {
    const page = await context.pages.create(context.workspaceId, { title: "Shared", body: "base" }, {
      actor: OWNER,
    });
    await context.pages.update(
      context.workspaceId,
      page.id,
      { title: "Shared", body: "agent version" },
      page.version,
      AGENT,
    );

    const result = await post(`/p/${page.id}/edit`, {
      title: "Shared",
      body: "my version",
      version: page.version,
    });
    expect(result.status).toBe(409);
    expect(result.html).toContain("changed while you were editing");
    expect(result.html).toContain("my version");
    expect(result.html).toContain("- agent version");
    expect(result.html).toContain("+ my version");
    expect((await context.pages.get(context.workspaceId, page.id)).body).toBe("agent version");
  });

  it("previews without saving", async () => {
    const page = await context.pages.create(context.workspaceId, { title: "P", body: "saved" }, {
      actor: OWNER,
    });
    const result = await post(`/p/${page.id}/edit?preview=1`, {
      title: "P",
      body: "**draft**",
      version: page.version,
    });
    expect(result.status).toBe(200);
    expect(result.html).toContain("<strong>draft</strong>");
    expect((await context.pages.get(context.workspaceId, page.id)).body).toBe("saved");
  });

  it("shows history, a diff per version, and restores one", async () => {
    const page = await context.pages.create(
      context.workspaceId,
      { title: "ESC", body: "firmware: old" },
      { actor: OWNER },
    );
    const vandalised = await context.pages.update(
      context.workspaceId,
      page.id,
      { title: "ESC", body: "firmware: wrong" },
      page.version,
      AGENT,
    );

    const history = await get(`/p/${page.id}/history`);
    expect(history.html).toContain("Summarised the adhesion failures");
    expect(history.html).toContain("current");

    const revision = await get(`/p/${page.id}/v/${vandalised.version}`);
    expect(revision.html).toContain("- firmware: old");
    expect(revision.html).toContain("+ firmware: wrong");

    const restore = await post(`/p/${page.id}/restore/${page.version}`, {
      expected: vandalised.version,
    });
    expect(restore.status).toBe(303);
    expect((await context.pages.get(context.workspaceId, page.id)).body).toBe("firmware: old");
    expect(await context.pages.history(context.workspaceId, page.id)).toHaveLength(3);
  });

  it("creates a page under a parent", async () => {
    const parent = await context.pages.create(context.workspaceId, { title: "Parent", body: "" }, {
      actor: OWNER,
    });
    const result = await post("/new", { title: "Child", body: "hello", parent: parent.id });
    expect(result.status).toBe(303);
    const id = decodeURIComponent(result.location!.split("/p/")[1]!.split("?")[0]!);
    const child = await context.pages.get(context.workspaceId, id);
    expect(child.parentId).toBe(parent.id);
    expect(child.updatedBy.kind).toBe("user");
  });

  it("refuses a page with no title and keeps what was typed", async () => {
    const result = await post("/new", { title: "", body: "keep me" });
    expect(result.status).toBe(400);
    expect(result.html).toContain("keep me");
  });
});

describe("collections", () => {
  beforeEach(async () => {
    await context.collections.create(
      context.workspaceId,
      {
        name: "Peptides",
        fields: [
          { name: "name", type: "text", required: true },
          { name: "categories", type: "multi_select", options: ["fat-loss", "recovery"] },
          { name: "side_effects", type: "number" },
          { name: "approved", type: "checkbox" },
        ],
      },
      { actor: OWNER },
      "col_peptides",
    );
    await context.collections.upsertRow(
      context.workspaceId,
      "col_peptides",
      { values: { name: "Semaglutide", categories: ["fat-loss"], side_effects: 4, approved: true } },
      AGENT,
      { id: "row_sema" },
    );
  });

  it("shows rows in a sortable table", async () => {
    const { html } = await get("/c/col_peptides");
    expect(html).toContain("data-ak-table");
    expect(html).toContain('data-sort="n"');
    expect(html).toContain("Semaglutide");
  });

  it("edits a row through a form built from the schema", async () => {
    const row = await context.store.getRow(context.workspaceId, "col_peptides", "row_sema");
    const result = await post("/c/col_peptides/r/row_sema", {
      name: "Semaglutide",
      categories: ["fat-loss", "recovery"],
      side_effects: "5",
      version: row!.version,
      note: "Added nausea from the new trial",
    });
    expect(result.status).toBe(303);
    const saved = await context.store.getRow(context.workspaceId, "col_peptides", "row_sema");
    expect(saved!.values).toEqual({
      name: "Semaglutide",
      categories: ["fat-loss", "recovery"],
      side_effects: 5,
      approved: false,
    });
  });

  it("names invalid fields and keeps the input", async () => {
    const row = await context.store.getRow(context.workspaceId, "col_peptides", "row_sema");
    const result = await post("/c/col_peptides/r/row_sema", {
      name: "",
      side_effects: "lots",
      version: row!.version,
    });
    expect(result.status).toBe(400);
    expect(result.html).toContain("Not saved.");
    expect(result.html).toContain("required");
    expect(result.html).toContain("expected a number");
    expect(result.html).toContain('value="lots"');
  });

  it("shows row history with the agent's note, and restores a version", async () => {
    const first = await context.store.getRow(context.workspaceId, "col_peptides", "row_sema");
    await context.collections.upsertRow(
      context.workspaceId,
      "col_peptides",
      { values: { name: "Semaglutide", side_effects: 9 } },
      AGENT,
      { id: "row_sema", expectedVersion: first!.version },
    );
    const current = await context.store.getRow(context.workspaceId, "col_peptides", "row_sema");

    const page = await get("/c/col_peptides/r/row_sema");
    expect(page.html).toContain("Summarised the adhesion failures");

    const revision = await get(`/c/col_peptides/r/row_sema/v/${current!.version}`);
    expect(revision.html).toContain("+ side_effects: 9");

    const restore = await post(`/c/col_peptides/r/row_sema/restore/${first!.version}`, {
      expected: current!.version,
    });
    expect(restore.status).toBe(303);
    const restored = await context.store.getRow(context.workspaceId, "col_peptides", "row_sema");
    expect(restored!.values["side_effects"]).toBe(4);
  });
});

describe("collections in the tree and rows as links (ADR-024)", () => {
  beforeEach(async () => {
    const ws = context.workspaceId;
    await context.pages.create(ws, { title: "Peptides", body: "See [[col_stacks/row_wolverine]] and [[col_stacks]]." }, { actor: OWNER }, "pg_home");
    await context.pages.create(ws, { title: "BPC-157", body: "Healing." }, { actor: OWNER }, "pg_bpc");
    await context.collections.create(ws, { name: "Peptides", fields: [{ name: "name", type: "text", required: true }, { name: "page", type: "relation" }] }, { actor: OWNER }, "col_peptides");
    await context.collections.create(
      ws,
      { name: "Stacks", parentId: "pg_home", fields: [{ name: "title", type: "text", required: true }, { name: "components", type: "relation", target: "col_peptides", multiple: true }] },
      { actor: OWNER },
      "col_stacks",
    );
    await context.collections.upsertRow(ws, "col_peptides", { values: { name: "BPC-157", page: "pg_bpc" } }, AGENT, { id: "row_bpc" });
    await context.collections.upsertRow(ws, "col_stacks", { values: { title: "Wolverine", components: ["row_bpc"] } }, AGENT, { id: "row_wolverine" });
  });

  it("shows a collection under its page in the tree and the page's rail", async () => {
    const { html } = await get("/p/pg_home");
    expect(html).toContain('href="/c/col_stacks"');
    expect(html).toContain("Collections here");
    // The wiki links to a row and a collection resolve to them, named.
    expect(html).toContain('href="/c/col_stacks/r/row_wolverine"');
    expect(html).toContain("Stacks: Wolverine");
  });

  it("names linked rows in the table, and shows what links to a row", async () => {
    const table = await get("/c/col_stacks");
    expect(table.html).toContain('href="/c/col_peptides/r/row_bpc"');
    expect(table.html).toContain(">BPC-157</a>");

    const row = await get("/c/col_peptides/r/row_bpc");
    expect(row.html).toContain("Linked from");
    expect(row.html).toContain('href="/c/col_stacks/r/row_wolverine"');
    expect(row.html).toContain("(components)");
    expect(row.html).toContain('href="/p/pg_bpc"');

    const page = await get("/p/pg_bpc");
    expect(page.html).toContain("Peptides: BPC-157");
  });

  it("moves a collection from its page, keeping its rows", async () => {
    const collection = await context.collections.get(context.workspaceId, "col_peptides");
    const moved = await post("/c/col_peptides/move", { parent: "pg_home", version: collection.version, note: "Group the tables" });
    expect(moved.status).toBe(303);
    expect((await context.collections.get(context.workspaceId, "col_peptides")).parentId).toBe("pg_home");
    expect((await get("/c/col_peptides?moved=1")).html).toContain("Moved under Peptides.");
    expect((await context.collections.queryRows(context.workspaceId, "col_peptides")).items).toHaveLength(1);
  });

  it("reads a list of row ids from a relation field in the form", async () => {
    const row = await context.collections.getRow(context.workspaceId, "col_stacks", "row_wolverine");
    const saved = await post("/c/col_stacks/r/row_wolverine", { title: "Wolverine", components: "row_bpc, row_tb", version: row.version, note: "" });
    expect(saved.status).toBe(303);
    expect((await context.collections.getRow(context.workspaceId, "col_stacks", "row_wolverine")).values["components"]).toEqual(["row_bpc", "row_tb"]);
  });
});
