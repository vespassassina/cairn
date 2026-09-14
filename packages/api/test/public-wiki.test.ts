import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/app.js";
import { createContext, OWNER, type AppContext } from "../src/context.js";

/**
 * The published wiki (ADR-032).
 *
 * These are the tests the feature lives or dies on. Everything here is asked
 * as a stranger would ask it: no cookie, no token, nothing but the address.
 * A leak found in production instead of here is a bug of the first order.
 */

const TOKEN = "test-token-0123456789abcdef";
const ORIGIN = "http://localhost";

let app: Hono;
let context: AppContext;
let cookie: string;

/** A request from a stranger: no session, no token, nothing. */
async function stranger(path: string) {
  const response = await app.fetch(new Request(`${ORIGIN}${path}`));
  return { status: response.status, headers: response.headers, body: await response.text() };
}

async function signIn(): Promise<string> {
  const response = await app.fetch(
    new Request(`${ORIGIN}/login`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: TOKEN, next: "/" }),
    }),
  );
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
}

async function publish(id: string, version: string, isPublic = true) {
  const response = await app.fetch(
    new Request(`${ORIGIN}/p/${encodeURIComponent(id)}/publish`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ version, public: String(isPublic) }),
    }),
  );
  return { status: response.status, location: response.headers.get("location") };
}

beforeEach(async () => {
  context = await createContext({
    database: ":memory:",
    host: "127.0.0.1",
    port: 0,
    token: TOKEN,
    workspaceId: "ws_public",
  });
  app = createApp({ context, token: TOKEN, contentLicence: "CC BY 4.0" });
  cookie = await signIn();
});

/** A published parent with one published child and one private page beside it. */
async function aSmallWiki() {
  const parent = await context.pages.create(
    context.workspaceId,
    { title: "Peptides", body: "What this wiki covers." },
    { actor: OWNER },
  );
  const child = await context.pages.create(
    context.workspaceId,
    { title: "BPC-157", body: "A peptide.", parentId: parent.id },
    { actor: OWNER },
  );
  const secret = await context.pages.create(
    context.workspaceId,
    { title: "Blood test results", body: "Private numbers." },
    { actor: OWNER },
  );
  await publish(parent.id, parent.version);
  return { parent, child, secret };
}

describe("what a stranger can read", () => {
  it("serves a published page and its children with no sign-in", async () => {
    const { parent, child } = await aSmallWiki();

    const index = await stranger("/w");
    expect(index.status).toBe(200);
    expect(index.body).toContain("Peptides");
    expect(index.body).toContain("BPC-157");

    const page = await stranger(`/w/${parent.id}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain("What this wiki covers.");

    // Publishing runs down the tree, so the child is published too.
    const under = await stranger(`/w/${child.id}`);
    expect(under.status).toBe(200);
    expect(under.body).toContain("A peptide.");
  });

  it("carries the licence the owner set, and a canonical address", async () => {
    const { parent } = await aSmallWiki();
    const page = await stranger(`/w/${parent.id}`);
    expect(page.body).toContain("CC BY 4.0");
    expect(page.body).toContain(`rel="canonical"`);
  });

  it("still asks everyone to sign in for the console", async () => {
    await aSmallWiki();
    const console = await stranger("/pages");
    expect(console.status).toBe(302);
  });
});

describe("what a stranger cannot read", () => {
  it("answers 404 for a page that is not published, and says nothing about it", async () => {
    const { secret } = await aSmallWiki();
    const asked = await stranger(`/w/${secret.id}`);
    expect(asked.status).toBe(404);
    expect(asked.body).not.toContain("Blood test results");
    expect(asked.body).not.toContain("Private numbers.");
  });

  it("answers the same 404 for an id that never existed", async () => {
    await aSmallWiki();
    const missing = await stranger("/w/pg_nothing_here");
    const notPublished = await stranger(`/w/${(await aSmallWiki()).secret.id}`);
    expect(missing.status).toBe(404);
    expect(notPublished.status).toBe(404);
    expect(missing.body).toBe(notPublished.body);
  });

  it("never lists a private page", async () => {
    const { parent } = await aSmallWiki();
    const hidden = await context.pages.create(
      context.workspaceId,
      { title: "Draft nobody should see", body: "x" },
      { actor: OWNER },
    );
    for (const path of ["/w", `/w/${parent.id}`, "/sitemap.xml"]) {
      const response = await stranger(path);
      expect(response.body, path).not.toContain("Draft nobody should see");
      expect(response.body, path).not.toContain(hidden.id);
    }
  });

  it("renders a link to a private page as plain text, and does not name it", async () => {
    const { parent, secret } = await aSmallWiki();
    await context.pages.update(
      context.workspaceId,
      parent.id,
      { title: parent.title, body: `See [[${secret.id}]] and [[${secret.id}|the other page]].` },
      (await context.pages.get(context.workspaceId, parent.id)).version,
      { actor: OWNER },
    );
    const page = await stranger(`/w/${parent.id}`);
    expect(page.status).toBe(200);
    expect(page.body).not.toContain(`href="/w/${secret.id}`);
    expect(page.body).not.toContain(`href="/p/${secret.id}`);
    expect(page.body).not.toContain(secret.id);
    expect(page.body).not.toContain("Blood test results");
    expect(page.body).toContain("a page that is not published");
    // The label a writer typed is their own words, so it stays, as plain text.
    expect(page.body).toContain("the other page");
  });

  it("names nobody: no actor, no change note, no history", async () => {
    const parent = await context.pages.create(
      context.workspaceId,
      { title: "Open notes", body: "Text." },
      { actor: { kind: "agent", id: "mcp:dev", label: "claude-code/2.0.0" }, note: "First draft" },
    );
    await publish(parent.id, parent.version);
    const page = await stranger(`/w/${parent.id}`);
    expect(page.body).not.toContain("claude-code");
    expect(page.body).not.toContain("First draft");
    expect(page.body).not.toContain("History");
  });

  it("has no search and no page list of its own", async () => {
    await aSmallWiki();
    expect((await stranger("/w/search?q=blood")).status).toBe(404);
    const index = await stranger("/w");
    expect(index.body).not.toContain('role="search"');
  });
});

describe("publishing, and taking a page down", () => {
  it("is refused when the page changed since the form was opened", async () => {
    const page = await context.pages.create(
      context.workspaceId,
      { title: "Notes", body: "x" },
      { actor: OWNER },
    );
    const stale = page.version;
    await context.pages.update(context.workspaceId, page.id, { title: "Notes", body: "y" }, stale, {
      actor: OWNER,
    });

    const refused = await publish(page.id, stale);
    expect(refused.status).toBe(409);
    expect((await context.pages.get(context.workspaceId, page.id)).public).toBe(false);
    expect((await stranger(`/w/${page.id}`)).status).toBe(404);
  });

  it("takes a page down again, along with everything under it", async () => {
    const { parent, child } = await aSmallWiki();
    const now = await context.pages.get(context.workspaceId, parent.id);
    const taken = await publish(parent.id, now.version, false);
    expect(taken.location).toContain("unpublished=1");
    expect((await stranger(`/w/${parent.id}`)).status).toBe(404);
    expect((await stranger(`/w/${child.id}`)).status).toBe(404);
  });

  it("is not something a stranger can do", async () => {
    const page = await context.pages.create(
      context.workspaceId,
      { title: "Notes", body: "x" },
      { actor: OWNER },
    );
    const response = await app.fetch(
      new Request(`${ORIGIN}/p/${page.id}/publish`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ version: page.version, public: "true" }),
      }),
    );
    expect(response.status).toBe(401);
    expect((await context.pages.get(context.workspaceId, page.id)).public).toBe(false);
  });
});

