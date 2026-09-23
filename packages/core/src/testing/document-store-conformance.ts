import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VersionConflictError } from "../errors.js";
import type { DocumentStore } from "../ports/document-store.js";
import type { Actor, Page, RevisionInput, Row, WorkspaceId, WriteMeta } from "../types.js";
import { eventually } from "./eventually.js";

/**
 * The shared conformance suite for {@link DocumentStore} (CLAUDE.md hard rule
 * 2). Every adapter runs this unchanged. An adapter that needs a branch here
 * has failed the portability requirement, not the test.
 */

export interface DocumentStoreHarness {
  /** A fresh, empty store. Called once per suite. */
  create(): Promise<DocumentStore>;
}

const WS: WorkspaceId = "ws_conformance";

const OWNER: Actor = { kind: "user", id: "owner", label: "Owner" };
const AGENT: Actor = { kind: "agent", id: "mcp:test", label: "test-agent/1.0" };

/**
 * Write metadata as the service would supply it. The adapter must store the
 * version, actor and time exactly as given (ADR-008 rule 5).
 */
function meta(actor: Actor = OWNER): WriteMeta {
  return { version: randomUUID(), actor, at: new Date().toISOString() };
}

function revision(
  recordId: string,
  version: string,
  parentVersion: string | null,
  overrides: Partial<RevisionInput> = {},
): RevisionInput {
  return {
    kind: "page",
    recordId,
    tableId: null,
    version,
    parentVersion,
    actor: OWNER,
    note: null,
    createdAt: new Date().toISOString(),
    deleted: false,
    snapshot: { title: recordId, parentId: null, tags: [], body: `body of ${version}` },
    ...overrides,
  };
}

