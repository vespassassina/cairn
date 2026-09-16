import type { FieldError } from "../errors.js";
import type { Table, FieldDef, FieldValue, RowInput } from "../types.js";
import type { RowQuery } from "./filter.js";

/**
 * Row validation lives in core so that every adapter stores rows without
 * knowing anything about field semantics (PRD P0.4).
 */

function checkValue(field: FieldDef, value: FieldValue): string | null {
  switch (field.type) {
    case "text":
      return typeof value === "string" ? null : "expected text";
    case "url":
      if (typeof value !== "string") return "expected a URL string";
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:"
          ? null
          : "expected an http or https URL";
      } catch {
        return "expected a valid URL";
      }
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : "expected a number";
    case "checkbox":
      return typeof value === "boolean" ? null : "expected true or false";
    case "date":
      if (typeof value !== "string") return "expected an ISO 8601 date string";
      return Number.isNaN(Date.parse(value))
        ? "expected an ISO 8601 date string"
        : null;
    case "select":
      if (typeof value !== "string") return "expected one of the options";
      return field.options && !field.options.includes(value)
        ? `expected one of: ${field.options.join(", ")}`
        : null;
    case "multi_select": {
      if (!Array.isArray(value)) return "expected a list of options";
      const unknown = field.options
        ? value.filter((v) => !field.options!.includes(v))
        : [];
      return unknown.length > 0
        ? `unknown options: ${unknown.join(", ")}. expected one of: ${field.options!.join(", ")}`
        : null;
    }
    case "relation": {
      const what = relationTarget(field) === "pages" ? "a page id" : "a row id";
      if (field.multiple) {
        if (!Array.isArray(value)) return `expected a list of ids, each ${what}`;
        const bad = value.filter((id) => !ID.test(id));
        return bad.length > 0 ? `not ids: ${bad.join(", ")}. expected ${what} in each` : null;
      }
      return typeof value === "string" && ID.test(value) ? null : `expected ${what}`;
    }
  }
}

/** Page, table and row ids: letters, digits, dashes and underscores. */
const ID = /^[A-Za-z0-9_-]+$/;

/** What a relation field links to: `"pages"`, or a table id. */
export function relationTarget(field: FieldDef): string {
  return field.target ?? "pages";
}

/**
 * Problems with a table's schema, all at once. A relation's target must
 * be pages, this table, or a table that exists (ADR-024).
 */
export function validateSchema(
  tableId: string,
  fields: FieldDef[],
  tableExists: (id: string) => boolean,
): FieldError[] {
  const errors: FieldError[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.name)) errors.push({ field: field.name, message: "two fields share this name" });
    seen.add(field.name);
    if (field.type !== "relation") {
      if (field.target !== undefined || field.multiple !== undefined) {
        errors.push({ field: field.name, message: "target and multiple are only for relation fields" });
      }
      continue;
    }
    const target = relationTarget(field);
    if (target !== "pages" && target !== tableId && !tableExists(target)) {
      errors.push({ field: field.name, message: `target ${target} is neither "pages" nor a table that exists` });
    }
  }
  return errors;
}

function isEmpty(value: FieldValue | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Returns every problem at once, naming each field, so a caller can fix a bad
 * write in a single retry instead of discovering errors one at a time.
 */
export function validateRow(
  table: Table,
  input: RowInput,
): FieldError[] {
  const errors: FieldError[] = [];
  const known = new Set(table.fields.map((f) => f.name));

  for (const name of Object.keys(input.values)) {
    if (!known.has(name)) {
      errors.push({
        field: name,
        message: `unknown field. known fields: ${[...known].join(", ")}`,
      });
    }
  }

  for (const field of table.fields) {
    const value = input.values[field.name];
    if (isEmpty(value)) {
      if (field.required) {
        errors.push({ field: field.name, message: "required" });
      }
      continue;
    }
    const problem = checkValue(field, value as FieldValue);
    if (problem) errors.push({ field: field.name, message: problem });
  }

  return errors;
}

/**
 * Names every field a --where or --sort names that the table does not have.
 * Without this, `matchesCondition` reads a missing field as null, so a
 * misspelled field silently matched nothing instead of being refused.
 */
export function validateQuery(table: Table, query: RowQuery): FieldError[] {
  const known = new Set(table.fields.map((f) => f.name));
  const errors: FieldError[] = [];
  const unknown = (name: string) =>
    errors.push({ field: name, message: `unknown field. known fields: ${[...known].join(", ")}` });

  for (const condition of query.where ?? []) {
    if (!known.has(condition.field)) unknown(condition.field);
  }
  for (const key of query.sort ?? []) {
    if (!known.has(key.field)) unknown(key.field);
  }

  return errors;
}
