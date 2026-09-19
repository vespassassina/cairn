import { describe, expect, it } from "vitest";
import { gatedIds, gateRootOf, publishedIds } from "../src/publish.js";
import type { Page } from "../src/types.js";

/**
 * Which pages are published (ADR-032). The rule is small and the cost of
 * getting it wrong is a leak, so every shape the tree can take is here,
 * including the broken ones.
 */

function page(id: string, parentId: string | null, isPublic = false): Page {
  return {
    id,
    workspaceId: "ws",
    title: id,
    body: "",
    tags: [],
    sources: [],
    parentId,
    public: isPublic,
    version: "v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    editedAt: "2026-01-01T00:00:00.000Z",
    verifiedAt: null,
    updatedBy: { kind: "user", id: "owner", label: "Owner" },
  } as Page;
}

const published = (pages: Page[]) => [...publishedIds(pages)].sort();

describe("publishedIds", () => {
  it("publishes nothing until a page says so", () => {
    expect(published([page("a", null), page("b", "a")])).toEqual([]);
  });

  it("publishes a marked page and everything under it", () => {
    const pages = [page("a", null, true), page("b", "a"), page("c", "b"), page("d", null)];
    expect(published(pages)).toEqual(["a", "b", "c"]);
  });

  it("does not publish a page above the one that was marked", () => {
    expect(published([page("a", null), page("b", "a", true)])).toEqual(["b"]);
  });

  it("treats a page whose parent is missing as private", () => {
    expect(published([page("b", "gone")])).toEqual([]);
  });

  it("treats a loop as private rather than guessing", () => {
    const pages = [page("a", "b"), page("b", "a")];
    expect(published(pages)).toEqual([]);
  });

  it("still publishes a page marked public inside a loop", () => {
    const pages = [page("a", "b", true), page("b", "a")];
    expect(published(pages)).toEqual(["a", "b"]);
  });
});

describe("gateRootOf", () => {
  it("gates nothing when no page carries a token", () => {
    const pages = [page("a", null, true), page("b", "a")];
    expect(gateRootOf("b", pages, new Set())).toBeNull();
  });

  it("gates the page itself when the token is issued there", () => {
    const pages = [page("a", null, true)];
    expect(gateRootOf("a", pages, new Set(["a"]))?.id).toBe("a");
  });

  it("gates a descendant from an ancestor's token, not from its own", () => {
    const pages = [page("a", null, true), page("b", "a"), page("c", "b")];
    expect(gateRootOf("c", pages, new Set(["a"]))?.id).toBe("a");
  });

  it("finds the nearest gated ancestor, not the furthest", () => {
    const pages = [page("a", null, true), page("b", "a"), page("c", "b")];
    expect(gateRootOf("c", pages, new Set(["a", "b"]))?.id).toBe("b");
  });

  it("does not gate a sibling subtree", () => {
    const pages = [page("a", null, true), page("b", "a"), page("c", "a")];
    expect(gateRootOf("c", pages, new Set(["b"]))).toBeNull();
  });

  it("treats a page whose parent is missing as ungated rather than guessing", () => {
    expect(gateRootOf("b", [page("b", "gone")], new Set(["gone"]))).toBeNull();
  });

  it("treats a loop as ungated rather than guessing", () => {
    const pages = [page("a", "b"), page("b", "a")];
    expect(gateRootOf("a", pages, new Set())).toBeNull();
  });

  it("still finds a token inside a loop", () => {
    const pages = [page("a", "b"), page("b", "a")];
    expect(gateRootOf("a", pages, new Set(["b"]))?.id).toBe("b");
  });
});

describe("gatedIds", () => {
  it("is empty when nothing carries a token", () => {
    const pages = [page("a", null, true), page("b", "a")];
    expect(gatedIds(pages, new Set())).toEqual(new Set());
  });

  it("covers a gated page's whole subtree", () => {
    const pages = [page("a", null, true), page("b", "a"), page("c", "b"), page("d", null, true)];
    expect(gatedIds(pages, new Set(["a"]))).toEqual(new Set(["a", "b", "c"]));
  });
});
