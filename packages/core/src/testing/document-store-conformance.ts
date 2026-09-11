import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VersionConflictError } from "../errors.js";
import type { DocumentStore } from "../ports/document-store.js";
import type { Page, Row, WorkspaceId } from "../types.js";
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
        null,
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
          first.version,
        );
        expect(second.version).not.toBe(first.version);
        expect(second.title).toBe("Changed");
        expect(second.createdAt).toBe(first.createdAt);
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
          first.version,
        );

        const conflict = await store
          .putPage(
            WS,
            first.id,
            { title: "Loser", body: "body", parentId: null, tags: [] },
            first.version,
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
            "some-version",
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

    describe("collections and rows", () => {
      const schema = {
        name: "Prints",
        fields: [
          { name: "title", type: "text" as const, required: true },
          { name: "grams", type: "number" as const },
          { name: "done", type: "checkbox" as const },
          { name: "tags", type: "multi_select" as const, options: ["pla", "petg"] },
        ],
      };

      it("round-trips a collection", async () => {
        const created = await store.putCollection(WS, "col_prints", schema, null);
        expect(created.fields).toHaveLength(4);
        expect(await store.getCollection(WS, "col_prints")).toEqual(created);

        await eventually(async () => {
          const all = await store.listCollections(WS);
          expect(all.map((c) => c.id)).toContain("col_prints");
        });
      });

      it("enforces optimistic concurrency on collections", async () => {
        const collection = await store.putCollection(WS, "col_conflict", schema, null);
        await store.putCollection(
          WS,
          "col_conflict",
          { ...schema, name: "Renamed" },
          collection.version,
        );
        await expect(
          store.putCollection(WS, "col_conflict", schema, collection.version),
        ).rejects.toBeInstanceOf(VersionConflictError);
      });

      it("round-trips a row without interpreting its values", async () => {
        const row = await store.putRow(
          WS,
          "col_prints",
          "row_1",
          { values: { title: "Bracket", grams: 12.5, done: false, tags: ["pla"] } },
          null,
        );
        const read = await store.getRow(WS, "col_prints", "row_1");
        expect(read).toEqual(row);
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
          null,
        );
        await store.putRow(
          WS,
          "col_prints",
          "row_conflict",
          { values: { title: "Second" } },
          row.version,
        );
        const conflict = await store
          .putRow(WS, "col_prints", "row_conflict", { values: { title: "Third" } }, row.version)
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
          null,
        );
        await store.deleteRow(WS, "col_prints", row.id, row.version);
        expect(await store.getRow(WS, "col_prints", row.id)).toBeNull();
      });

      it("lists rows of one collection only, with paging", async () => {
        await store.putCollection(WS, "col_other", schema, null);
        await store.putRow(WS, "col_other", "row_other", { values: { title: "x" } }, null);
        for (let i = 0; i < 4; i += 1) {
          await store.putRow(
            WS,
            "col_prints",
            `row_list_${i}`,
            { values: { title: `Row ${i}` } },
            null,
          );
        }

        await eventually(async () => {
          const seen = new Set<string>();
          let cursor: string | null = null;
          let rounds = 0;
          do {
            const batch = await store.listRows(WS, "col_prints", { limit: 2, cursor });
            for (const row of batch.items) {
              expect(row.collectionId).toBe("col_prints");
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

    describe("capabilities", () => {
      it("declares pushdown honestly", () => {
        if (store.capabilities.rowQueryPushdown) {
          expect(typeof store.queryRows).toBe("function");
        }
      });
    });
  });
}