export function runDocumentStoreConformance(
  name: string,
  harness: DocumentStoreHarness,
): void {
  describe(`DocumentStore conformance: ${name}`, () => {
    let store: DocumentStore;

    beforeAll(async () => {
      store = await harness.create();
      await store.init();
    });

    afterAll(async () => {
      await store?.close();
    });

    const makePage = async (
      id: string,
      overrides: Partial<Parameters<DocumentStore["putPage"]>[2]> = {},
    ): Promise<Page> =>
      store.putPage(
        WS,
        id,
        { title: `Page ${id}`, body: "body", parentId: null, tags: [], ...overrides },
        null, meta(),
      );

    describe("init", () => {
      it("is idempotent", async () => {
        await store.init();
        await store.init();
      });
    });

    describe("pages", () => {
      it("round-trips a page and reads it back immediately", async () => {
        const written = await makePage("pg_round_trip", {
          title: "Round trip",
          tags: ["a", "b"],
        });
        expect(written.id).toBe("pg_round_trip");
        expect(written.workspaceId).toBe(WS);
        expect(written.version).toBeTruthy();

        const read = await store.getPage(WS, "pg_round_trip");
        expect(read).toEqual(written);
      });

      it("returns null for a page that does not exist", async () => {
        expect(await store.getPage(WS, "pg_missing")).toBeNull();
      });

      it("isolates workspaces", async () => {
        await makePage("pg_isolated");
        expect(await store.getPage("ws_other", "pg_isolated")).toBeNull();
      });

      it("changes the version on every write", async () => {
        const first = await makePage("pg_versions");
        const second = await store.putPage(
          WS,
          first.id,
          { title: "Changed", body: "body", parentId: null, tags: [] },
          first.version, meta(),
        );
        expect(second.version).not.toBe(first.version);
        expect(second.title).toBe("Changed");
        expect(second.createdAt).toBe(first.createdAt);
      });

      it("stores the version, actor and time the service chose", async () => {
        const chosen = meta(AGENT);
        const page = await store.putPage(
          WS,
          "pg_meta",
          { title: "Meta", body: "", parentId: null, tags: [] },
          null,
          chosen,
        );
        expect(page.version).toBe(chosen.version);
        expect(page.updatedBy).toEqual(AGENT);
        expect(page.updatedAt).toBe(chosen.at);
        expect(page.createdAt).toBe(chosen.at);

        const read = await store.getPage(WS, "pg_meta");
        expect(read?.version).toBe(chosen.version);
        expect(read?.updatedBy).toEqual(AGENT);
      });

      it("stores the edit time the service chose, apart from the update time (ADR-030)", async () => {
        const page = await store.putPage(
          WS,
          "pg_edited",
          { title: "Edited", body: "", parentId: null, tags: [], editedAt: "2026-01-02T03:04:05.006Z" },
          null,
          meta(),
        );
        expect(page.editedAt).toBe("2026-01-02T03:04:05.006Z");
        expect((await store.getPage(WS, "pg_edited"))?.editedAt).toBe("2026-01-02T03:04:05.006Z");
        // Without one, the time of the write.
        const plain = await makePage("pg_edited_plain");
        expect(plain.editedAt).toBe(plain.updatedAt);
      });

      it("rejects a create when the page already exists", async () => {
        const page = await makePage("pg_create_twice");
        await expect(makePage("pg_create_twice")).rejects.toBeInstanceOf(
          VersionConflictError,
        );
        // The original survives untouched.
        expect(await store.getPage(WS, page.id)).toEqual(page);
      });

      it("rejects a stale update and returns the current page", async () => {
        const first = await makePage("pg_conflict");
        await store.putPage(
          WS,
          first.id,
          { title: "Winner", body: "body", parentId: null, tags: [] },
          first.version, meta(),
        );

        const conflict = await store
          .putPage(
            WS,
            first.id,
            { title: "Loser", body: "body", parentId: null, tags: [] },
            first.version,
            meta(),
          )
          .catch((error: unknown) => error);

        expect(conflict).toBeInstanceOf(VersionConflictError);
        const current = (conflict as VersionConflictError<Page>).current;
        expect(current?.title).toBe("Winner");
        expect(current?.version).toBeTruthy();
      });

      it("rejects an update to a page that does not exist", async () => {
        await expect(
          store.putPage(
            WS,
            "pg_absent",
            { title: "x", body: "", parentId: null, tags: [] },
            "some-version", meta(),
          ),
        ).rejects.toBeInstanceOf(VersionConflictError);
      });

      it("deletes with a matching version and refuses a stale one", async () => {
        const page = await makePage("pg_delete");
        await expect(
          store.deletePage(WS, page.id, "stale"),
        ).rejects.toBeInstanceOf(VersionConflictError);
        await store.deletePage(WS, page.id, page.version);
        expect(await store.getPage(WS, page.id)).toBeNull();
      });

      it("lists children of a parent, and roots", async () => {
        await makePage("pg_parent");
        await makePage("pg_child_a", { parentId: "pg_parent" });
        await makePage("pg_child_b", { parentId: "pg_parent" });

        await eventually(async () => {
          const children = await store.listPages(WS, { parentId: "pg_parent" });
          expect(children.items.map((p) => p.id).sort()).toEqual([
            "pg_child_a",
            "pg_child_b",
          ]);
        });

        await eventually(async () => {
          const roots = await store.listPages(WS, { parentId: null });
          expect(roots.items.map((p) => p.id)).toContain("pg_parent");
          expect(roots.items.map((p) => p.id)).not.toContain("pg_child_a");
        });
      });

      it("pages through results with a cursor", async () => {
        for (let i = 0; i < 5; i += 1) {
          await makePage(`pg_paged_${i}`, { parentId: "pg_paged_root" });
        }
        await eventually(async () => {
          const seen = new Set<string>();
          let cursor: string | null = null;
          let rounds = 0;
          do {
            const batch = await store.listPages(WS, {
              parentId: "pg_paged_root",
              limit: 2,
              cursor,
            });
            expect(batch.items.length).toBeLessThanOrEqual(2);
            for (const page of batch.items) seen.add(page.id);
            cursor = batch.cursor;
            rounds += 1;
          } while (cursor !== null && rounds < 20);
          expect(seen.size).toBe(5);
        });
      });

      it("streams every page id for a rebuild", async () => {
        const ids: string[] = [];
        for await (const id of store.iteratePageIds(WS)) ids.push(id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toContain("pg_round_trip");
        expect(ids).not.toContain("pg_delete");
      });
    });

    describe("edges", () => {
      it("replaces edges for a source, and is idempotent", async () => {
        const edges = [
          { sourceId: "pg_a", targetId: "pg_b", type: "link" as const, label: "to b" },
          { sourceId: "pg_a", targetId: "pg_c", type: "link" as const, label: null },
        ];
        await store.replaceEdgesForSource(WS, "pg_a", edges);
        await store.replaceEdgesForSource(WS, "pg_a", edges);

        await eventually(async () => {
          const outbound = await store.getOutboundEdges(WS, "pg_a");
          expect(outbound).toHaveLength(2);
          expect(outbound.map((e) => e.targetId).sort()).toEqual(["pg_b", "pg_c"]);
          expect(outbound[0]?.workspaceId).toBe(WS);
        });
      });

      it("returns backlinks for a target", async () => {
        await store.replaceEdgesForSource(WS, "pg_src1", [
          { sourceId: "pg_src1", targetId: "pg_hub", type: "link", label: null },
        ]);
        await store.replaceEdgesForSource(WS, "pg_src2", [
          { sourceId: "pg_src2", targetId: "pg_hub", type: "mention", label: null },
        ]);

        await eventually(async () => {
          const inbound = await store.getInboundEdges(WS, "pg_hub");
          expect(inbound.map((e) => e.sourceId).sort()).toEqual([
            "pg_src1",
            "pg_src2",
          ]);
          expect(inbound.find((e) => e.sourceId === "pg_src2")?.type).toBe("mention");
        });
      });

      it("removes an edge when the source no longer declares it (PRD P0.3)", async () => {
        await store.replaceEdgesForSource(WS, "pg_fickle", [
          { sourceId: "pg_fickle", targetId: "pg_target", type: "link", label: null },
        ]);
        await eventually(async () => {
          expect(await store.getInboundEdges(WS, "pg_target")).toHaveLength(1);
        });

        await store.replaceEdgesForSource(WS, "pg_fickle", []);
        await eventually(async () => {
          expect(await store.getInboundEdges(WS, "pg_target")).toHaveLength(0);
        });
      });

      it("leaves other sources alone when replacing one", async () => {
        await store.replaceEdgesForSource(WS, "pg_keep", [
          { sourceId: "pg_keep", targetId: "pg_shared", type: "link", label: null },
        ]);
        await store.replaceEdgesForSource(WS, "pg_churn", [
          { sourceId: "pg_churn", targetId: "pg_shared", type: "link", label: null },
        ]);
        await store.replaceEdgesForSource(WS, "pg_churn", []);

        await eventually(async () => {
          const inbound = await store.getInboundEdges(WS, "pg_shared");
          expect(inbound.map((e) => e.sourceId)).toEqual(["pg_keep"]);
        });
      });
    });

    describe("tables and rows", () => {
      const schema = {
        name: "Prints",
        fields: [
          { name: "title", type: "text" as const, required: true },
          { name: "grams", type: "number" as const },
          { name: "done", type: "checkbox" as const },
          { name: "tags", type: "multi_select" as const, options: ["pla", "petg"] },
        ],
      };

      it("round-trips a table", async () => {
        const created = await store.putTable(WS, "col_prints", schema, null, meta());
        expect(created.fields).toHaveLength(4);
        expect(await store.getTable(WS, "col_prints")).toEqual(created);

        await eventually(async () => {
          const all = await store.listTables(WS);
          expect(all.map((c) => c.id)).toContain("col_prints");
        });
      });

      it("keeps a table's place in the page tree (ADR-024)", async () => {
        const top = await store.putTable(WS, "col_top", schema, null, meta());
        expect(top.parentId).toBeNull();
        const placed = await store.putTable(WS, "col_placed", { ...schema, parentId: "pg_home" }, null, meta());
        expect((await store.getTable(WS, "col_placed"))?.parentId).toBe("pg_home");
        const moved = await store.putTable(WS, "col_placed", { ...schema, parentId: null }, placed.version, meta());
        expect(moved.parentId).toBeNull();
        expect((await store.getTable(WS, "col_placed"))?.parentId).toBeNull();
      });

      it("enforces optimistic concurrency on tables", async () => {
        const table = await store.putTable(WS, "col_conflict", schema, null, meta());
        await store.putTable(
          WS,
          "col_conflict",
          { ...schema, name: "Renamed" },
          table.version, meta(),
        );
        await expect(
          store.putTable(WS, "col_conflict", schema, table.version, meta()),
        ).rejects.toBeInstanceOf(VersionConflictError);
      });

      it("round-trips a row without interpreting its values", async () => {
        const row = await store.putRow(
          WS,
          "col_prints",
          "row_1",
          { values: { title: "Bracket", grams: 12.5, done: false, tags: ["pla"] } },
          null, meta(),
        );
        const read = await store.getRow(WS, "col_prints", "row_1");
        expect(read).toEqual(row);
        expect(read?.editedAt).toBe(row.updatedAt);
        const timed = await store.putRow(WS, "col_prints", "row_1", { values: { title: "Bracket" }, editedAt: "2026-01-02T03:04:05.006Z" }, row.version, meta());
        expect((await store.getRow(WS, "col_prints", "row_1"))?.editedAt).toBe(timed.editedAt);
        expect(timed.editedAt).toBe("2026-01-02T03:04:05.006Z");
        expect(read?.values["grams"]).toBe(12.5);
        expect(read?.values["tags"]).toEqual(["pla"]);
        expect(read?.values["done"]).toBe(false);
      });

      it("enforces optimistic concurrency on rows", async () => {
        const row = await store.putRow(
          WS,
          "col_prints",
          "row_conflict",
          { values: { title: "First" } },
          null, meta(),
        );
        await store.putRow(
          WS,
          "col_prints",
          "row_conflict",
          { values: { title: "Second" } },
          row.version, meta(),
        );
        const conflict = await store
          .putRow(WS, "col_prints", "row_conflict", { values: { title: "Third" } }, row.version, meta())
          .catch((error: unknown) => error);
        expect(conflict).toBeInstanceOf(VersionConflictError);
        expect((conflict as VersionConflictError<Row>).current?.values["title"]).toBe(
          "Second",
        );
      });

      it("deletes a row", async () => {
        const row = await store.putRow(
          WS,
          "col_prints",
          "row_delete",
          { values: { title: "Gone" } },
          null, meta(),
        );
        await store.deleteRow(WS, "col_prints", row.id, row.version);
        expect(await store.getRow(WS, "col_prints", row.id)).toBeNull();
      });

      it("lists rows of one table only, with paging", async () => {
        await store.putTable(WS, "col_other", schema, null, meta());
        await store.putRow(WS, "col_other", "row_other", { values: { title: "x" } }, null, meta());
        for (let i = 0; i < 4; i += 1) {
          await store.putRow(
            WS,
            "col_prints",
            `row_list_${i}`,
            { values: { title: `Row ${i}` } },
            null, meta(),
          );
        }

        await eventually(async () => {
          const seen = new Set<string>();
          let cursor: string | null = null;
          let rounds = 0;
          do {
            const batch = await store.listRows(WS, "col_prints", { limit: 2, cursor });
            for (const row of batch.items) {
              expect(row.tableId).toBe("col_prints");
              seen.add(row.id);
            }
            cursor = batch.cursor;
            rounds += 1;
          } while (cursor !== null && rounds < 50);
          expect(seen.has("row_other")).toBe(false);
          expect(seen.size).toBeGreaterThanOrEqual(4);
        });
      });
    });

    describe("revisions", () => {
      it("round-trips a revision and reads it back immediately", async () => {
        const input = revision("pg_rev_a", "v1", null, {
          actor: AGENT,
          note: "first draft",
        });
        await store.putRevision(WS, input);
        const read = await store.getRevision(WS, "page", "pg_rev_a", "v1");
        expect(read).toEqual({ ...input, workspaceId: WS });
      });

      it("returns null for a revision that does not exist", async () => {
        expect(await store.getRevision(WS, "page", "pg_rev_a", "nope")).toBeNull();
      });

      it("keeps a row's snapshot and table", async () => {
        const input = revision("col_x/row_1", "rv1", null, {
          kind: "row",
          tableId: "col_x",
          snapshot: { tableId: "col_x", values: { title: "Bracket", grams: 12.5 } },
        });
        await store.putRevision(WS, input);
        const read = await store.getRevision(WS, "row", "col_x/row_1", "rv1");
        expect(read?.tableId).toBe("col_x");
        expect(read?.snapshot).toEqual(input.snapshot);
      });

      it("keeps the deleted flag", async () => {
        await store.putRevision(WS, revision("pg_rev_del", "d1", null, { deleted: true }));
        expect((await store.getRevision(WS, "page", "pg_rev_del", "d1"))?.deleted).toBe(true);
      });

      it("lists one record's revisions, newest first", async () => {
        const base = Date.parse("2026-09-12T10:00:00.000Z");
        for (let i = 0; i < 3; i += 1) {
          await store.putRevision(
            WS,
            revision("pg_rev_list", `l${i}`, i === 0 ? null : `l${i - 1}`, {
              createdAt: new Date(base + i * 1000).toISOString(),
            }),
          );
        }
        await store.putRevision(WS, revision("pg_rev_other", "o1", null));

        await eventually(async () => {
          const listed = await store.listRevisions(WS, "page", "pg_rev_list");
          expect(listed.items.map((r) => r.version)).toEqual(["l2", "l1", "l0"]);
        });
      });

      it("does not mix up kinds that share a record id", async () => {
        await store.putRevision(WS, revision("shared_id", "p1", null));
        await store.putRevision(
          WS,
          revision("shared_id", "r1", null, {
            kind: "row",
            tableId: "col_y",
            snapshot: { tableId: "col_y", values: {} },
          }),
        );
        await eventually(async () => {
          const pages = await store.listRevisions(WS, "page", "shared_id");
          expect(pages.items.map((r) => r.version)).toEqual(["p1"]);
        });
        expect(await store.getRevision(WS, "row", "shared_id", "p1")).toBeNull();
      });

      it("pages through one record's revisions with a cursor", async () => {
        const base = Date.parse("2026-09-12T11:00:00.000Z");
        for (let i = 0; i < 5; i += 1) {
          await store.putRevision(
            WS,
            revision("pg_rev_paged", `p${i}`, null, {
              createdAt: new Date(base + i * 1000).toISOString(),
            }),
          );
        }
        await eventually(async () => {
          const seen: string[] = [];
          let cursor: string | null = null;
          let rounds = 0;
          do {
            const batch = await store.listRevisions(WS, "page", "pg_rev_paged", {
              limit: 2,
              cursor,
            });
            expect(batch.items.length).toBeLessThanOrEqual(2);
            seen.push(...batch.items.map((r) => r.version));
            cursor = batch.cursor;
            rounds += 1;
          } while (cursor !== null && rounds < 20);
          expect(seen).toEqual(["p4", "p3", "p2", "p1", "p0"]);
        });
      });

      it("lists recent revisions across the workspace, filtered by actor kind", async () => {
        const later = "2099-01-01T00:00:00.000Z";
        await store.putRevision(
          WS,
          revision("pg_recent_user", "ru1", null, { createdAt: later, actor: OWNER }),
        );
        await store.putRevision(
          WS,
          revision("pg_recent_agent", "ra1", null, {
            createdAt: "2099-01-01T00:00:01.000Z",
            actor: AGENT,
          }),
        );

        await eventually(async () => {
          const all = await store.listRecentRevisions(WS, { limit: 2 });
          expect(all.items.map((r) => r.version)).toEqual(["ra1", "ru1"]);

          const agents = await store.listRecentRevisions(WS, {
            limit: 10,
            actorKind: "agent",
          });
          expect(agents.items.every((r) => r.actor.kind === "agent")).toBe(true);
          expect(agents.items[0]?.version).toBe("ra1");
        });

        const elsewhere = await store.listRecentRevisions("ws_elsewhere", {});
        expect(elsewhere.items).toEqual([]);
      });

      it("lists recent revisions filtered to sync conflicts, combined with actor kind", async () => {
        const later = "2099-01-02T00:00:00.000Z";
        await store.putRevision(
          WS,
          revision("pg_conflict_none", "cn1", null, {
            createdAt: later,
            actor: OWNER,
            note: "Synced from http://elsewhere, where it was deleted",
          }),
        );
        await store.putRevision(
          WS,
          revision("pg_conflict_user", "cu1", null, {
            createdAt: "2099-01-02T00:00:01.000Z",
            actor: OWNER,
            note: "Synced from http://elsewhere. Sync conflict: this was the newer edit; the one it replaced is in this record's history",
          }),
        );
        await store.putRevision(
          WS,
          revision("pg_conflict_agent", "ca1", null, {
            createdAt: "2099-01-02T00:00:02.000Z",
            actor: AGENT,
            note: "Merged in sync with http://elsewhere. Sync conflict: 2 parts changed on both kept the newer edit, this server's edit; the version this replaced is in this record's history",
          }),
        );

        await eventually(async () => {
          const conflicts = await store.listRecentRevisions(WS, {
            limit: 10,
            syncConflict: true,
          });
          expect(conflicts.items.map((r) => r.version)).toEqual(["ca1", "cu1"]);

          const agentConflicts = await store.listRecentRevisions(WS, {
            limit: 10,
            syncConflict: true,
            actorKind: "agent",
          });
          expect(agentConflicts.items.map((r) => r.version)).toEqual(["ca1"]);

          const userConflicts = await store.listRecentRevisions(WS, {
            limit: 10,
            syncConflict: true,
            actorKind: "user",
          });
          expect(userConflicts.items.map((r) => r.version)).toEqual(["cu1"]);
        });
      });

      it("deletes a revision, idempotently", async () => {
        await store.putRevision(WS, revision("pg_rev_gone", "g1", null));
        await store.deleteRevision(WS, "page", "pg_rev_gone", "g1");
        await store.deleteRevision(WS, "page", "pg_rev_gone", "g1");
        expect(await store.getRevision(WS, "page", "pg_rev_gone", "g1")).toBeNull();
      });

      it("prunes every revision but the one to keep", async () => {
        await store.putRevision(WS, revision("pg_rev_prune", "pr1", null));
        await store.putRevision(WS, revision("pg_rev_prune", "pr2", "pr1"));
        await store.putRevision(WS, revision("pg_rev_prune", "pr3", "pr2"));
        const removed = await store.pruneRevisions(WS, "page", "pg_rev_prune", "pr3");
        expect(removed).toBe(2);
        await eventually(async () => {
          const listed = await store.listRevisions(WS, "page", "pg_rev_prune");
          expect(listed.items.map((r) => r.version)).toEqual(["pr3"]);
        });
      });

      it("compact runs without throwing, when the adapter offers it", async () => {
        await store.compact?.();
      });
    });

    describe("deleted pages", () => {
      it("lists a deleted page by its deletion revision, newest first", async () => {
        const page = await makePage("pg_del_a");
        await store.putRevision(
          WS,
          revision(page.id, "da1", page.version, { deleted: true, createdAt: "2099-02-01T00:00:00.000Z" }),
        );
        await store.deletePage(WS, page.id, page.version);

        await eventually(async () => {
          const { items } = await store.listDeletedPages(WS);
          expect(items.map((r) => r.recordId)).toContain(page.id);
          expect(items.find((r) => r.recordId === page.id)?.deleted).toBe(true);
        });
      });

      it("leaves out a page that still exists", async () => {
        await makePage("pg_del_still_here");
        const { items } = await store.listDeletedPages(WS);
        expect(items.some((r) => r.recordId === "pg_del_still_here")).toBe(false);
      });

      it("leaves out a page that was undeleted since its last deletion", async () => {
        const page = await makePage("pg_del_b");
        await store.putRevision(
          WS,
          revision(page.id, "db1", page.version, { deleted: true, createdAt: "2099-02-01T00:00:00.000Z" }),
        );
        await store.deletePage(WS, page.id, page.version);
        // Undeleted: a new revision continues the chain and the page exists again.
        await store.putRevision(
          WS,
          revision(page.id, "db2", "db1", { createdAt: "2099-02-02T00:00:00.000Z" }),
        );
        await store.putPage(WS, page.id, { title: page.title, body: page.body, parentId: null, tags: [] }, null, {
          version: "db2",
          actor: OWNER,
          at: "2099-02-02T00:00:00.000Z",
        });

        await eventually(async () => {
          const { items } = await store.listDeletedPages(WS);
          expect(items.some((r) => r.recordId === page.id)).toBe(false);
        });
      });
    });

    describe("capabilities", () => {
      it("declares pushdown honestly", () => {
        if (store.capabilities.rowQueryPushdown) {
          expect(typeof store.queryRows).toBe("function");
        }
      });
    });
  });
}
