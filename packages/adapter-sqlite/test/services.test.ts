import { beforeEach, describe, expect, it } from "vitest";
import {
  CollectionService,
  PageService,
  ValidationError,
  VersionConflictError,
  type Page,
} from "@cairn/core";
import { eventually } from "@cairn/core/testing";
import { SqliteDocumentStore, SqliteSearchIndex } from "../src/index.js";

/**
 * End-to-end checks of the write path against a real adapter: page, then
 * derived data, then the rebuild that repairs it (ADR-005 rules 2 and 3).
 */

const WS = "ws_services";

describe("PageService and CollectionService on sqlite", () => {
  let store: SqliteDocumentStore;
  let search: SqliteSearchIndex;
  let pages: PageService;
  let collections: CollectionService;

  beforeEach(async () => {
    store = new SqliteDocumentStore();
    search = new SqliteSearchIndex();
    await store.init();
    await search.init();
    pages = new PageService(store, search);
    collections = new CollectionService(store);
  });

  it("indexes a page for search and backlinks when it is created", async () => {
    await pages.create(WS, { title: "Target", body: "a target page" }, "pg_target");
    await pages.create(
      WS,
      { title: "Print log", body: "# Failures\n\nbed adhesion, see [[pg_target]]" },
      "pg_log",
    );

    await eventually(async () => {
      const hits = (await search.search(WS, { query: "adhesion" })).hits;
      expect(hits.map((h) => h.pageId)).toContain("pg_log");
      expect(hits[0]!.headingPath).toEqual(["Print log", "Failures"]);
    });

    const backlinks = await pages.backlinks(WS, "pg_target");
    expect(backlinks.map((e) => e.sourceId)).toEqual(["pg_log"]);
  });

  it("drops a backlink when the link is removed (PRD P0.3)", async () => {
    const page = await pages.create(
      WS,
      { title: "Log", body: "links to [[pg_target]]" },
      "pg_log",
    );
    expect(await pages.backlinks(WS, "pg_target")).toHaveLength(1);

    await pages.update(WS, page.id, { title: "Log", body: "no links now" }, page.version);
    expect(await pages.backlinks(WS, "pg_target")).toHaveLength(0);
  });

  it("reindexes on update instead of accumulating chunks", async () => {
    const page = await pages.create(
      WS,
      { title: "Notes", body: "original nozzle text" },
      "pg_notes",
    );
    await pages.update(
      WS,
      page.id,
      { title: "Notes", body: "rewritten hotend text" },
      page.version,
    );

    const nozzle = await search.search(WS, { query: "nozzle" });
    expect(nozzle.hits).toHaveLength(0);
    const hotend = await search.search(WS, { query: "hotend" });
    expect(hotend.hits.map((h) => h.pageId)).toEqual(["pg_notes"]);
  });

  it("rejects a stale update and hands back the current page to merge", async () => {
    const first = await pages.create(WS, { title: "A", body: "one" }, "pg_conflict");
    await pages.update(WS, first.id, { title: "B", body: "two" }, first.version);

    const error = await pages
      .update(WS, first.id, { title: "C", body: "three" }, first.version)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VersionConflictError);
    expect((error as VersionConflictError<Page>).current?.title).toBe("B");
  });

  it("removes derived data when a page is deleted", async () => {
    const page = await pages.create(
      WS,
      { title: "Doomed", body: "ephemeral [[pg_target]]" },
      "pg_doomed",
    );
    await pages.delete(WS, page.id, page.version);

    expect(await pages.backlinks(WS, "pg_target")).toHaveLength(0);
    expect((await search.search(WS, { query: "ephemeral" })).hits).toHaveLength(0);
  });

  it("rebuilds every edge and chunk from the pages alone (PRD P0.9)", async () => {
    await pages.create(WS, { title: "Target", body: "target" }, "pg_target");
    await pages.create(
      WS,
      { title: "Log", body: "# Failures\n\nadhesion, see [[pg_target]]" },
      "pg_log",
    );
    const before = {
      backlinks: await pages.backlinks(WS, "pg_target"),
      hits: (await search.search(WS, { query: "adhesion" })).hits,
    };

    // Simulate derived data lost or corrupted, as a crash between the two
    // writes would leave it.
    await store.replaceEdgesForSource(WS, "pg_log", []);
    await search.deleteChunksForPage(WS, "pg_log");
    expect(await pages.backlinks(WS, "pg_target")).toHaveLength(0);

    const result = await pages.rebuildWorkspace(WS);
    expect(result.pages).toBe(2);
    expect(await pages.backlinks(WS, "pg_target")).toEqual(before.backlinks);
    expect((await search.search(WS, { query: "adhesion" })).hits).toEqual(before.hits);
  });

  it("leaves the pages themselves untouched by a rebuild", async () => {
    const page = await pages.create(WS, { title: "Stable", body: "unchanged" }, "pg_stable");
    await pages.rebuildWorkspace(WS);
    expect(await pages.get(WS, page.id)).toEqual(page);
  });

  it("validates a row before writing it, naming every bad field", async () => {
    const collection = await collections.create(
      WS,
      {
        name: "Prints",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "printed", type: "date", required: true },
        ],
      },
      "col_prints",
    );

    const error = await collections
      .upsertRow(WS, collection.id, { values: { title: "Bracket" } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).errors).toEqual([
      { field: "printed", message: "required" },
    ]);

    const row = await collections.upsertRow(WS, collection.id, {
      values: { title: "Bracket", printed: "2026-09-01" },
    });
    expect(await collections.getRow(WS, collection.id, row.id)).toEqual(row);
  });

  it("filters and sorts rows in core when the adapter has no pushdown", async () => {
    expect(store.capabilities.rowQueryPushdown).toBe(false);
    const collection = await collections.create(
      WS,
      {
        name: "Parts",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "grams", type: "number" },
        ],
      },
      "col_parts",
    );
    for (const [title, grams] of [
      ["Bracket", 12.5],
      ["Spacer", 4],
      ["Enclosure", 210],
    ] as const) {
      await collections.upsertRow(WS, collection.id, { values: { title, grams } });
    }

    const heavy = await collections.queryRows(WS, collection.id, {
      where: [{ field: "grams", op: "gt", value: 10 }],
      sort: [{ field: "grams", direction: "desc" }],
    });
    expect(heavy.items.map((r) => r.values["title"])).toEqual(["Enclosure", "Bracket"]);
  });
});
