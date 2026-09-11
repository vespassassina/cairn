import type { FieldValue, Row } from "../types.js";

/**
 * The collection filter grammar. Deliberately small, and shaped by the weakest
 * backend: DynamoDB cannot filter or sort on arbitrary fields without a scan.
 *
 * Evaluation runs in core, in memory, over the rows of one collection (ADR-005
 * rule 5). An adapter may push it down, and must then return identical results.
 */

export type ComparisonOperator =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "contains"
  | "in"
  | "exists";

export interface Condition {
  field: string;
  op: ComparisonOperator;
  value?: FieldValue;
}

export interface SortKey {
  field: string;
  direction: "asc" | "desc";
}

export interface RowQuery {
  /** Conditions are combined with AND. No OR in v1, no nesting. */
  where?: Condition[];
  sort?: SortKey[];
  limit?: number;
  cursor?: string | null;
}

export const DEFAULT_ROW_LIMIT = 50;
export const MAX_ROW_LIMIT = 500;

/**
 * Total order over mixed field values, so sorting is deterministic across
 * backends. Nulls sort last in ascending order.
 */
function compareValues(a: FieldValue, b: FieldValue): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(a) - Number(b);
  }
  return String(a).localeCompare(String(b));
}

function asArray(value: FieldValue): FieldValue[] {
  return Array.isArray(value) ? value : [value];
}

export function matchesCondition(row: Row, condition: Condition): boolean {
  const actual = row.values[condition.field] ?? null;
  const expected = condition.value ?? null;

  switch (condition.op) {
    case "exists":
      return expected === false
        ? actual === null
        : actual !== null && !(Array.isArray(actual) && actual.length === 0);
    case "eq":
      return Array.isArray(actual) && Array.isArray(expected)
        ? actual.length === expected.length &&
            actual.every((v, i) => v === expected[i])
        : actual === expected;
    case "ne":
      return !matchesCondition(row, { ...condition, op: "eq" });
    case "lt":
      return actual !== null && compareValues(actual, expected) < 0;
    case "lte":
      return actual !== null && compareValues(actual, expected) <= 0;
    case "gt":
      return actual !== null && compareValues(actual, expected) > 0;
    case "gte":
      return actual !== null && compareValues(actual, expected) >= 0;
    case "contains":
      // Substring for text, membership for multi_select.
      if (Array.isArray(actual)) return actual.includes(expected as string);
      if (typeof actual === "string" && typeof expected === "string") {
        return actual.toLowerCase().includes(expected.toLowerCase());
      }
      return false;
    case "in":
      return asArray(expected).includes(actual as FieldValue);
  }
}

export function matchesQuery(row: Row, where: Condition[] | undefined): boolean {
  return (where ?? []).every((condition) => matchesCondition(row, condition));
}

export function sortRows(rows: Row[], sort: SortKey[] | undefined): Row[] {
  if (!sort || sort.length === 0) {
    // Stable, backend-independent default.
    return [...rows].sort((a, b) => a.id.localeCompare(b.id));
  }
  return [...rows].sort((a, b) => {
    for (const key of sort) {
      const result = compareValues(
        a.values[key.field] ?? null,
        b.values[key.field] ?? null,
      );
      if (result !== 0) return key.direction === "desc" ? -result : result;
    }
    return a.id.localeCompare(b.id);
  });
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_ROW_LIMIT;
  return Math.max(1, Math.min(MAX_ROW_LIMIT, Math.trunc(limit)));
}

/**
 * Cursors for in-memory paging are an offset into the sorted result. Opaque to
 * callers, and only ever produced and consumed by this module.
 */
export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, "utf8").toString("base64url");
}

export function decodeOffsetCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const offset = decoded.startsWith("o:") ? Number(decoded.slice(2)) : Number.NaN;
  return Number.isInteger(offset) && offset >= 0 ? offset : 0;
}
