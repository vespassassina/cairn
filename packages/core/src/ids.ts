import { randomUUID } from "node:crypto";

/**
 * Ids are opaque strings, short enough to be cheap in a Claude context window
 * and safe in a URL path segment.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export const newPageId = (): string => newId("pg");
export const newTableId = (): string => newId("col");
export const newRowId = (): string => newId("row");
export const newSynonymId = (): string => newId("syn");

/** A fresh optimistic-concurrency token, chosen by the service (ADR-008 rule 5). */
export const newVersion = (): string => randomUUID();

/**
 * A row's id in the link graph and in revisions: `<table id>/<row id>`,
 * since row ids are only unique within their table. Page and table
 * ids never contain a slash, so the two cannot collide (ADR-024).
 */
export const rowNodeId = (tableId: string, rowId: string): string => `${tableId}/${rowId}`;

/** The table and row in a row's node id, or null for any other id. */
export function parseRowNodeId(id: string): { tableId: string; rowId: string } | null {
  const at = id.indexOf("/");
  if (at <= 0 || at === id.length - 1 || id.indexOf("/", at + 1) !== -1) return null;
  return { tableId: id.slice(0, at), rowId: id.slice(at + 1) };
}

/** The record id a revision is filed under. Rows are scoped by table. */
export function revisionRecordId(
  kind: "page" | "row",
  id: string,
  tableId?: string | null,
): string {
  return kind === "row" ? `${tableId}/${id}` : id;
}
