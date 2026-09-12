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
const OWNER = { actor: { kind: "user" as const, id: "owner", label: "Owner" } };
const AGENT = {
  actor: { kind: "agent" as const, id: "mcp:test", label: "claude-code/2.0" },
  note: "Summarised the print log",
};

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
    await pages.create(WS, { title: "Target", body: "a target page" }, OWNER, "pg_target");
    await pages.create(
      WS,
      { title: "Print log", body: "# Failures\n\nbed adhesion, see [[pg_target]]" },
      OWNER,
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
      OWNER,
      "pg_log",
    );
    expect(await pages.backlinks(WS, "pg_target")).toHaveLength(1);

    await pages.update(WS, page.id, { title: "Log", body: "no links now" }, page.version, OWNER);
    expect(await pages.backlinks(WS, "pg_target")).toHaveLength(0);
  });

  it("reindexes on update instead of accumulating chunks", async () => {
    const page = await pages.create(
      WS,
      { title: "Notes", body: "original nozzle text" },
      OWNER,
      "pg_notes",
    );
    await pages.update(
      WS,
      page.id,
      { title: "Notes", body: "rewritten hotend text" },
      page.version,
      OWNER,
    );

    const nozzle = await search.search(WS, { query: "nozzle" });
    expect(nozzle.hits).toHaveLength(0);
    const hotend = await search.search(WS, { query: "hotend" });
    expect(hotend.hits.map((h) => h.pageId)).toEqual(["pg_notes"]);
  });

  it("rejects a stale update and hands back the current page to merge", async () => {
    const first = await pages.create(WS, { title: "A", body: "one" }, OWNER, "pg_conflict");
    await pages.update(WS, first.id, { title: "B", body: "two" }, first.version, OWNER);

    const error = await pages
      .update(WS, first.id, { title: "C", body: "three" }, first.version, OWNER)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(VersionConflictError);
    expect((error as VersionConflictError<Page>).current?.title).toBe("B");
  });

  it("removes derived data when a page is deleted", async () => {
    const page = await pages.create(
      WS,
      { title: "Doomed", body: "ephemeral [[pg_target]]" },
      OWNER,
      "pg_doomed",
    );
    await pages.delete(WS, page.id, page.version, OWNER);

    expect(await pages.backlinks(WS, "pg_target")).toHaveLength(0);
    expect((await search.search(WS, { query: "ephemeral" })).hits).toHaveLength(0);
  });

  it("rebuilds every edge and chunk from the pages alone (PRD P0.9)", async () => {
    await pages.create(WS, { title: "Target", body: "target" }, OWNER, "pg_target");
    await pages.create(
      WS,
      { title: "Log", body: "# Failures\n\nadhesion, see [[pg_target]]" },
      OWNER,
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
    expect(result.orphanRevisions).toBe(0);
    expect(await pages.backlinks(WS, "pg_target")).toEqual(before.backlinks);
    expect((await search.search(WS, { query: "adhesion" })).hits).toEqual(before.hits);
  });

  it("leaves the pages themselves untouched by a rebuild", async () => {
    const page = await pages.create(WS, { title: "Stable", body: "unchanged" }, OWNER, "pg_stable");
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
      OWNER,
      "col_prints",
    );

    const error = await collections
      .upsertRow(WS, collection.id, { values: { title: "Bracket" } }, OWNER)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).errors).toEqual([
      { field: "printed", message: "required" },
    ]);

    const row = await collections.upsertRow(
      WS,
      collection.id,
      { values: { title: "Bracket", printed: "2026-09-01" } },
      OWNER,
    );
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
      OWNER,
      "col_parts",
    );
    for (const [title, grams] of [
      ["Bracket", 12.5],
      ["Spacer", 4],
      ["Enclosure", 210],
    ] as const) {
      await collections.upsertRow(WS, collection.id, { values: { title, grams } }, OWNER);
    }

    const heavy = await collections.queryRows(WS, collection.id, {
      where: [{ field: "grams", op: "gt", value: 10 }],
      sort: [{ field: "grams", direction: "desc" }],
    });
    expect(heavy.items.map((r) => r.values["title"])).toEqual(["Enclosure", "Bracket"]);
  });

  describe("revisions (ADR-008)", () => {
    it("records a revision per write, newest first, with actor and note", async () => {
      const created = await pages.create(WS, { title: "Log", body: "v1" }, OWNER, "pg_hist");
      const second = await pages.update(
        WS,
        created.id,
        { title: "Log", body: "v1\nv2" },
        created.version,
        AGENT,
      );
      await pages.update(
        WS,
        created.id,
        { title: "Print log", body: "v1\nv2\nv3" },
        second.version,
        OWNER,
      );

      const history = await pages.history(WS, created.id);
      expect(history).toHaveLength(3);
      expect(history.map((r) => r.actor.kind)).toEqual(["user", "agent", "user"]);
      expect(history[1]!.note).toBe("Summarised the print log");
      expect(history[2]!.parentVersion).toBeNull();
      expect(history[0]!.parentVersion).toBe(second.version);
    });

    it("gives the page and its latest revision the same version and actor", async () => {
      const page = await pages.create(WS, { title: "Same", body: "x" }, AGENT, "pg_same");
      const [latest] = await pages.history(WS, page.id);
      expect(latest!.version).toBe(page.version);
      expect(page.updatedBy).toEqual(AGENT.actor);
    });

    it("diffs a revision against the one it replaced", async () => {
      const created = await pages.create(
        WS,
        { title: "Quad", body: "ESC: old\nMotors: 2207" },
        OWNER,
        "pg_diff",
      );
      const updated = await pages.update(
        WS,
        created.id,
        { title: "Quad build", body: "ESC: BLHeli_32\nMotors: 2207" },
        created.version,
        AGENT,
      );

      const view = await pages.revision(WS, created.id, updated.version);
      expect(view.diff?.added).toBe(1);
      expect(view.diff?.removed).toBe(1);
      expect(view.diff?.lines.filter((l) => l.op === "equal").map((l) => l.text)).toEqual([
        "Motors: 2207",
      ]);
      expect(view.titleChanged).toBe(true);

      const first = await pages.revision(WS, created.id, created.version);
      expect(first.diff).toBeNull();
    });

    it("restores an old revision as a new one, which can itself be undone", async () => {
      const created = await pages.create(WS, { title: "R", body: "original" }, OWNER, "pg_restore");
      const vandalised = await pages.update(
        WS,
        created.id,
        { title: "R", body: "overwritten by an agent" },
        created.version,
        AGENT,
      );

      const restored = await pages.restore(
        WS,
        created.id,
        created.version,
        vandalised.version,
        OWNER,
      );
      expect(restored.body).toBe("original");

      const history = await pages.history(WS, created.id);
      expect(history).toHaveLength(3);
      expect(history[0]!.note).toContain("Restored version");

      // And the restore can be undone the same way.
      const undone = await pages.restore(
        WS,
        created.id,
        vandalised.version,
        restored.version,
        OWNER,
      );
      expect(undone.body).toBe("overwritten by an agent");
    });

    it("leaves no revision behind when a write loses a version conflict", async () => {
      const created = await pages.create(WS, { title: "C", body: "one" }, OWNER, "pg_orphan");
      await pages.update(WS, created.id, { title: "C", body: "two" }, created.version, OWNER);
      await pages
        .update(WS, created.id, { title: "C", body: "stale" }, created.version, AGENT)
        .catch(() => undefined);

      const all = await store.listRevisions(WS, "page", created.id);
      expect(all.items).toHaveLength(2);
      const recent = await store.listRecentRevisions(WS, { actorKind: "agent" });
      expect(recent.items.filter((r) => r.recordId === created.id)).toHaveLength(0);
    });

    it("hides a revision left off the chain by a crash, and the sweep removes it", async () => {
      const page = await pages.create(WS, { title: "Crash", body: "one" }, OWNER, "pg_crash");
      // A crash between writing the revision and writing the page.
      await store.putRevision(WS, {
        kind: "page",
        recordId: page.id,
        collectionId: null,
        version: "never-applied",
        parentVersion: page.version,
        actor: AGENT.actor,
        note: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        deleted: false,
        snapshot: { title: "Crash", parentId: null, tags: [], body: "lost" },
      });

      expect((await pages.history(WS, page.id)).map((r) => r.version)).toEqual([page.version]);

      const result = await pages.rebuildWorkspace(WS);
      expect(result.orphanRevisions).toBe(1);
      expect(await store.getRevision(WS, "page", page.id, "never-applied")).toBeNull();
    });

    it("keeps history after a page is deleted", async () => {
      const page = await pages.create(WS, { title: "Gone", body: "last words" }, OWNER, "pg_gone");
      await pages.delete(WS, page.id, page.version, AGENT);

      const history = await pages.history(WS, page.id);
      expect(history).toHaveLength(2);
      expect(history[0]!.deleted).toBe(true);
      expect(history[0]!.actor.kind).toBe("agent");
    });

    it("versions rows, with a field-per-line diff and restore", async () => {
      await collections.create(
        WS,
        {
          name: "Parts",
          fields: [
            { name: "title", type: "text", required: true },
            { name: "grams", type: "number" },
          ],
        },
        OWNER,
        "col_hist",
      );
      const row = await collections.upsertRow(
        WS,
        "col_hist",
        { values: { title: "Bracket", grams: 12 } },
        OWNER,
        { id: "row_1" },
      );
      const updated = await collections.upsertRow(
        WS,
        "col_hist",
        { values: { title: "Bracket", grams: 14 } },
        AGENT,
        { id: "row_1", expectedVersion: row.version },
      );

      const history = await collections.rowHistory(WS, "col_hist", "row_1");
      expect(history.map((r) => r.actor.kind)).toEqual(["agent", "user"]);

      const view = await collections.rowRevision(WS, "col_hist", "row_1", updated.version);
      expect(view.diff?.lines.filter((l) => l.op === "add").map((l) => l.text)).toEqual([
        "grams: 14",
      ]);

      const restored = await collections.restoreRow(
        WS,
        "col_hist",
        "row_1",
        row.version,
        updated.version,
        OWNER,
      );
      expect(restored.values["grams"]).toBe(12);
    });

    it("keeps row history separate per collection when row ids repeat", async () => {
      for (const id of ["col_a", "col_b"]) {
        await collections.create(
          WS,
          { name: id, fields: [{ name: "title", type: "text" }] },
          OWNER,
          id,
        );
        await collections.upsertRow(WS, id, { values: { title: id } }, OWNER, { id: "row_same" });
      }
      expect(await collections.rowHistory(WS, "col_a", "row_same")).toHaveLength(1);
      expect(await collections.rowHistory(WS, "col_b", "row_same")).toHaveLength(1);
    });
  });
});