describe("what search engines are told", () => {
  it("lists published pages in the sitemap and nothing else", async () => {
    const { parent, child, secret } = await aSmallWiki();
    const sitemap = await stranger("/sitemap.xml");
    expect(sitemap.status).toBe(200);
    expect(sitemap.headers.get("content-type")).toContain("xml");
    expect(sitemap.body).toContain(`/w/${parent.id}`);
    expect(sitemap.body).toContain(`/w/${child.id}`);
    expect(sitemap.body).not.toContain(secret.id);
  });

  it("allows the published wiki in robots.txt and disallows the rest", async () => {
    const robots = await stranger("/robots.txt");
    expect(robots.status).toBe(200);
    expect(robots.body).toContain("Allow: /w");
    expect(robots.body).toContain("Disallow: /");
    expect(robots.body).toContain("Sitemap: http://localhost/sitemap.xml");
  });

  it("keeps the console's security headers on published pages", async () => {
    const { parent } = await aSmallWiki();
    const page = await stranger(`/w/${parent.id}`);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("what a Cairn says about itself (ADR-034)", () => {
  it("describes itself with defaults when nothing is configured", async () => {
    const { parent, secret } = await aSmallWiki();
    const response = await stranger("/.well-known/cairn.json");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({ cairn: "1", name: "Cairn", language: "en", licence: "CC BY 4.0", cites: [] });
    expect(body.description).toBeUndefined();
    expect(body.topics).toBeUndefined();
    expect(body.collections).toEqual([{ title: "Peptides", url: `http://localhost/w/${parent.id}` }]);
    expect(body.sitemap).toBe("http://localhost/sitemap.xml");
    expect(JSON.stringify(body)).not.toContain(secret.id);
  });

  it("carries the owner's name, description, language and topics when set", async () => {
    app = createApp({
      context,
      token: TOKEN,
      contentLicence: "CC BY 4.0",
      selfDescription: { name: "Peptide Notes", description: "Research notes.", language: "en", topics: ["peptides", "biohacking"] },
    });
    cookie = await signIn();
    await aSmallWiki();
    const body = JSON.parse((await stranger("/.well-known/cairn.json")).body);
    expect(body).toMatchObject({
      name: "Peptide Notes",
      description: "Research notes.",
      language: "en",
      topics: ["peptides", "biohacking"],
    });
  });

  it("lists no collections and needs no sign-in when nothing is published", async () => {
    const response = await stranger("/.well-known/cairn.json");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).collections).toEqual([]);
  });
});
