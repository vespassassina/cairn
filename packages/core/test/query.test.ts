import { describe, expect, it } from "vitest";
import {
  matchesCondition,
  sortRows,
  validateQuery,
  validateRow,
  type Table,
  type Row,
} from "../src/index.js";

function row(values: Row["values"], id = "row_1"): Row {
  return {
    id,
    workspaceId: "ws",
    tableId: "col",
    values,
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    version: "v1",
  };
}

describe("matchesCondition", () => {
  const subject = row({ title: "Bracket mk2", grams: 31, done: false, tags: ["fast"] });

  it("compares text, numbers and booleans", () => {
    expect(matchesCondition(subject, { field: "grams", op: "gt", value: 30 })).toBe(true);
    expect(matchesCondition(subject, { field: "grams", op: "lte", value: 30 })).toBe(false);
    expect(matchesCondition(subject, { field: "done", op: "eq", value: false })).toBe(true);
    expect(matchesCondition(subject, { field: "title", op: "ne", value: "Spacer" })).toBe(true);
  });

  it("treats contains as substring for text and membership for lists", () => {
    expect(matchesCondition(subject, { field: "title", op: "contains", value: "brack" })).toBe(true);
    expect(matchesCondition(subject, { field: "tags", op: "contains", value: "fast" })).toBe(true);
    expect(matchesCondition(subject, { field: "tags", op: "contains", value: "slow" })).toBe(false);
  });

  it("handles in and exists", () => {
    expect(matchesCondition(subject, { field: "title", op: "in", value: ["Bracket mk2", "Clip"] })).toBe(true);
    expect(matchesCondition(subject, { field: "grams", op: "exists", value: true })).toBe(true);
    expect(matchesCondition(row({}), { field: "grams", op: "exists", value: true })).toBe(false);
    expect(matchesCondition(row({}), { field: "grams", op: "exists", value: false })).toBe(true);
  });

  it("treats a missing field as not matching a comparison", () => {
    expect(matchesCondition(row({}), { field: "grams", op: "gt", value: 0 })).toBe(false);
    expect(matchesCondition(row({}), { field: "grams", op: "lt", value: 99 })).toBe(false);
  });
});

describe("sortRows", () => {
  const rows = [
    row({ grams: 31 }, "row_c"),
    row({ grams: 4 }, "row_b"),
    row({}, "row_e"),
    row({ grams: 12.5 }, "row_a"),
  ];

  it("sorts ascending with missing values last", () => {
    expect(
      sortRows(rows, [{ field: "grams", direction: "asc" }]).map((r) => r.id),
    ).toEqual(["row_b", "row_a", "row_c", "row_e"]);
  });

  it("sorts descending", () => {
    expect(
      sortRows(rows, [{ field: "grams", direction: "desc" }]).map((r) => r.id),
    ).toEqual(["row_e", "row_c", "row_a", "row_b"]);
  });

  it("falls back to id so the order is stable across backends", () => {
    expect(sortRows(rows, undefined).map((r) => r.id)).toEqual([
      "row_a",
      "row_b",
      "row_c",
      "row_e",
    ]);
    const tied = [row({ grams: 1 }, "row_z"), row({ grams: 1 }, "row_a")];
    expect(
      sortRows(tied, [{ field: "grams", direction: "asc" }]).map((r) => r.id),
    ).toEqual(["row_a", "row_z"]);
  });
});

describe("validateRow", () => {
  const table: Table = {
    id: "col",
    workspaceId: "ws",
    name: "Prints",
    fields: [
      { name: "title", type: "text", required: true },
      { name: "printed", type: "date", required: true },
      { name: "grams", type: "number" },
      { name: "material", type: "select", options: ["pla", "petg"] },
      { name: "tags", type: "multi_select", options: ["fast", "draft"] },
      { name: "done", type: "checkbox" },
      { name: "source", type: "url" },
    ],
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    version: "v1",
  };

  it("accepts a valid row", () => {
    expect(
      validateRow(table, {
        values: {
          title: "Bracket",
          printed: "2026-09-01",
          grams: 12,
          material: "pla",
          tags: ["fast"],
          done: true,
          source: "https://example.com/model",
        },
      }),
    ).toEqual([]);
  });

  it("names a missing required field (PRD P0.4)", () => {
    const errors = validateRow(table, { values: { title: "Bracket" } });
    expect(errors).toEqual([{ field: "printed", message: "required" }]);
  });

  it("reports every problem at once so one retry can fix them all", () => {
    const errors = validateRow(table, {
      values: { title: 4, printed: "not a date", grams: "heavy", material: "nylon" },
    });
    expect(errors.map((e) => e.field).sort()).toEqual([
      "grams",
      "material",
      "printed",
      "title",
    ]);
    expect(errors.find((e) => e.field === "material")?.message).toContain("pla, petg");
  });

  it("rejects unknown fields and lists the known ones", () => {
    const errors = validateRow(table, {
      values: { title: "x", printed: "2026-09-01", colour: "red" },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe("colour");
    expect(errors[0]!.message).toContain("title");
  });

  it("rejects an option not in a multi_select, and a non-http URL", () => {
    const errors = validateRow(table, {
      values: {
        title: "x",
        printed: "2026-09-01",
        tags: ["fast", "sideways"],
        source: "ftp://example.com",
      },
    });
    expect(errors.map((e) => e.field).sort()).toEqual(["source", "tags"]);
    expect(errors.find((e) => e.field === "tags")?.message).toContain("sideways");
  });

  it("treats an empty value as absent rather than invalid", () => {
    expect(
      validateRow(table, {
        values: { title: "x", printed: "2026-09-01", tags: [], grams: null },
      }),
    ).toEqual([]);
  });
});

describe("validateQuery", () => {
  const table: Table = {
    id: "col",
    workspaceId: "ws",
    name: "Prints",
    fields: [
      { name: "title", type: "text", required: true },
      { name: "grams", type: "number" },
    ],
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    version: "v1",
  };

  it("accepts where and sort on known fields", () => {
    expect(
      validateQuery(table, {
        where: [{ field: "grams", op: "gt", value: 10 }],
        sort: [{ field: "title", direction: "asc" }],
      }),
    ).toEqual([]);
  });

  it("rejects an unknown where field and lists the known ones (fault 2, acceptance criterion 12)", () => {
    const errors = validateQuery(table, { where: [{ field: "nosuch", op: "eq", value: 1 }] });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe("nosuch");
    expect(errors[0]!.message).toBe("unknown field. known fields: title, grams");
  });

  it("rejects an unknown sort field", () => {
    const errors = validateQuery(table, { sort: [{ field: "nosuch", direction: "desc" }] });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe("nosuch");
  });
});
