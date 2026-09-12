import { describe, expect, it } from "vitest";
import { chunkPage, extractReferences, type Page } from "../src/index.js";

function page(body: string, overrides: Partial<Page> = {}): Page {
  return {
    id: "pg_self",
    workspaceId: "ws",
    title: "Self",
    parentId: null,
    tags: [],
    body,
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    version: "v1",
    ...overrides,
  };
}

describe("extractReferences", () => {
  it("reads markdown links in both supported forms", () => {
    const { edges } = extractReferences(
      page("See [the log](cairn:pg_log) and [parts](/pages/pg_parts)."),
    );
    expect(edges.filter((e) => e.type === "link")).toEqual([
      { sourceId: "pg_self", targetId: "pg_log", type: "link", label: "the log" },
      { sourceId: "pg_self", targetId: "pg_parts", type: "link", label: "parts" },
    ]);
  });

  it("reads wiki links with and without a label", () => {
    const { edges } = extractReferences(page("[[pg_a]] and [[pg_b|Bee]]"));
    const links = edges.filter((e) => e.type === "link");
    expect(links.map((e) => [e.targetId, e.label])).toEqual([
      ["pg_a", null],
      ["pg_b", "Bee"],
    ]);
  });

  it("separates mentions from links", () => {
    const { edges } = extractReferences(page("asked @pg_diego about it"));
    expect(edges).toContainEqual({
      sourceId: "pg_self",
      targetId: "pg_diego",
      type: "mention",
      label: null,
    });
  });

  it("takes tags from the body and the page, and never from a heading", () => {
    const { tags } = extractReferences(
      page("# Heading\n\nprinted in #petg and #abs", { tags: ["gear"] }),
    );
    expect(tags.sort()).toEqual(["abs", "gear", "petg"]);
  });

  it("ignores links and tags inside code", () => {
    const { edges, tags } = extractReferences(
      page("```\n[[pg_fake]] #notatag\n```\ninline `[[pg_also_fake]]` too"),
    );
    expect(edges.filter((e) => e.type === "link")).toHaveLength(0);
    expect(tags).toEqual([]);
  });

  it("records the parent as an edge", () => {
    const { edges } = extractReferences(page("", { parentId: "pg_parent" }));
    expect(edges).toContainEqual({
      sourceId: "pg_self",
      targetId: "pg_parent",
      type: "parent",
      label: null,
    });
  });

  it("deduplicates repeated links and drops self links", () => {
    const { edges } = extractReferences(
      page("[[pg_a]] again [[pg_a]] and myself [[pg_self]]"),
    );
    expect(edges.filter((e) => e.type === "link")).toHaveLength(1);
  });

  it("is deterministic, so a rebuild produces the same edges", () => {
    const input = page("[[pg_a]] #tag @pg_b", { parentId: "pg_p" });
    expect(extractReferences(input)).toEqual(extractReferences(input));
  });
});

describe("chunkPage", () => {
  it("splits on headings and records the path", () => {
    const chunks = chunkPage(
      page("intro text\n\n# Failures\n\nbed adhesion\n\n## Fixes\n\nbrim helped"),
    );
    expect(chunks.map((c) => c.headingPath)).toEqual([
      ["Self"],
      ["Self", "Failures"],
      ["Self", "Failures", "Fixes"],
    ]);
    expect(chunks[1]!.text).toBe("bed adhesion");
  });

  it("keeps sibling sections side by side when the page starts below H1", () => {
    const chunks = chunkPage(
      page("tagline\n\n## Status\n\nresearch only\n\n## Origin\n\ngastric\n\n### Detail\n\nfragment\n\n## Stacks\n\nwolverine"),
    );
    expect(chunks.map((c) => c.headingPath)).toEqual([
      ["Self"],
      ["Self", "Status"],
      ["Self", "Origin"],
      ["Self", "Origin", "Detail"],
      ["Self", "Stacks"],
    ]);
  });

  it("does not repeat the title when the body opens with a matching H1", () => {
    const chunks = chunkPage(
      page("# Self\n\nintro\n\n## Detail\n\nmore", { title: "Self" }),
    );
    expect(chunks.map((c) => c.headingPath)).toEqual([
      ["Self"],
      ["Self", "Detail"],
    ]);
  });

  it("numbers chunks in document order with derived ids", () => {
    const chunks = chunkPage(page("a\n\n# One\n\nb\n\n# Two\n\nc"));
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
    expect(chunks.map((c) => c.id)).toEqual([
      "pg_self:0",
      "pg_self:1",
      "pg_self:2",
    ]);
  });

  it("produces identical output for identical input", () => {
    const input = page("# A\n\none\n\n# B\n\ntwo");
    expect(chunkPage(input)).toEqual(chunkPage(input));
  });

  it("splits an oversized section and overlaps the seam", () => {
    const paragraph = "word ".repeat(60).trim();
    const chunks = chunkPage(page([paragraph, paragraph, paragraph].join("\n\n")), {
      maxChars: 320,
      overlapChars: 20,
    });
    expect(chunks.length).toBeGreaterThan(1);
    const tail = chunks[0]!.text.slice(-20);
    expect(chunks[1]!.text.startsWith(tail)).toBe(true);
  });

  it("hard splits a single paragraph longer than the limit", () => {
    const chunks = chunkPage(page("x".repeat(1000)), {
      maxChars: 100,
      overlapChars: 0,
    });
    expect(chunks).toHaveLength(10);
  });

  it("keeps an empty page findable by its title", () => {
    const chunks = chunkPage(page("   \n\n  ", { title: "Empty page" }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("Empty page");
  });
});
