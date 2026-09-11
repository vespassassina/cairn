import type { FieldError } from "../errors.js";
import type { Collection, FieldDef, FieldValue, RowInput } from "../types.js";

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
    case "relation":
      return typeof value === "string" && value.length > 0
        ? null
        : "expected a page id";
  }
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
  collection: Collection,
  input: RowInput,
): FieldError[] {
  const errors: FieldError[] = [];
  const known = new Set(collection.fields.map((f) => f.name));

  for (const name of Object.keys(input.values)) {
    if (!known.has(name)) {
      errors.push({
        field: name,
        message: `unknown field. known fields: ${[...known].join(", ")}`,
      });
    }
  }

  for (const field of collection.fields) {
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
