/** @jsxImportSource hono/jsx */
import type { Context, Hono } from "hono";
import { raw } from "hono/html";
import type { Child, FC } from "hono/jsx";
import { gateRootOf, gatedIds, isCairnPageAddress, publishedIds, sourceHref, type Page, type Paged } from "@cairn/core";
import type { AppContext } from "../context.js";
import { citedByOf, receiveCitation, WebmentionError } from "../citations.js";
import { activeTokenPageIds, verifyPublishToken } from "../publish-tokens.js";
import { getAttachment } from "../attachments.js";
import { ASSET_VERSION, documentTitle, HEAD_TAGS } from "./assets.js";
import { When } from "./layout.js";
import { createMarkdownRenderer, type AttachmentResolver, type LinkResolver } from "./markdown.js";

/**
 * The published wiki (ADR-032): the pages an owner has marked public, served
 * read-only to anyone, with no sign-in.
 *
 * Everything here is written against one rule: nothing that is not published
 * may be seen, named, counted or linked to. So this module reads pages once,
 * works out the published set, and then looks at nothing outside it. An id
 * that is not published answers 404, the same answer as an id that does not
 * exist, because which of the two it is would itself be a leak.
 *
 * There is no search, no history, no tables and no actor name on this surface
 * (ADR-032 decisions 3 and 4). Each of those is a way for private text to
 * reach a stranger, and none of them is worth that risk.
 *
 * `/.well-known/cairn.json` (ADR-034) describes the Cairn itself, for a
 * registry or a crawler that follows citations between Cairns. It is built
 * from the same published set as everything else here, so it names no page
 * that is not published.
 *
 * `POST /webmention` (ADR-040) is this surface's one write: a citation
 * notice from another site, verified before it is recorded, shown on a page
 * only once accepted.
 */

export interface PublicWikiOptions {
  context: AppContext;
  /** The origin people reach this Cairn at, for canonical links and the sitemap. */
  publicOrigin?: string | null;
  /** The licence the owner puts on published pages (ADR-032 decision 7). */
  contentLicence?: string | null;
  /** How this Cairn describes itself at /.well-known/cairn.json (ADR-034). */
  selfDescription?: SelfDescription | null;
  /**
   * The IndexNow key (ADR-074). Null or absent: the feature is off, no key
   * file is served, and `publishPage` never notifies IndexNow. When set,
   * `GET /<key>.txt` serves the key itself, the proof IndexNow requires.
   */
  indexNowKey?: string | null;
}

/** The owner's settings for /.well-known/cairn.json (ADR-034). None are secret. */
export interface SelfDescription {
  name: string;
  description: string | null;
  language: string;
  topics: string[] | null;
}

const renderMarkdown = createMarkdownRenderer();

/** Upper bound on pages read to work out what is published. Personal scale. */
const MAX_PAGES = 5_000;

/**
 * A page's address under `/w`. `token` is carried along only when the page
 * itself needs one (ADR-066): a link inside an open subtree never grows a
 * `?token=`, even when the page rendering it happens to be gated.
 */
export const wikiHref = (pageId: string, token?: string | null) =>
  `/w/${encodeURIComponent(pageId)}${token ? `?token=${encodeURIComponent(token)}` : ""}`;

/** The token a request presented, from `?token=` or `Authorization: Bearer` (ADR-066 decision 4). */
function presentedToken(c: Context): string | null {
  const query = c.req.query("token");
  if (query) return query;
  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || null;
  return null;
}

async function allPages(context: AppContext): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | null = null;
  do {
    const batch: Paged<Page> = await context.store.listPages(context.workspaceId, { limit: 500, cursor });
    pages.push(...batch.items);
    cursor = batch.cursor;
  } while (cursor !== null && pages.length < MAX_PAGES);
  return pages;
}

/** The published pages, and nothing else, in the order the store gave them. */
async function published(context: AppContext): Promise<Page[]> {
  const pages = await allPages(context);
  const ids = publishedIds(pages);
  return pages.filter((page) => ids.has(page.id));
}

/**
 * Names and addresses for published pages only. A link to anything else is
 * unknown to this resolver, and `plainWhenUnknown` turns it into plain text.
 */
