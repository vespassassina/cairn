import { describe, expect, it } from "vitest";
import { publishedIds } from "../src/publish.js";
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
