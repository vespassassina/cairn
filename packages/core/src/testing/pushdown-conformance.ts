import { beforeAll, describe, expect, it } from "vitest";
import type { DocumentStore } from "../ports/document-store.js";
import type { RowQuery } from "../query/filter.js";
import { TableService } from "../services/tables.js";
import { randomUUID } from "node:crypto";
import type { WorkspaceId, WriteMeta } from "../types.js";
import { eventually } from "./eventually.js";

function meta(): WriteMeta {
  return {
    version: randomUUID(),
    actor: { kind: "user", id: "owner", label: "Owner" },
    at: new Date().toISOString(),
  };
}

/**
 * Proves the only sanctioned form of adapter variation is invisible: a
 * pushed-down query returns exactly what core's in-memory evaluation returns
 * (ADR-005 rule 5).
 *
 * An adapter without pushdown still runs this. It then compares core against
 * itself, which costs nothing and keeps the query set honest for the day an
 * adapter does claim the capability.
 */

export interface PushdownHarness {
  create(): Promise<DocumentStore>;
}

const WS: WorkspaceId = "ws_pushdown";
const TABLE = "col_pushdown";

const QUERIES: Array<{ name: string; query: RowQuery }> = [
  { name: "no filter", query: {} },
  { name: "eq on text", query: { where: [{ field: "material", op: "eq", value: "pla" }] } },
  { name: "ne on text", query: { where: [{ field: "material", op: "ne", value: "pla" }] } },
  { name: "gt on number", query: { where: [{ field: "grams", op: "gt", value: 20 }] } },
  { name: "lte on number", query: { where: [{ field: "grams", op: "lte", value: 20 }] } },
  { name: "eq on checkbox", query: { where: [{ field: "done", op: "eq", value: true }] } },
  { name: "contains on text", query: { where: [{ field: "title", op: "contains", value: "brack" }] } },
  { name: "contains on multi_select", query: { where: [{ field: "tags", op: "contains", value: "fast" }] } },
  { name: "in on text", query: { where: [{ field: "material", op: "in", value: ["pla", "abs"] }] } },
  { name: "exists true", query: { where: [{ field: "grams", op: "exists", value: true }] } },
  { name: "exists false", query: { where: [{ field: "grams", op: "exists", value: false }] } },
  {
    name: "two conditions combined with AND",
    query: {
      where: [
        { field: "material", op: "eq", value: "pla" },
        { field: "grams", op: "gte", value: 10 },
      ],
    },
  },
  { name: "sort ascending", query: { sort: [{ field: "grams", direction: "asc" }] } },
  { name: "sort descending", query: { sort: [{ field: "grams", direction: "desc" }] } },
  {
    name: "sort on two fields",
    query: {
      sort: [
        { field: "material", direction: "asc" },
        { field: "grams", direction: "desc" },
      ],
    },
  },
  { name: "limit", query: { limit: 2, sort: [{ field: "grams", direction: "asc" }] } },
  {
    name: "filter, sort and limit together",
    query: {
      where: [{ field: "done", op: "eq", value: false }],
      sort: [{ field: "title", direction: "asc" }],
      limit: 3,
    },
  },
];

const ROWS = [
  { id: "row_a", values: { title: "Bracket", material: "pla", grams: 12.5, done: false, tags: ["fast"] } },
  { id: "row_b", values: { title: "Spacer", material: "petg", grams: 4, done: true, tags: [] } },
  { id: "row_c", values: { title: "Bracket mk2", material: "pla", grams: 31, done: true, tags: ["fast", "draft"] } },
  { id: "row_d", values: { title: "Enclosure", material: "abs", grams: 210, done: false, tags: ["draft"] } },
  { id: "row_e", values: { title: "Clip", material: "pla", done: false, tags: [] } },
];

export function runPushdownConformance(
  name: string,
  harness: PushdownHarness,
): void {
  describe(`Table query pushdown equivalence: ${name}`, () => {
    let store: DocumentStore;
    let service: TableService;

    beforeAll(async () => {
      store = await harness.create();
      await store.init();
      service = new TableService(store);

      await store.putTable(
        WS,
        TABLE,
        {
          name: "Parts",
          fields: [
            { name: "title", type: "text", required: true },
            { name: "material", type: "select", options: ["pla", "petg", "abs"] },
            { name: "grams", type: "number" },
            { name: "done", type: "checkbox" },
            { name: "tags", type: "multi_select", options: ["fast", "draft"] },
          ],
        },
        null, meta(),
      );
      for (const row of ROWS) {
        await store.putRow(WS, TABLE, row.id, { values: row.values }, null, meta());
      }
      await eventually(async () => {
        const listed = await store.listRows(WS, TABLE, { limit: 100 });
        expect(listed.items).toHaveLength(ROWS.length);
      });
    });

    for (const { name: queryName, query } of QUERIES) {
      it(`agrees with core for: ${queryName}`, async () => {
        const inMemory = await service.queryRows(WS, TABLE, query, {
          pushdown: false,
        });
        const pushed = await service.queryRows(WS, TABLE, query, {
          pushdown: true,
        });
        expect(pushed.items.map((r) => r.id)).toEqual(
          inMemory.items.map((r) => r.id),
        );
        expect(pushed.items).toEqual(inMemory.items);
      });
    }

    it("pages identically through a filtered, sorted result", async () => {
      const query: RowQuery = {
        sort: [{ field: "title", direction: "asc" }],
        limit: 2,
      };
      for (const pushdown of [false, true]) {
        const seen: string[] = [];
        let cursor: string | null = null;
        let rounds = 0;
        do {
          const batch = await service.queryRows(
            WS,
            TABLE,
            { ...query, cursor },
            { pushdown },
          );
          seen.push(...batch.items.map((r) => r.id));
          cursor = batch.cursor;
          rounds += 1;
        } while (cursor !== null && rounds < 20);
        expect(seen).toEqual(["row_a", "row_c", "row_e", "row_d", "row_b"]);
      }
    });
  });
}