function resolverFor(pages: readonly Page[], gated: ReadonlySet<string>, token: string | null): LinkResolver {
  const titles = new Map(pages.map((page) => [page.id, page.title]));
  return {
    title: (id) => titles.get(id) ?? null,
    href: (id) => (titles.has(id) ? wikiHref(id, gated.has(id) ? token : null) : null),
    plainWhenUnknown: true,
  };
}

/** `attachment:<id>` references in a page body, the same targets the renderer resolves. */
const ATTACHMENT_REF = /\]\(attachment:([A-Za-z0-9_-]+)\)/g;

/**
 * Signed download URLs for every attachment a page body references, resolved
 * before the (synchronous) render so it can look them up by id (ADR-064
 * decision 4). A reference to a missing, not-yet-committed or deleted
 * attachment is simply absent from the map; the renderer shows those as
 * visible broken-but-safe text rather than erroring.
 *
 * Only an attachment whose own `page` is the page being rendered resolves.
 * Without this check, a published page could embed `attachment:<any-id>` and
 * mint a working signed URL for a file that belongs to an unpublished or
 * gated page — the publish check on the page body says nothing about which
 * attachment rows it is allowed to point at.
 */
async function attachmentResolverFor(context: AppContext, page: Page): Promise<AttachmentResolver> {
  const ids = new Set([...page.body.matchAll(ATTACHMENT_REF)].map((match) => match[1]!));
  const found = new Map<string, { url: string; altText: string | null; filename: string }>();
  for (const id of ids) {
    try {
      const { row, downloadUrl } = await getAttachment(context, id);
      if (downloadUrl && row.page === page.id) found.set(id, { url: downloadUrl, altText: row.altText, filename: row.filename });
    } catch {
      // Not found, or attachments are off entirely: left out of the map, so
      // the renderer shows it as missing rather than throwing into the page.
      continue;
    }
  }
  return { resolve: (id) => found.get(id) ?? null };
}

/** The top of each published subtree: everything else hangs below one of these. */
function rootsOf(pages: readonly Page[]): Page[] {
  const ids = new Set(pages.map((page) => page.id));
  return pages.filter((page) => page.parentId === null || !ids.has(page.parentId));
}

/** The published pages above this one, outermost first. */
function ancestorsOf(page: Page, byId: Map<string, Page>): Page[] {
  const chain: Page[] = [];
  const seen = new Set<string>([page.id]);
  let parent = page.parentId === null ? undefined : byId.get(page.parentId);
  while (parent && !seen.has(parent.id)) {
    chain.unshift(parent);
    seen.add(parent.id);
    parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
  }
  return chain;
}

/**
 * The first line of a page, as a short description for search engines.
 *
 * Every link is reduced to the words around it. A link's target can be the id
 * of a page that is not published, and the description is served to everyone,
 * so nothing that looks like a target survives this.
 */
