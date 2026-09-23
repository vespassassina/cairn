import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/app.js";
import { createContext, OWNER, type AppContext } from "../src/context.js";
import { createPublishToken, revokePublishToken } from "../src/publish-tokens.js";
import { createAttachment, confirmAttachmentUpload } from "../src/attachments.js";
import type { AttachmentBlobStore } from "../src/attachments-blob.js";

// The webmention route's SSRF guard resolves the sender's address for real
// (citations.test.ts covers that resolution directly); here it only needs to
// answer with something public, so the notice's own verification is what's
// under test.
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));

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

  it("carries sources as JSON-LD citation and isBasedOn (ADR-039)", async () => {
    const page = await context.pages.create(
      context.workspaceId,
      {
        title: "Built on a friend's work",
        body: "See the original.",
        sources: ["https://other.example.com/w/pg_notes", "Smith 2021, J Pept Sci"],
      },
      { actor: OWNER },
    );
    await publish(page.id, page.version);

    const read = await stranger(`/w/${page.id}`);
    const match = read.body.match(/<script type="application\/ld\+json">([^<]*)<\/script>/);
    expect(match).not.toBeNull();
    const jsonLd = JSON.parse(match![1]!);
    expect(jsonLd["@type"]).toBe("WebPage");
    expect(jsonLd["citation"]).toContainEqual({
      "@type": "CreativeWork",
      url: "https://other.example.com/w/pg_notes",
      name: "https://other.example.com/w/pg_notes",
    });
    expect(jsonLd["citation"]).toContain("Smith 2021, J Pept Sci");
    expect(jsonLd["isBasedOn"]).toEqual(["https://other.example.com/w/pg_notes"]);
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

describe("token-gated subtrees (ADR-066)", () => {
  it("stays open, no token needed, until one is issued", async () => {
    const { parent } = await aSmallWiki();
    expect((await stranger(`/w/${parent.id}`)).status).toBe(200);
  });

  it("answers the same 404 as an unpublished page when no token is presented", async () => {
    const { parent, child } = await aSmallWiki();
    await createPublishToken(context, { pageId: parent.id, name: "accountant", description: null }, { actor: OWNER });
    const gatedParent = await stranger(`/w/${parent.id}`);
    const gatedChild = await stranger(`/w/${child.id}`);
    expect(gatedParent.status).toBe(404);
    expect(gatedChild.status).toBe(404);
    expect(gatedParent.body).not.toContain("What this wiki covers.");
  });

  it("serves a gated page with the right token as ?token=, and refuses a wrong one", async () => {
    const { parent } = await aSmallWiki();
    const created = await createPublishToken(context, { pageId: parent.id, name: "accountant", description: null }, { actor: OWNER });
    const right = await stranger(`/w/${parent.id}?token=${encodeURIComponent(created.token)}`);
    expect(right.status).toBe(200);
    expect(right.body).toContain("What this wiki covers.");
    const wrong = await stranger(`/w/${parent.id}?token=not-the-token`);
    expect(wrong.status).toBe(404);
  });

  it("serves a gated page with the right token as an Authorization: Bearer header", async () => {
    const { parent } = await aSmallWiki();
    const created = await createPublishToken(context, { pageId: parent.id, name: "script", description: null }, { actor: OWNER });
    const response = await app.fetch(
      new Request(`${ORIGIN}/w/${parent.id}`, { headers: { authorization: `Bearer ${created.token}` } }),
    );
    expect(response.status).toBe(200);
  });

  it("gates the whole subtree from wherever the token was issued", async () => {
    const { parent, child } = await aSmallWiki();
    const created = await createPublishToken(context, { pageId: parent.id, name: "accountant", description: null }, { actor: OWNER });
    const under = await stranger(`/w/${child.id}?token=${encodeURIComponent(created.token)}`);
    expect(under.status).toBe(200);
    expect(under.body).toContain("A peptide.");
  });

  it("stops working once revoked, while another token for the same subtree still does", async () => {
    const { parent } = await aSmallWiki();
    const revoked = await createPublishToken(context, { pageId: parent.id, name: "accountant", description: null }, { actor: OWNER });
    const kept = await createPublishToken(context, { pageId: parent.id, name: "brother", description: null }, { actor: OWNER });
    await revokePublishToken(context, revoked.id, { actor: OWNER });
    expect((await stranger(`/w/${parent.id}?token=${encodeURIComponent(revoked.token)}`)).status).toBe(404);
    expect((await stranger(`/w/${parent.id}?token=${encodeURIComponent(kept.token)}`)).status).toBe(200);
  });

  it("reopens the subtree, no auth, once its only token is revoked (ADR-066 decision 3)", async () => {
    const { parent } = await aSmallWiki();
    const created = await createPublishToken(context, { pageId: parent.id, name: "accountant", description: null }, { actor: OWNER });
    await revokePublishToken(context, created.id, { actor: OWNER });
    expect((await stranger(`/w/${parent.id}`)).status).toBe(200);
  });

  it("carries the token through breadcrumb and child links, within the gated subtree only", async () => {
    const { parent, child } = await aSmallWiki();
    const created = await createPublishToken(context, { pageId: parent.id, name: "accountant", description: null }, { actor: OWNER });
    const page = await stranger(`/w/${parent.id}?token=${encodeURIComponent(created.token)}`);
    expect(page.body).toContain(`href="/w/${child.id}?token=${encodeURIComponent(created.token)}"`);
  });

  it("excludes a gated subtree from the /w listing", async () => {
    const { parent, child } = await aSmallWiki();
    const open = await context.pages.create(context.workspaceId, { title: "Open notes", body: "x" }, { actor: OWNER });
    await publish(open.id, open.version);
    await createPublishToken(context, { pageId: parent.id, name: "accountant", description: null }, { actor: OWNER });

    const index = await stranger("/w");
    expect(index.body).not.toContain("Peptides");
    expect(index.body).not.toContain("BPC-157");
    expect(index.body).not.toContain(parent.id);
    expect(index.body).not.toContain(child.id);
    expect(index.body).toContain("Open notes");
  });

  it("excludes a gated page from the sitemap", async () => {
    const { parent, child } = await aSmallWiki();
    await createPublishToken(context, { pageId: parent.id, name: "accountant", description: null }, { actor: OWNER });
    const sitemap = await stranger("/sitemap.xml");
    expect(sitemap.body).not.toContain(parent.id);
    expect(sitemap.body).not.toContain(child.id);
  });

  it("excludes a gated collection from /.well-known/cairn.json", async () => {
    const { parent } = await aSmallWiki();
    await createPublishToken(context, { pageId: parent.id, name: "accountant", description: null }, { actor: OWNER });
    const body = JSON.parse((await stranger("/.well-known/cairn.json")).body);
    expect(body.collections).toEqual([]);
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

  it("lists the origins its published pages cite, deduplicated (ADR-041)", async () => {
    await aSmallWiki();
    const a = await context.pages.create(
      context.workspaceId,
      { title: "Cites a friend", body: "x", sources: ["https://friend.example/w/pg_notes"] },
      { actor: OWNER },
    );
    await publish(a.id, a.version);
    const b = await context.pages.create(
      context.workspaceId,
      { title: "Cites the same friend again, and an ordinary link", body: "x", sources: ["https://friend.example/w/pg_other", "https://not-a-cairn.example/article"] },
      { actor: OWNER },
    );
    await publish(b.id, b.version);

    const body = JSON.parse((await stranger("/.well-known/cairn.json")).body);
    expect(body.cites).toEqual(["https://friend.example"]);
  });

  it("lists no collections and needs no sign-in when nothing is published", async () => {
    const response = await stranger("/.well-known/cairn.json");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).collections).toEqual([]);
  });
});

describe("receiving a citation notice (ADR-040)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function trust(url: string) {
    const table = await context.tables.create(
      context.workspaceId,
      { name: "Trusted cairns", fields: [{ name: "url", type: "url", required: true }] },
      { actor: OWNER },
    );
    await context.tables.upsertRow(context.workspaceId, table.id, { values: { url } }, { actor: OWNER });
  }

  function webmention(source: string, target: string) {
    return app.fetch(
      new Request(`${ORIGIN}/webmention`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ source, target }),
      }),
    );
  }

  it("accepts a notice from a trusted origin and lists it as Cited by", async () => {
    const { parent } = await aSmallWiki();
    await trust("https://friend.example.com");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`<a href="${ORIGIN}/w/${parent.id}">source</a>`, { status: 200 })),
    );

    const response = await webmention("https://friend.example.com/post", `${ORIGIN}/w/${parent.id}`);
    expect(response.status).toBe(202);
    expect(await response.text()).toContain("accepted");

    const page = await stranger(`/w/${parent.id}`);
    expect(page.body).toContain("Cited by");
    expect(page.body).toContain("https://friend.example.com/post");
  });

  it("stores a notice from an untrusted origin as pending, not shown on the page", async () => {
    const { parent } = await aSmallWiki();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`<a href="${ORIGIN}/w/${parent.id}">source</a>`, { status: 200 })),
    );

    const response = await webmention("https://stranger.example.com/post", `${ORIGIN}/w/${parent.id}`);
    expect(response.status).toBe(202);
    expect(await response.text()).toContain("pending");

    const page = await stranger(`/w/${parent.id}`);
    expect(page.body).not.toContain("Cited by");
    expect(page.body).not.toContain("stranger.example.com");
  });

  it("refuses a notice whose source does not actually link back", async () => {
    const { parent } = await aSmallWiki();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<a href="/somewhere-else">nope</a>`, { status: 200 })));

    const response = await webmention("https://stranger.example.com/post", `${ORIGIN}/w/${parent.id}`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("does not link to");
  });

  it("refuses a target that is not a page this Cairn currently publishes", async () => {
    const { secret } = await aSmallWiki();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));

    const response = await webmention("https://stranger.example.com/post", `${ORIGIN}/w/${secret.id}`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("not a page this Cairn currently publishes");
  });
});

describe("attachments on a published page (ADR-064)", () => {
  const SHA = "e".repeat(64);

  function fakeStore(): AttachmentBlobStore {
    const sizes = new Map<string, number>();
    return {
      async head(key) {
        const bytes = sizes.get(key);
        return bytes === undefined ? null : { bytes };
      },
      async uploadUrl(key) {
        return `https://blob.example/${key}?upload`;
      },
      async downloadUrl(key, _expires, filename) {
        return `https://blob.example/${key}?download&filename=${encodeURIComponent(filename)}`;
      },
      // Test-only: stands in for the PUT a real caller would make.
      _land(key: string, bytes: number) {
        sizes.set(key, bytes);
      },
    } as AttachmentBlobStore & { _land(key: string, bytes: number): void };
  }

  it("renders a confirmed attachment as an image with a signed URL, for a stranger with no session", async () => {
    const store = fakeStore() as AttachmentBlobStore & { _land(key: string, bytes: number): void };
    context.attachmentsStore = store;

    const parent = await context.pages.create(context.workspaceId, { title: "Build log", body: "placeholder" }, { actor: OWNER });
    const { row } = await createAttachment(
      context,
      { pageId: parent.id, filename: "wiring.png", altText: "the ESC wiring", sha256: SHA, contentType: "image/png", bytes: 5 },
      { actor: OWNER },
    );
    store._land(row.blobKey, 5);
    await confirmAttachmentUpload(context, row.id, { actor: OWNER });

    const withBody = await context.pages.update(
      context.workspaceId,
      parent.id,
      { title: parent.title, body: `See the diagram.\n\n![the ESC wiring](attachment:${row.id})` },
      parent.version,
      { actor: OWNER },
    );
    await publish(parent.id, withBody.version);

    const page = await stranger(`/w/${parent.id}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain(`src="https://blob.example/${row.blobKey}?download`);
    expect(page.body).toContain("wiring.png");
  });

  it("marks a reference to a missing or unconfirmed attachment as broken, without leaking anything", async () => {
    const parent = await context.pages.create(
      context.workspaceId,
      { title: "Build log", body: "See ![missing](attachment:att_does_not_exist)." },
      { actor: OWNER },
    );
    await publish(parent.id, parent.version);

    const page = await stranger(`/w/${parent.id}`);
    expect(page.status).toBe(200);
    expect(page.body).toContain("cairn-missing");
    expect(page.body).not.toContain("blob.example");
  });
});
