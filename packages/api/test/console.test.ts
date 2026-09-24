import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/app.js";
import { createContext, OWNER, type AppContext } from "../src/context.js";
import { addSynonym } from "../src/operations.js";
import { eventually } from "@cairn/core/testing";

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
    expect((await get("/t")).html).toContain('rel="icon" href="/assets/favicon.svg"');
  });

  it("gives every page a full head, named Cairn for home screens and bookmarks", async () => {
    const pages = [await (await app.fetch(new Request(`${ORIGIN}/login`))).text(), (await get("/")).html, (await get("/t")).html];
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
    expect(pages[2]).toContain("<title>Tables · Cairn</title>");

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

  it("lists a page once with its passages, and expands synonyms, like the other surfaces (hard rule 14)", async () => {
    const root = await context.pages.create(
      context.workspaceId,
      { title: "Homelab", body: "The lab." },
      { actor: OWNER },
      "pg_lab_root",
    );
    await context.pages.create(
      context.workspaceId,
      {
        title: "Coordinator stalls",
        parentId: root.id,
        body: "# Fault\n\nThe zigbee coordinator stalls.\n\n# Recovery\n\nRestart the zigbee coordinator.\n\n# Power\n\nThe zigbee coordinator draws little.",
      },
      { actor: OWNER },
    );
    await addSynonym(context, root.id, "zigbee", "z2m", { actor: OWNER });

    const grouped = await get("/search?q=zigbee+coordinator");
    expect(grouped.html.match(/class="cairn-hit"/g)).toHaveLength(1);
    expect(grouped.html).toContain("Recovery");

    const expanded = await get("/search?q=z2m+coordinator");
    expect(expanded.html).toContain("Coordinator stalls");
  });

  it("names the query and suggests a next move when nothing matches (fault 6, console-and-search-polish)", async () => {
    const { html } = await get("/search?q=zzznosuchword");
    expect(html).toContain("zzznosuchword");
    expect(html).toContain("synonym");
  });
});

