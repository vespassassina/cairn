import { describe, expect, it } from "vitest";
import type { ExportPage } from "../src/export-format.js";
import {
  escapeHtml,
  indexPages,
  relativeHref,
  renderBody,
  renderIndex,
  renderPage,
  sitemapXml,
  sitePaths,
  trailOf,
} from "../src/site-format.js";

/** The static site export format (ADR-035): Markdown to HTML, and the paths and links around it. */

describe("escapeHtml", () => {
  it("escapes the five HTML special characters", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry's&lt;/a&gt;");
  });
});

describe("renderBody", () => {
  const noLinks = () => null;

  it("renders headings, bold, italic and inline code", () => {
    expect(renderBody("# Title", noLinks)).toBe("<h1>Title</h1>");
    expect(renderBody("## Sub", noLinks)).toBe("<h2>Sub</h2>");
    expect(renderBody("**bold** and *italic* and `code`", noLinks)).toBe("<p><strong>bold</strong> and <em>italic</em> and <code>code</code></p>");
  });

  it("escapes HTML found in the text", () => {
    expect(renderBody("<script>alert(1)</script>", noLinks)).toContain("&lt;script&gt;");
  });

  it("renders fenced code blocks verbatim, without inline formatting", () => {
    expect(renderBody("```\n**not bold**\n<b>x</b>\n```", noLinks)).toBe("<pre><code>**not bold**\n&lt;b&gt;x&lt;/b&gt;</code></pre>");
  });

  it("renders bullet and ordered lists", () => {
    expect(renderBody("- a\n- b", noLinks)).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderBody("1. a\n2. b", noLinks)).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("joins paragraph lines with a line break, and separates paragraphs on a blank line", () => {
    expect(renderBody("line one\nline two\n\nnext paragraph", noLinks)).toBe("<p>line one<br>line two</p>\n<p>next paragraph</p>");
  });

  it("resolves wiki links through the given resolver, and shows the id as text when there is no target", () => {
    const resolve = (id: string) => (id === "pg_a" ? "pages/a.html" : null);
    expect(renderBody("See [[pg_a|A page]].", resolve)).toBe('<p>See <a href="pages/a.html">A page</a>.</p>');
    expect(renderBody("See [[pg_a]].", resolve)).toBe('<p>See <a href="pages/a.html">pg_a</a>.</p>');
    expect(renderBody("See [[pg_gone]].", resolve)).toBe("<p>See pg_gone.</p>");
  });

  it("renders http(s) and mailto links, but leaves an unsafe scheme as plain text", () => {
    expect(renderBody("[docs](https://example.com)", noLinks)).toContain('<a href="https://example.com" rel="noopener noreferrer nofollow" target="_blank">docs</a>');
    expect(renderBody("[me](mailto:a@b.com)", noLinks)).toContain('<a href="mailto:a@b.com">me</a>');
    expect(renderBody("[x](javascript:alert(1))", noLinks)).toBe("<p>[x](javascript:alert(1))</p>");
  });
});

describe("sitePaths", () => {
  it("mirrors assignPaths, with .html instead of .md", () => {
    const pages: ExportPage[] = [
      { id: "pg_a", title: "Notes", parent_id: null, tags: [], body: "" },
      { id: "pg_b", title: "Child", parent_id: "pg_a", tags: [], body: "" },
    ];
    const paths = sitePaths(pages);
    expect(paths.get("pg_a")).toBe("pages/notes.html");
    expect(paths.get("pg_b")).toBe("pages/notes/child.html");
  });
});

describe("relativeHref", () => {
  it("gives a relative, forward-slash path between two site paths", () => {
    expect(relativeHref("pages/notes.html", "pages/notes/child.html")).toBe("notes/child.html");
    expect(relativeHref("pages/notes/child.html", "pages/notes.html")).toBe("../notes.html");
    expect(relativeHref("pages/notes.html", "index.html")).toBe("../index.html");
  });
});

describe("indexPages", () => {
  it("groups pages by parent, and pages with no known parent become roots", () => {
    const pages: ExportPage[] = [
      { id: "pg_a", title: "A", parent_id: null, tags: [], body: "" },
      { id: "pg_b", title: "B", parent_id: "pg_a", tags: [], body: "" },
      { id: "pg_c", title: "C", parent_id: "pg_gone", tags: [], body: "" },
    ];
    const { childrenOf, roots } = indexPages(pages);
    expect(roots.map((p) => p.id)).toEqual(["pg_a", "pg_c"]);
    expect(childrenOf.get("pg_a")!.map((p) => p.id)).toEqual(["pg_b"]);
  });
});

describe("trailOf", () => {
  it("lists ancestors outermost first", () => {
    const pages: ExportPage[] = [
      { id: "pg_a", title: "A", parent_id: null, tags: [], body: "" },
      { id: "pg_b", title: "B", parent_id: "pg_a", tags: [], body: "" },
      { id: "pg_c", title: "C", parent_id: "pg_b", tags: [], body: "" },
    ];
    const byId = new Map(pages.map((p) => [p.id, p]));
    expect(trailOf(pages[2]!, byId).map((p) => p.id)).toEqual(["pg_a", "pg_b"]);
    expect(trailOf(pages[0]!, byId)).toEqual([]);
  });

  it("stops rather than loop, if the data has a cycle", () => {
    const a: ExportPage = { id: "pg_a", title: "A", parent_id: "pg_b", tags: [], body: "" };
    const b: ExportPage = { id: "pg_b", title: "B", parent_id: "pg_a", tags: [], body: "" };
    const byId = new Map([
      ["pg_a", a],
      ["pg_b", b],
    ]);
    expect(trailOf(a, byId)).toEqual([b]);
  });
});

describe("sitemapXml", () => {
  it("lists the index and every page under the given base address", () => {
    const pages: ExportPage[] = [{ id: "pg_a", title: "A", parent_id: null, tags: [], body: "" }];
    const pathOf = new Map([["pg_a", "pages/a.html"]]);
    const xml = sitemapXml(pages, pathOf, "https://example.com/wiki/");
    expect(xml).toContain("<loc>https://example.com/wiki/index.html</loc>");
    expect(xml).toContain("<loc>https://example.com/wiki/pages/a.html</loc>");
  });
});

describe("renderIndex", () => {
  it("lists the top-level collections", () => {
    const roots: ExportPage[] = [{ id: "pg_a", title: "Notes", parent_id: null, tags: [], body: "" }];
    const pathOf = new Map([["pg_a", "pages/notes.html"]]);
    const html = renderIndex(roots, pathOf);
    expect(html).toContain('<a href="pages/notes.html">Notes</a>');
  });

  it("says so plainly when nothing was exported", () => {
    expect(renderIndex([], new Map())).toContain("Nothing was exported.");
  });
});

describe("renderPage", () => {
  it("renders a breadcrumb trail, the body, sources and child pages", () => {
    const root: ExportPage = { id: "pg_a", title: "Root", parent_id: null, tags: [], body: "Top." };
    const child: ExportPage = {
      id: "pg_b",
      title: "Child",
      parent_id: "pg_a",
      tags: [],
      body: "See [[pg_a|Root]].",
      sources: ["https://example.com/source"],
    };
    const pathOf = new Map([
      ["pg_a", "pages/root.html"],
      ["pg_b", "pages/root/child.html"],
    ]);
    const html = renderPage({
      page: child,
      path: "pages/root/child.html",
      pathOf,
      childrenOf: new Map(),
      trail: [root],
    });
    expect(html).toContain('<a href="../root.html">Root</a>');
    expect(html).toContain("<h1>Child</h1>");
    expect(html).toContain('<a href="https://example.com/source"');
  });

  it("carries sources as JSON-LD citation and isBasedOn (ADR-039)", () => {
    const page: ExportPage = {
      id: "pg_a",
      title: "Built on a friend's work",
      parent_id: null,
      tags: [],
      body: "See the original.",
      sources: ["https://other.example.com/w/pg_notes", "Smith 2021, J Pept Sci"],
    };
    const html = renderPage({
      page,
      path: "pages/root.html",
      pathOf: new Map([["pg_a", "pages/root.html"]]),
      childrenOf: new Map(),
      trail: [],
    });
    const match = html.match(/<script type="application\/ld\+json">([^<]*)<\/script>/);
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

  it("omits the JSON-LD block for a page with no sources", () => {
    const page: ExportPage = { id: "pg_a", title: "No sources", parent_id: null, tags: [], body: "Plain." };
    const html = renderPage({ page, path: "pages/root.html", pathOf: new Map([["pg_a", "pages/root.html"]]), childrenOf: new Map(), trail: [] });
    expect(html).not.toContain("application/ld+json");
  });

  it("says a page is empty rather than rendering nothing", () => {
    const page: ExportPage = { id: "pg_a", title: "Empty", parent_id: null, tags: [], body: "   " };
    const html = renderPage({ page, path: "pages/empty.html", pathOf: new Map([["pg_a", "pages/empty.html"]]), childrenOf: new Map(), trail: [] });
    expect(html).toContain("This page is empty.");
  });
});