function summaryOf(page: Page): string {
  const line = page.body
    .split(/\r?\n/)
    .map((text) =>
      text
        .replace(/^#+\s*/, "")
        .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
        .replace(/\[\[[^\]]*\]\]/g, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find((text) => text !== "" && !text.startsWith("```"));
  return (line ?? page.title).slice(0, 200);
}

/**
 * A page's sources, as schema.org `citation` and `isBasedOn` (ADR-039), for a
 * machine reader that follows structured data rather than prose. `null` when
 * the page has no sources: an empty block would say nothing an absent one
 * doesn't.
 */
function citationJsonLd(page: Page): Record<string, unknown> | null {
  if (page.sources.length === 0) return null;
  const citation = page.sources.map((source) => {
    const href = sourceHref(source);
    return href ? { "@type": "CreativeWork", url: href, name: source } : source;
  });
  const isBasedOn = page.sources
    .map((source) => sourceHref(source))
    .filter((href): href is string => href !== null && isCairnPageAddress(href));
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    citation,
    ...(isBasedOn.length > 0 ? { isBasedOn } : {}),
  };
}

/**
 * Every other Cairn this one's published pages cite (ADR-041), as origins:
 * the same `isBasedOn` addresses `citationJsonLd` computes per page (ADR-039),
 * reduced to their origin and deduplicated across the whole published set.
 * Sorted so the field is stable across requests.
 */
function citedCairnOrigins(pages: readonly Page[]): string[] {
  const origins = new Set<string>();
  for (const page of pages) {
    for (const source of page.sources) {
      const href = sourceHref(source);
      if (href && isCairnPageAddress(href)) origins.add(new URL(href).origin);
    }
  }
  return [...origins].sort();
}

const Shell: FC<{
  title: string;
  description: string;
  canonical: string;
  licence: string | null;
  jsonLd?: Record<string, unknown> | null;
  children: Child;
}> = ({ title, description, canonical, licence, jsonLd, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      {raw(HEAD_TAGS)}
      <title>{documentTitle(title)}</title>
      <meta name="description" content={description} />
      {canonical === "" ? null : <link rel="canonical" href={canonical} />}
      <link rel="stylesheet" href={`/assets/console.css?v=${ASSET_VERSION}`} />
      {jsonLd ? raw(`<script type="application/ld+json">${jsonLdEscape(JSON.stringify(jsonLd))}</script>`) : null}
    </head>
    <body>
      <div class="ak-wrap">
        <header class="cairn-top">
          <a class="cairn-brand" href="/w">
            Cairn
          </a>
          <nav aria-label="Sections">
            <a href="/w">Published pages</a>
          </nav>
        </header>
        <main>{children}</main>
        <footer class="ak-footer">
          {licence ? <p>Text on these pages: {licence}.</p> : null}
          <p>Published from a Cairn. Only pages the owner marked public are here.</p>
        </footer>
      </div>
    </body>
  </html>
);

const SourceList: FC<{ sources: readonly string[] }> = ({ sources }) => (
  <ul class="cairn-sources">
    {sources.map((source) => {
      const href = sourceHref(source);
      return <li>{href ? <a href={href} rel="noopener noreferrer nofollow">{source}</a> : source}</li>;
    })}
  </ul>
);

export function registerPublicWiki(app: Hono, options: PublicWikiOptions): void {
  const { context } = options;
  const licence = (options.contentLicence ?? "").trim() || null;
  /** The address this page has for the outside world, for canonical and sitemap. */
  const origin = (c: Context) => options.publicOrigin ?? new URL(c.req.url).origin;

  const render = async (c: Context, element: Child, status: 200 | 404 = 200) => {
    const body = await (element as Promise<string> | string);
    return c.html(`<!doctype html>${body}`, status);
  };

  /** The one 404 this surface has. It never says whether the id exists. */
  const missing = (c: Context) =>
    render(
      c,
      <Shell
        title="Not found"
        description="No published page has that address."
        canonical=""
        licence={licence}
      >
        <h1>Not found</h1>
        <p class="ak-lede">
          No published page has that address. It may never have existed, or it may not be published.
        </p>
        <p>
          <a class="ak-btn" href="/w">
            Published pages
          </a>
        </p>
      </Shell>,
      404,
    );

  app.get("/w", async (c) => {
    const allPublished = await published(context);
    const tokenPageIds = await activeTokenPageIds(context);
    // A token-gated subtree does not appear in the listing at all (ADR-066
    // decision 7's reasoning, applied here too): nothing a stranger can
    // browse to should point at something they cannot read without a token.
    const gated = gatedIds(allPublished, tokenPageIds);
    const pages = allPublished.filter((page) => !gated.has(page.id));
    // The shortest honest list of what is here: everything else hangs below
    // one of these roots.
    const roots = rootsOf(pages);
    const childrenOf = (id: string) => pages.filter((page) => page.parentId === id);

    return render(
      c,
      <Shell
        title="Published pages"
        description="The pages this Cairn publishes, free to read."
        canonical={`${origin(c)}/w`}
        licence={licence}
      >
        <h1>Published pages</h1>
        {roots.length === 0 ? (
          <p class="ak-lede">Nothing is published here yet.</p>
        ) : (
          <p class="ak-lede">
            {pages.length} {pages.length === 1 ? "page" : "pages"}, free to read.
          </p>
        )}
        {roots.map((root) => (
          <section class="ak-section">
            <h2>
              <a href={wikiHref(root.id)}>{root.title}</a>
            </h2>
            <p class="ak-small">
              Updated <When at={root.updatedAt} />
            </p>
            <ul>
              {childrenOf(root.id).map((child) => (
                <li>
                  <a href={wikiHref(child.id)}>{child.title}</a>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </Shell>,
    );
  });

  app.get("/w/:id", async (c) => {
    const pages = await published(context);
    const byId = new Map(pages.map((page) => [page.id, page]));
    const page = byId.get(c.req.param("id"));
    if (!page) return missing(c);

    // A token-gated page answers the same 404 as a nonexistent one to a
    // stranger with no or the wrong token (ADR-066 decision 4): which of the
    // two is true would itself be a leak, same reasoning as `missing`.
    const tokenPageIds = await activeTokenPageIds(context);
    const gateRoot = gateRootOf(page.id, pages, tokenPageIds);
    const presented = presentedToken(c);
    if (gateRoot && !(presented && (await verifyPublishToken(context, gateRoot.id, presented)))) return missing(c);

    const gated = gatedIds(pages, tokenPageIds);
    const links = resolverFor(pages, gated, presented);
    const attachments = await attachmentResolverFor(context, page);
    const children = pages.filter((child) => child.parentId === page.id);
    const trail = ancestorsOf(page, byId);
    const citedBy = await citedByOf(context, page.id);

    return render(
      c,
      <Shell
        title={page.title}
        description={summaryOf(page)}
        canonical={`${origin(c)}${wikiHref(page.id)}`}
        licence={licence}
        jsonLd={citationJsonLd(page)}
      >
        <article>
          {trail.length === 0 ? null : (
            <ol class="ak-breadcrumb">
              {trail.map((ancestor) => (
                <li>
                  <a href={wikiHref(ancestor.id, gated.has(ancestor.id) ? presented : null)}>{ancestor.title}</a>
                </li>
              ))}
              <li aria-current="page">{page.title}</li>
            </ol>
          )}
          <header class="ak-pagehead">
            <div>
              <h1>{page.title}</h1>
              {/* Times, never names: who wrote a page is not published (ADR-032 decision 4). */}
              <p class="ak-small">
                Updated <When at={page.updatedAt} />
              </p>
            </div>
          </header>
          <div class="ak-prose">
            {page.body.trim() === "" ? (
              <p class="ak-soft">This page is empty.</p>
            ) : (
              raw(renderMarkdown(page.body, links, attachments))
            )}
          </div>
          {page.sources.length === 0 ? null : (
            <section class="ak-section" aria-labelledby="cairn-sources">
              <h2 id="cairn-sources">Sources</h2>
              <SourceList sources={page.sources} />
            </section>
          )}
          {citedBy.length === 0 ? null : (
            <section class="ak-section" aria-labelledby="cairn-cited-by">
              <h2 id="cairn-cited-by">Cited by</h2>
              <ul class="cairn-sources">
                {citedBy.map((source) => (
                  <li>
                    <a href={source} rel="noopener noreferrer nofollow">
                      {source}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {children.length === 0 ? null : (
            <section class="ak-section" aria-labelledby="cairn-children">
              <h2 id="cairn-children">Pages under this one</h2>
              <ul>
                {children.map((child) => (
                  <li>
                    <a href={wikiHref(child.id, gated.has(child.id) ? presented : null)}>{child.title}</a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </article>
      </Shell>,
    );
  });

  // A Webmention-shaped citation notice (ADR-040): another site telling this
  // Cairn it links to one of its published pages. The only route on this
  // surface that accepts a write, and the only place this server fetches an
  // address it did not choose itself; `citations.ts` carries the SSRF guard.
  app.post("/webmention", async (c) => {
    const form = await c.req.parseBody();
    const source = typeof form["source"] === "string" ? form["source"] : null;
    const target = typeof form["target"] === "string" ? form["target"] : null;
    if (!source || !target) {
      return c.text("a webmention notice needs both source and target as form fields", 400);
    }
    let targetUrl: URL;
    try {
      targetUrl = new URL(target);
    } catch {
      return c.text(`target (${target}) is not a valid URL`, 400);
    }
    if (targetUrl.origin !== origin(c)) {
      return c.text(`target (${target}) is not an address of this Cairn (${origin(c)})`, 400);
    }
    const match = /^\/w\/([A-Za-z0-9_-]+)\/?$/.exec(targetUrl.pathname);
    if (!match) {
      return c.text(`target (${target}) is not shaped like a published page's address (${origin(c)}/w/<id>)`, 400);
    }
    const pageId = decodeURIComponent(match[1]!);
    const pages = await published(context);
    if (!pages.some((page) => page.id === pageId)) {
      return c.text(`target (${target}) is not a page this Cairn currently publishes`, 400);
    }
    try {
      const result = await receiveCitation(context, { pageId, source, target });
      return c.text(`recorded: ${result.status}`, 202);
    } catch (error) {
      return c.text(error instanceof WebmentionError ? error.message : "could not verify the notice", 400);
    }
  });

  // One flat sitemap. A wiki large enough to need the index format is past
  // what this serves well anyway (ADR-032 consequence 4).
  app.get("/sitemap.xml", async (c) => {
    // Same rule as /w and /.well-known/cairn.json (ADR-066 decision 7): a
    // crawler-facing surface never names a page it cannot then read.
    const allPublished = await published(context);
    const gated = gatedIds(allPublished, await activeTokenPageIds(context));
    const pages = allPublished.filter((page) => !gated.has(page.id));
    const base = origin(c);
    const urls = [
      `<url><loc>${escapeXml(`${base}/w`)}</loc></url>`,
      ...pages.map(
        (page) =>
          `<url><loc>${escapeXml(`${base}${wikiHref(page.id)}`)}</loc>` +
          `<lastmod>${page.updatedAt.slice(0, 10)}</lastmod></url>`,
      ),
    ];
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`,
      200,
      { "content-type": "application/xml; charset=utf-8" },
    );
  });

  // IndexNow ownership proof (ADR-074): served only when CAIRN_INDEXNOW_KEY
  // is set, at the exact path IndexNow checks before accepting a submission.
  // No auth: the file is only ever useful to prove what the owner already
  // configured, the same reasoning as the rest of this public surface.
  if (options.indexNowKey) {
    const key = options.indexNowKey;
    app.get(`/${key}.txt`, (c) => c.body(key, 200, { "content-type": "text/plain; charset=utf-8" }));
  }

  // Crawlers get the published wiki and nothing else. The rest needs sign-in
  // regardless; saying so keeps well-behaved crawlers out of the sign-in page.
  app.get("/robots.txt", (c) =>
    c.body(
      ["User-agent: *", "Allow: /w", "Disallow: /", `Sitemap: ${origin(c)}/sitemap.xml`, ""].join("\n"),
      200,
      { "content-type": "text/plain; charset=utf-8" },
    ),
  );

  // What this Cairn is, for a registry or a crawler that follows citations
  // between Cairns (ADR-034). No sign-in, same as the rest of this surface.
  // `collections` is built from the published set, so it names nothing that
  // is not already on /w.
  app.get("/.well-known/cairn.json", async (c) => {
    const allPublished = await published(context);
    const gated = gatedIds(allPublished, await activeTokenPageIds(context));
    const pages = allPublished.filter((page) => !gated.has(page.id));
    const base = origin(c);
    const self = options.selfDescription ?? { name: "Cairn", description: null, language: "en", topics: null };
    const body: Record<string, unknown> = {
      cairn: "1",
      name: self.name,
      ...(self.description ? { description: self.description } : {}),
      language: self.language,
      ...(licence ? { licence } : {}),
      ...(self.topics ? { topics: self.topics } : {}),
      collections: rootsOf(pages).map((root) => ({ title: root.title, url: `${base}${wikiHref(root.id)}` })),
      sitemap: `${base}/sitemap.xml`,
      // Which other Cairns this one's published pages cite, by origin
      // (ADR-034 consequence 3, filled in by ADR-041).
      cites: citedCairnOrigins(pages),
    };
    return c.body(JSON.stringify(body, null, 2), 200, { "content-type": "application/json; charset=utf-8" });
  });
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Escapes what would otherwise close the `<script>` tag a JSON-LD block sits in. */
function jsonLdEscape(json: string): string {
  return json.replace(/</g, "\\u003c");
}