describe("reviewing and editing", () => {
  it("lists agent changes with their notes, and filters to agents", async () => {
    await context.pages.create(context.workspaceId, { title: "By agent", body: "x" }, AGENT);
    await context.pages.create(context.workspaceId, { title: "By owner", body: "y" }, {
      actor: OWNER,
    });

    const all = await get("/changes");
    expect(all.html).toContain("By agent");
    expect(all.html).toContain("By owner");
    expect(all.html).toContain("Summarised the adhesion failures");

    const agents = await get("/changes?who=agent");
    expect(agents.html).toContain("By agent");
    expect(agents.html).not.toContain("By owner");
  });

  it("filters to sync conflicts, combinable with the actor filter (ADR-070)", async () => {
    await context.pages.create(context.workspaceId, { title: "Plain edit", body: "x" }, {
      actor: OWNER,
      note: "Just an edit",
    });
    await context.pages.create(context.workspaceId, { title: "Conflict by owner", body: "y" }, {
      actor: OWNER,
      note: "Synced from http://elsewhere. Sync conflict: this was the newer edit; the one it replaced is in this record's history",
    });
    await context.pages.create(context.workspaceId, { title: "Conflict by agent", body: "z" }, {
      actor: AGENT.actor,
      note: "Merged in sync with http://elsewhere. Sync conflict: 2 parts changed on both kept the newer edit, this server's edit; the version this replaced is in this record's history",
    });

    const conflicts = await get("/changes?conflict=1");
    expect(conflicts.html).toContain("Conflict by owner");
    expect(conflicts.html).toContain("Conflict by agent");
    expect(conflicts.html).not.toContain("Plain edit");
    expect(conflicts.html).toMatch(/aria-pressed="true">\s*Sync conflicts/);

    const both = await get("/changes?conflict=1&who=agent");
    expect(both.html).toContain("Conflict by agent");
    expect(both.html).not.toContain("Conflict by owner");
    expect(both.html).not.toContain("Plain edit");
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
    // The first revision was created with no note; the history says so rather
    // than leaving a blank (fault 3, console-and-search-polish).
    expect(history.html).toContain("no note given");

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

  it("starts a new page under the page being read", async () => {
    const parent = await context.pages.create(context.workspaceId, { title: "Peptides", body: "" }, {
      actor: OWNER,
    });

    const page = await get(`/p/${parent.id}`);
    expect(page.html).toContain(`href="/new?parent=${parent.id}"`);

    const form = await get(`/new?parent=${parent.id}`);
    expect(form.html).toContain(`<option value="${parent.id}" selected="">Peptides</option>`);
    expect(form.html).toContain("the page you came from");
  });

  it("starts at the top level, and says so, when the parent is gone", async () => {
    const form = await get("/new?parent=pg_gone");
    expect(form.html).toContain("does not exist, so this one starts at the top level");
    expect(form.html).not.toContain("selected=");
    expect(form.html).toContain('<option value="">None (top level)</option>');
  });

  it("refuses a page with no title and keeps what was typed", async () => {
    const result = await post("/new", { title: "", body: "keep me" });
    expect(result.status).toBe(400);
    expect(result.html).toContain("keep me");
  });
});

describe("tables", () => {
  beforeEach(async () => {
    await context.tables.create(
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
    await context.tables.upsertRow(
      context.workspaceId,
      "col_peptides",
      { values: { name: "Semaglutide", categories: ["fat-loss"], side_effects: 4, approved: true } },
      AGENT,
      { id: "row_sema" },
    );
  });

  it("shows rows in a sortable table", async () => {
    const { html } = await get("/t/col_peptides");
    expect(html).toContain("data-ak-table");
    expect(html).toContain('data-sort="n"');
    expect(html).toContain("Semaglutide");
  });

  it("edits a row through a form built from the schema", async () => {
    const row = await context.store.getRow(context.workspaceId, "col_peptides", "row_sema");
    const result = await post("/t/col_peptides/r/row_sema", {
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
    const result = await post("/t/col_peptides/r/row_sema", {
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
    await context.tables.upsertRow(
      context.workspaceId,
      "col_peptides",
      { values: { name: "Semaglutide", side_effects: 9 } },
      AGENT,
      { id: "row_sema", expectedVersion: first!.version },
    );
    const current = await context.store.getRow(context.workspaceId, "col_peptides", "row_sema");

    const page = await get("/t/col_peptides/r/row_sema");
    expect(page.html).toContain("Summarised the adhesion failures");

    const revision = await get(`/t/col_peptides/r/row_sema/v/${current!.version}`);
    expect(revision.html).toContain("+ side_effects: 9");

    const restore = await post(`/t/col_peptides/r/row_sema/restore/${first!.version}`, {
      expected: current!.version,
    });
    expect(restore.status).toBe(303);
    const restored = await context.store.getRow(context.workspaceId, "col_peptides", "row_sema");
    expect(restored!.values["side_effects"]).toBe(4);
  });
});

describe("tables in the tree and rows as links (ADR-024)", () => {
  beforeEach(async () => {
    const ws = context.workspaceId;
    await context.pages.create(ws, { title: "Peptides", body: "See [[col_stacks/row_wolverine]] and [[col_stacks]]." }, { actor: OWNER }, "pg_home");
    await context.pages.create(ws, { title: "BPC-157", body: "Healing." }, { actor: OWNER }, "pg_bpc");
    await context.tables.create(ws, { name: "Peptides", fields: [{ name: "name", type: "text", required: true }, { name: "page", type: "relation" }] }, { actor: OWNER }, "col_peptides");
    await context.tables.create(
      ws,
      { name: "Stacks", parentId: "pg_home", fields: [{ name: "title", type: "text", required: true }, { name: "components", type: "relation", target: "col_peptides", multiple: true }] },
      { actor: OWNER },
      "col_stacks",
    );
    await context.tables.upsertRow(ws, "col_peptides", { values: { name: "BPC-157", page: "pg_bpc" } }, AGENT, { id: "row_bpc" });
    await context.tables.upsertRow(ws, "col_stacks", { values: { title: "Wolverine", components: ["row_bpc"] } }, AGENT, { id: "row_wolverine" });
  });

  it("shows a table under its page in the tree and inside the page", async () => {
    const { html } = await get("/p/pg_home");
    expect(html).toContain('href="/t/col_stacks"');
    expect(html).toContain('aria-label="Tables in this page"');
    expect(html).toContain("1 rows · title, components");
    expect(html).not.toContain("Collections here");
    // The wiki links to a row and a table resolve to them, named.
    expect(html).toContain('href="/t/col_stacks/r/row_wolverine"');
    expect(html).toContain("Stacks: Wolverine");
  });

  it("names linked rows in the table, and shows what links to a row", async () => {
    const table = await get("/t/col_stacks");
    expect(table.html).toContain('href="/t/col_peptides/r/row_bpc"');
    expect(table.html).toContain(">BPC-157</a>");

    const row = await get("/t/col_peptides/r/row_bpc");
    expect(row.html).toContain("Linked from");
    expect(row.html).toContain('href="/t/col_stacks/r/row_wolverine"');
    expect(row.html).toContain("(components)");
    expect(row.html).toContain('href="/p/pg_bpc"');

    const page = await get("/p/pg_bpc");
    expect(page.html).toContain("Peptides: BPC-157");
  });

  it("moves a table from its page, keeping its rows", async () => {
    const table = await context.tables.get(context.workspaceId, "col_peptides");
    const moved = await post("/t/col_peptides/move", { parent: "pg_home", version: table.version, note: "Group the tables" });
    expect(moved.status).toBe(303);
    expect((await context.tables.get(context.workspaceId, "col_peptides")).parentId).toBe("pg_home");
    expect((await get("/t/col_peptides?moved=1")).html).toContain("Moved under Peptides.");
    expect((await context.tables.queryRows(context.workspaceId, "col_peptides")).items).toHaveLength(1);
  });

  it("reads a list of row ids from a relation field in the form", async () => {
    const row = await context.tables.getRow(context.workspaceId, "col_stacks", "row_wolverine");
    const saved = await post("/t/col_stacks/r/row_wolverine", { title: "Wolverine", components: "row_bpc, row_tb", version: row.version, note: "" });
    expect(saved.status).toBe(303);
    expect((await context.tables.getRow(context.workspaceId, "col_stacks", "row_wolverine")).values["components"]).toEqual(["row_bpc", "row_tb"]);
  });

  it("puts a table under a page from the page itself", async () => {
    const peptides = await context.tables.get(context.workspaceId, "col_peptides");
    const page = await get("/p/pg_home");
    expect(page.html).toContain("Put a table here");
    expect(page.html).toContain(`value="col_peptides@${peptides.version}"`);
    const moved = await post("/p/pg_home/tables", { table: `col_peptides@${peptides.version}`, note: "Both tables in one place" });
    expect(moved.status).toBe(303);
    expect((await context.tables.get(context.workspaceId, "col_peptides")).parentId).toBe("pg_home");

    const stale = await post("/p/pg_bpc/tables", { table: `col_peptides@${peptides.version}` });
    expect(stale.status).toBe(409);
  });

  it("groups the tables page under each root page", async () => {
    const { html } = await get("/t");
    const underHome = html.indexOf('<a href="/p/pg_home">Peptides</a>');
    const loose = html.indexOf("Not in any collection");
    expect(underHome).toBeGreaterThan(-1);
    expect(loose).toBeGreaterThan(underHome);
    expect(html.indexOf('href="/t/col_stacks"')).toBeGreaterThan(underHome);
    expect(html.indexOf('href="/t/col_stacks"')).toBeLessThan(loose);
    expect(html.indexOf('href="/t/col_peptides"')).toBeGreaterThan(loose);
  });
});

describe("sources (ADR-027)", () => {
  const PAPER = "https://pubmed.ncbi.nlm.nih.gov/12345/";
  const CITE = "Smith 2021, J Pept Sci";

  it("shows a page's sources, with web addresses as links and the rest as text", async () => {
    const page = await context.pages.create(
      context.workspaceId,
      { title: "BPC-157", body: "A gastric peptide.", sources: [PAPER, CITE, "javascript:alert(1)"] },
      AGENT,
    );
    const { html } = await get(`/p/${page.id}`);
    expect(html).toContain("Sources");
    expect(html).toContain(`<a href="${PAPER}" rel="noopener noreferrer nofollow">`);
    expect(html).toContain(`<li>${CITE}</li>`);
    // Not a web address, so never a link.
    expect(html).not.toContain('href="javascript:');
  });

  it("edits a page's sources one per line, and shows the change in history", async () => {
    const page = await context.pages.create(
      context.workspaceId,
      { title: "BPC-157", body: "x", sources: [PAPER] },
      AGENT,
    );
    const editor = await get(`/p/${page.id}/edit`);
    expect(editor.html).toContain('name="sources"');
    expect(editor.html).toContain(PAPER);

    const result = await post(`/p/${page.id}/edit`, {
      title: "BPC-157",
      body: "x",
      tags: "",
      sources: `${CITE}\r\n\r\n`,
      version: page.version,
      note: "The link was dead",
    });
    expect(result.status).toBe(303);
    const saved = await context.pages.get(context.workspaceId, page.id);
    expect(saved.sources).toEqual([CITE]);

    const { html } = await get(`/p/${page.id}/v/${saved.version}`);
    expect(html).toContain("Sources added");
    expect(html).toContain("Sources removed");
    expect(html).toContain(PAPER);
  });

  it("keeps a page's sources when a form has no sources field", async () => {
    const page = await context.pages.create(context.workspaceId, { title: "Log", body: "x", sources: [CITE] }, AGENT);
    await post(`/p/${page.id}/edit`, { title: "Log", body: "y", tags: "", version: page.version });
    expect((await context.pages.get(context.workspaceId, page.id)).sources).toEqual([CITE]);
  });

  it("refuses a source too long, keeping what was typed", async () => {
    const page = await context.pages.create(context.workspaceId, { title: "Log", body: "x" }, AGENT);
    const result = await post(`/p/${page.id}/edit`, {
      title: "Log",
      body: "kept text",
      tags: "",
      sources: "x".repeat(501),
      version: page.version,
    });
    expect(result.status).toBe(400);
    expect(result.html).toContain("cite it, do not quote it");
    expect(result.html).toContain("kept text");

    const created = await post("/new", { title: "New", body: "", tags: "", sources: "y".repeat(501) });
    expect(created.status).toBe(400);
  });

  it("creates a page with sources", async () => {
    const result = await post("/new", { title: "TB-500", body: "x", tags: "", sources: PAPER });
    expect(result.status).toBe(303);
    const id = result.location!.split("/p/")[1]!.split("?")[0]!;
    expect((await context.pages.get(context.workspaceId, id)).sources).toEqual([PAPER]);
  });

  it("shows and edits a row's sources", async () => {
    await context.tables.create(
      context.workspaceId,
      { name: "Peptides", fields: [{ name: "name", type: "text", required: true }] },
      { actor: OWNER },
      "col_src",
    );
    const row = await context.tables.upsertRow(
      context.workspaceId,
      "col_src",
      { values: { name: "BPC-157" }, sources: [PAPER] },
      AGENT,
      { id: "row_bpc" },
    );
    const view = await get("/t/col_src/r/row_bpc");
    expect(view.html).toContain(`<a href="${PAPER}" rel="noopener noreferrer nofollow">`);

    const result = await post("/t/col_src/r/row_bpc", {
      name: "BPC-157",
      sources: `${PAPER}\n${CITE}`,
      version: row.version,
    });
    expect(result.status).toBe(303);
    const saved = await context.store.getRow(context.workspaceId, "col_src", "row_bpc");
    expect(saved!.sources).toEqual([PAPER, CITE]);
    const revision = await get(`/t/col_src/r/row_bpc/v/${saved!.version}`);
    expect(revision.html).toContain("Sources added");
    expect(revision.html).toContain(CITE);

    const created = await post("/t/col_src/new", { name: "TB-500", sources: CITE });
    expect(created.status).toBe(303);
  });
});

describe("freshness (ADR-028)", () => {
  it("shows whether a page was verified, and marks it from the editor", async () => {
    const page = await context.pages.create(context.workspaceId, { title: "Selank", body: "A heptapeptide." }, AGENT);
    expect((await get(`/p/${page.id}`)).html).toContain("Never verified");

    const editor = await get(`/p/${page.id}/edit`);
    expect(editor.html).toContain('name="verified"');
    const result = await post(`/p/${page.id}/edit`, {
      title: "Selank",
      body: "A heptapeptide.",
      tags: "",
      verified: "on",
      version: page.version,
      note: "Checked against the 2008 trial",
    });
    expect(result.status).toBe(303);
    const saved = await context.pages.get(context.workspaceId, page.id);
    expect(saved.verifiedAt).toBe(saved.updatedAt);

    const { html } = await get(`/p/${page.id}`);
    expect(html).toContain("Verified <time");
    expect(html).not.toContain("Never verified");
    const history = await get(`/p/${page.id}/v/${saved.version}`);
    expect(history.html).toContain("This change confirmed the page");
  });

  it("does not count an edit without the box ticked", async () => {
    const page = await context.pages.create(context.workspaceId, { title: "Log", body: "x" }, AGENT);
    await post(`/p/${page.id}/edit`, { title: "Log", body: "y", tags: "", version: page.version });
    expect((await context.pages.get(context.workspaceId, page.id)).verifiedAt).toBeNull();
  });

  it("lists pages never verified first, then the least recently verified", async () => {
    const old = await context.pages.create(
      context.workspaceId,
      { title: "Checked long ago", body: "x", verifiedAt: "2025-01-01T00:00:00Z" },
      AGENT,
    );
    await context.pages.create(context.workspaceId, { title: "Checked just now", body: "x", sources: ["Smith 2021"] }, AGENT);
    await context.pages.create(context.workspaceId, { title: "Never checked", body: "x" }, AGENT);

    const { status, html } = await get("/freshness");
    expect(status).toBe(200);
    expect(html).toContain("3 pages: 2 verified, 1 never verified");
    const order = ["Never checked", "Checked long ago", "Checked just now"].map((title) => html.indexOf(title));
    expect(order.every((at) => at > 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(old.verifiedAt).toBe("2025-01-01T00:00:00.000Z");
  });
});

describe("collections are the home page (ADR-026)", () => {
  beforeEach(async () => {
    const ws = context.workspaceId;
    await context.pages.create(ws, { title: "Peptides", body: "Research notes on peptides: what each does, and **how** they combine." }, { actor: OWNER }, "pg_root");
    await context.pages.create(ws, { title: "Recovery", parentId: "pg_root", body: "Category." }, { actor: OWNER }, "pg_recovery");
    await context.pages.create(ws, { title: "BPC-157", parentId: "pg_recovery", body: "Healing." }, { actor: OWNER }, "pg_bpc");
    await context.pages.create(ws, { title: "Garden", body: "Another wiki." }, { actor: OWNER }, "pg_garden");
    await context.tables.create(ws, { name: "Stacks", parentId: "pg_root", fields: [{ name: "title", type: "text" }] }, { actor: OWNER }, "col_stacks");
    await context.tables.create(ws, { name: "Loose", fields: [{ name: "title", type: "text" }] }, { actor: OWNER }, "col_loose");
  });

  it("shows each collection with its summary and counts, and tables in none", async () => {
    const { html } = await get("/");
    expect(html).toContain("<title>Cairn</title>");
    expect(html).toContain('href="/p/pg_root"');
    expect(html).toContain("Research notes on peptides: what each does, and how they combine.");
    expect(html).toContain("2 pages · 1 table");
    expect(html).toContain('href="/p/pg_garden"');
    expect(html).toContain("0 pages · 0 tables");
    expect(html).toContain("Tables in no collection");
    expect(html).toContain('href="/t/col_loose"');
    expect(html).not.toContain('href="/p/pg_bpc"');
  });

  it("shows only the current collection's tree in the sidebar", async () => {
    const { html } = await get("/p/pg_bpc");
    expect(html).toContain('aria-label="The Peptides collection"');
    expect(html).toContain('href="/t/col_stacks"');
    const tree = html.slice(html.indexOf('class="cairn-tree"'), html.indexOf("</nav>", html.indexOf('class="cairn-tree"')));
    expect(tree).not.toContain("pg_garden");
  });

  it("wraps the tree in a details element, closed by default, that opens on tap with no script (ADR-056)", async () => {
    const { html } = await get("/p/pg_bpc");
    const start = html.indexOf("<details class=\"cairn-tree-toggle\">");
    expect(start).toBeGreaterThan(-1);
    expect(html.slice(start, start + 60)).not.toContain(" open");
    expect(html).toContain("<summary>Pages in this collection</summary>");
  });

  it("sends old addresses to their new places", async () => {
    const pages = await app.fetch(new Request(`${ORIGIN}/pages`, { headers: { cookie } }));
    expect(pages.status).toBe(301);
    expect(pages.headers.get("location")).toBe("/");
    const table = await app.fetch(new Request(`${ORIGIN}/c/col_stacks?moved=1`, { headers: { cookie } }));
    expect(table.headers.get("location")).toBe("/t/col_stacks?moved=1");
    expect((await get("/changes")).html).toContain("Recent changes");
  });
});

describe("footer shows instance, page count and last backup (ADR-056/057 fault 8)", () => {
  it("names the instance, page count and that no backup has run yet, by default", async () => {
    const { html } = await get("/");
    expect(html).toContain("ws_console");
    expect(html).toContain("0 pages");
    expect(html).toContain("backup status unknown");
  });

  it("shows the self-described instance name, real page count and last backup age", async () => {
    app = createApp({
      context,
      token: TOKEN,
      selfDescription: { name: "Diego's Cairn", description: null, language: "en", topics: null },
      backupStatus: () => Date.now() - 60 * 60 * 1000,
    });
    cookie = await signIn();
    await context.pages.create(context.workspaceId, { title: "Peptides", body: "Notes." }, { actor: OWNER });
    const { html } = await get("/");
    expect(html).toContain("Diego&#39;s Cairn");
    expect(html).toContain("1 page");
    expect(html).toContain("last backup");
  });
});

describe("publishing from the console (ADR-032)", () => {
  it("offers to publish a private page, and says publication stays on this server", async () => {
    const page = await context.pages.create(context.workspaceId, { title: "Peptides", body: "Notes." }, { actor: OWNER });
    const { html } = await get(`/p/${page.id}`);
    expect(html).toContain("Publish this page and everything under it");
    expect(html).toContain("never travels with sync, export or import");
    expect(html).not.toContain("Make private");
  });

  it("publishes, then shows the public address and the way back", async () => {
    const page = await context.pages.create(context.workspaceId, { title: "Peptides", body: "Notes." }, { actor: OWNER });
    const result = await post(`/p/${page.id}/publish`, { version: page.version, public: "true" });
    expect(result.status).toBe(303);
    expect(result.location).toBe(`/p/${page.id}?published=1`);

    const { html } = await get(`/p/${page.id}`);
    expect(html).toContain(`href="/w/${page.id}"`);
    expect(html).toContain("Make private");
  });

  it("sends someone to the page above when that is what publishes this one", async () => {
    const parent = await context.pages.create(context.workspaceId, { title: "Peptides", body: "Notes." }, { actor: OWNER });
    const child = await context.pages.create(context.workspaceId, { title: "BPC-157", body: "Healing.", parentId: parent.id }, { actor: OWNER });
    await post(`/p/${parent.id}/publish`, { version: parent.version, public: "true" });

    const { html } = await get(`/p/${child.id}`);
    expect(html).toContain("Public, because");
    expect(html).toContain(`href="/p/${parent.id}"`);
    expect(html).not.toContain("Make private");
  });
});

describe("PDF export from the console", () => {
  it("offers a page-only PDF button, and a subtree one only when there are children", async () => {
    const parent = await context.pages.create(context.workspaceId, { title: "Peptides", body: "Notes." }, { actor: OWNER });
    const { html: leaf } = await get(`/p/${parent.id}`);
    expect(leaf).toContain('data-ak-action="print"');
    expect(leaf).not.toContain("PDF (page + subtree)");

    await context.pages.create(context.workspaceId, { title: "BPC-157", body: "Healing.", parentId: parent.id }, { actor: OWNER });
    const { html: withChild } = await get(`/p/${parent.id}`);
    expect(withChild).toContain(`href="/p/${parent.id}/print?subtree=1"`);
  });

  it("renders the page alone at /print, without the console chrome", async () => {
    const page = await context.pages.create(context.workspaceId, { title: "Peptides", body: "Loading dose: 250mcg." }, { actor: OWNER });
    const { html } = await get(`/p/${page.id}/print`);
    expect(html).toContain("Loading dose");
    expect(html).toContain("Print or save as PDF");
    // The console's own chrome is still on the page (so it works as a normal
    // page too), but print.css (assets.ts) hides .cairn-top and .ak-footer
    // under @media print, so only the article reaches paper.
    expect(html).toContain('class="cairn-top"');
  });

  it("at /print?subtree=1, includes every descendant, parents before children", async () => {
    const parent = await context.pages.create(context.workspaceId, { title: "Peptides", body: "Overview." }, { actor: OWNER });
    await context.pages.create(context.workspaceId, { title: "BPC-157", body: "Healing peptide.", parentId: parent.id }, { actor: OWNER });
    const { html } = await get(`/p/${parent.id}/print?subtree=1`);
    expect(html.indexOf("Overview.")).toBeLessThan(html.indexOf("Healing peptide."));
  });
});

describe("connecting an agent from the console home page", () => {
  it("gives the Claude Code MCP command and the CLI commands for this Cairn's own address", async () => {
    const { html } = await get("/");
    expect(html).toContain(`claude mcp add --transport http cairn ${ORIGIN}/mcp`);
    expect(html).toContain("vscode:mcp/install?");
    expect(html).toContain("npm install -g @vespassassina/cairncli");
    expect(html).toContain(`cairn instances add ws_console ${ORIGIN}`);
    expect(html).toContain("cairn login --instance ws_console");
  });

  it("does not offer this on every page, only on the home page", async () => {
    const page = await context.pages.create(context.workspaceId, { title: "Peptides", body: "Notes." }, { actor: OWNER });
    const { html } = await get(`/p/${page.id}`);
    expect(html).not.toContain("claude mcp add");
  });

  it("uses the configured public origin, not the request's own scheme, so a TLS-ending proxy does not turn https into http", async () => {
    const PUBLIC = "https://cairn.example.com";
    app = createApp({ context, token: TOKEN, publicOrigin: PUBLIC });
    const loginResponse = await app.fetch(
      new Request(`${ORIGIN}/login`, {
        method: "POST",
        headers: { origin: PUBLIC, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: TOKEN, next: "/" }),
      }),
    );
    cookie = (loginResponse.headers.get("set-cookie") ?? "").split(";")[0]!;
    const { html } = await get("/");
    expect(html).toContain(`claude mcp add --transport http cairn ${PUBLIC}/mcp`);
    expect(html).toContain(`cairn instances add ws_console ${PUBLIC}`);
    expect(html).not.toContain(`${ORIGIN}/mcp`);
  });
});

describe("approval in the console (ADR-078)", () => {
  async function agentPage(title: string, body = "Some text.") {
    return context.pages.create(context.workspaceId, { title, body }, AGENT);
  }

  it("sets the mark from the page view and shows who set it and when", async () => {
    const page = await agentPage("Doses");
    const result = await post(`/p/${page.id}/approval`, { approval: "approved", version: page.version });
    expect(result.status).toBe(303);
    expect(result.location).toBe(`/p/${page.id}?approved=1`);

    const saved = await context.pages.get(context.workspaceId, page.id);
    expect(saved.approval).toBe("approved");
    expect(saved.approvalVersion).toBe(page.version);
    const [latest] = await context.pages.history(context.workspaceId, page.id);
    expect(latest!.note).toBe("Marked approved");
    expect(latest!.actor.kind).toBe("user");

    const { html } = await get(`/p/${page.id}?approved=1`);
    expect(html).toContain("Approved by Owner");
    expect(html).toContain(`action="/p/${page.id}/approval"`);
    expect(html).toContain('name="approval" value="disapproved"');
    expect(html).toContain('name="approval" value="neutral"');
    expect(html).not.toContain('name="approval" value="approved"');
  });

  it("refuses a stale version, and says to open the page again", async () => {
    const page = await agentPage("Stale");
    await post(`/p/${page.id}/approval`, { approval: "approved", version: page.version });
    const result = await post(`/p/${page.id}/approval`, { approval: "disapproved", version: page.version });
    expect(result.status).toBe(409);
    expect(result.html).toContain("changed since you opened it");
  });

  it("warns on a disapproved page and on one changed since approval", async () => {
    const page = await agentPage("Wrong");
    await post(`/p/${page.id}/approval`, { approval: "disapproved", version: page.version });
    expect((await get(`/p/${page.id}`)).html).toContain("Do not build on this page");

    const other = await agentPage("Changed", "Short.");
    await post(`/p/${other.id}/approval`, { approval: "approved", version: other.version });
    const approved = await context.pages.get(context.workspaceId, other.id);
    await context.pages.update(context.workspaceId, other.id, { title: "Changed", body: "A completely different and much longer body of text." }, approved.version, AGENT);
    const { html } = await get(`/p/${other.id}`);
    expect(html).toContain("Was approved");
    expect(html).toContain("changed since");
  });

  it("lists changed-since-approval pages first, then unchecked agent writes, then the rest by links, with buttons that work without JavaScript", async () => {
    const changed = await agentPage("Changed since", "Short.");
    await post(`/p/${changed.id}/approval`, { approval: "approved", version: changed.version });
    const approvedChanged = await context.pages.get(context.workspaceId, changed.id);
    await context.pages.update(context.workspaceId, changed.id, { title: "Changed since", body: "A completely different and much longer body of text." }, approvedChanged.version, AGENT);

    const byAgent = await agentPage("By an agent");
    const byOwner = await context.pages.create(context.workspaceId, { title: "By the owner", body: "Mine." }, { actor: OWNER });
    const linked = await context.pages.create(context.workspaceId, { title: "Linked to", body: "Popular." }, { actor: OWNER });
    await context.pages.create(context.workspaceId, { title: "Linker", body: `See [[${linked.id}]] and [[${linked.id}]].` }, { actor: OWNER });
    const fine = await agentPage("Fine");
    await post(`/p/${fine.id}/approval`, { approval: "approved", version: fine.version });

    // Inbound links are derived, so the "Linked to" row's place settles a moment after the write (hard rule 11).
    const html = await eventually(async () => {
      const { status, html } = await get("/review");
      expect(status).toBe(200);
      const order = [changed, byAgent, linked, byOwner].map((page) => html.indexOf(`href="/p/${page.id}"`));
      expect(order.every((at) => at > 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      return html;
    });
    expect(html).not.toContain(`href="/p/${fine.id}"`);
    expect(html).toContain("changed since approval");
    // Plain forms: the buttons need no script.
    expect(html).toContain(`<form method="post" action="/p/${changed.id}/approval"`);
    expect(html).not.toContain("data-ak-action");

    // A row's button posts the mark and comes back to the queue.
    const current = await context.pages.get(context.workspaceId, changed.id);
    const result = await post(`/p/${changed.id}/approval`, { approval: "approved", version: current.version, next: `/review#${changed.id}` });
    expect(result.status).toBe(303);
    expect(result.location).toBe(`/review#${changed.id}`);
    expect((await get("/review")).html).not.toContain(`href="/p/${changed.id}"`);
  });

  it("only goes back to a place on this console", async () => {
    const page = await agentPage("Elsewhere");
    const result = await post(`/p/${page.id}/approval`, { approval: "approved", version: page.version, next: "https://evil.example/" });
    expect(result.location).toBe("/");
  });

  it("shows the count on the home page, linking to the queue", async () => {
    await agentPage("One");
    await agentPage("Two");
    const { html } = await get("/");
    expect(html).toContain('href="/review"');
    expect(html).toContain("2 pages to review");
  });

  it("lets the owner keep the mark through a large edit from the editor", async () => {
    const page = await agentPage("Kept", "Short.");
    await post(`/p/${page.id}/approval`, { approval: "approved", version: page.version });
    const approved = await context.pages.get(context.workspaceId, page.id);
    expect((await get(`/p/${page.id}/edit`)).html).toContain('name="keep_approval"');
    const result = await post(`/p/${page.id}/edit`, {
      title: "Kept",
      body: "A completely different and much longer body of text.",
      tags: "",
      version: approved.version,
      note: "Rewrote it",
      keep_approval: "1",
    });
    expect(result.status).toBe(303);
    const saved = await context.pages.get(context.workspaceId, page.id);
    expect(saved.approval).toBe("approved");
    const [latest] = await context.pages.history(context.workspaceId, page.id);
    expect(latest!.note).toContain("approval kept by the owner");
  });
});
