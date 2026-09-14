/** @jsxImportSource hono/jsx */
import type { Context, Hono } from "hono";
import { raw } from "hono/html";
import type { Child, FC } from "hono/jsx";
import { isUrlSource, publishedIds, type Page, type Paged } from "@cairn/core";
import type { AppContext } from "../context.js";
import { ASSET_VERSION, documentTitle, HEAD_TAGS } from "./assets.js";
import { When } from "./layout.js";
import { createMarkdownRenderer, type LinkResolver } from "./markdown.js";

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
 */

export interface PublicWikiOptions {
  context: AppContext;
  /** The origin people reach this Cairn at, for canonical links and the sitemap. */
  publicOrigin?: string | null;
  /** The licence the owner puts on published pages (ADR-032 decision 7). */
  contentLicence?: string | null;
  /** How this Cairn describes itself at /.well-known/cairn.json (ADR-034). */
  selfDescription?: SelfDescription | null;
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

export const wikiHref = (pageId: string) => `/w/${encodeURIComponent(pageId)}`;

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
function resolverFor(pages: readonly Page[]): LinkResolver {
  const titles = new Map(pages.map((page) => [page.id, page.title]));
  return {
    title: (id) => titles.get(id) ?? null,
    href: (id) => (titles.has(id) ? wikiHref(id) : null),
    plainWhenUnknown: true,
  };
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

const Shell: FC<{
  title: string;
  description: string;
  canonical: string;
  licence: string | null;
  children: Child;
}> = ({ title, description, canonical, licence, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      {raw(HEAD_TAGS)}
      <title>{documentTitle(title)}</title>
      <meta name="description" content={description} />
      {canonical === "" ? null : <link rel="canonical" href={canonical} />}
      <link rel="stylesheet" href={`/assets/console.css?v=${ASSET_VERSION}`} />
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
    {sources.map((source) => (
      <li>
        {isUrlSource(source) ? (
          <a href={source} rel="noopener noreferrer nofollow">
            {source}
          </a>
        ) : (
          source
        )}
      </li>
    ))}
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
    const pages = await published(context);
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

    const links = resolverFor(pages);
    const children = pages.filter((child) => child.parentId === page.id);
    const trail = ancestorsOf(page, byId);

    return render(
      c,
      <Shell
        title={page.title}
        description={summaryOf(page)}
        canonical={`${origin(c)}${wikiHref(page.id)}`}
        licence={licence}
      >
        <article>
          {trail.length === 0 ? null : (
            <ol class="ak-breadcrumb">
              {trail.map((ancestor) => (
                <li>
                  <a href={wikiHref(ancestor.id)}>{ancestor.title}</a>
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
              raw(renderMarkdown(page.body, links))
            )}
          </div>
          {page.sources.length === 0 ? null : (
            <section class="ak-section" aria-labelledby="cairn-sources">
              <h2 id="cairn-sources">Sources</h2>
              <SourceList sources={page.sources} />
            </section>
          )}
          {children.length === 0 ? null : (
            <section class="ak-section" aria-labelledby="cairn-children">
              <h2 id="cairn-children">Pages under this one</h2>
              <ul>
                {children.map((child) => (
                  <li>
                    <a href={wikiHref(child.id)}>{child.title}</a>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </article>
      </Shell>,
    );
  });

  // One flat sitemap. A wiki large enough to need the index format is past
  // what this serves well anyway (ADR-032 consequence 4).
  app.get("/sitemap.xml", async (c) => {
    const pages = await published(context);
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
    const pages = await published(context);
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
      // Which Cairns this one cites. Always empty today: nothing yet tells a
      // citation in `sources` apart from an ordinary web link (ADR-034
      // consequence 3, roadmap "Bridges between Cairns").
      cites: [],
    };
    return c.body(JSON.stringify(body, null, 2), 200, { "content-type": "application/json; charset=utf-8" });
  });
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
