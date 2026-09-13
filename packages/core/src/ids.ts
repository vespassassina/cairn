import { randomUUID } from "node:crypto";

/**
 * Ids are opaque strings, short enough to be cheap in a Claude context window
 * and safe in a URL path segment.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export const newPageId = (): string => newId("pg");
export const newCollectionId = (): string => newId("col");
export const newRowId = (): string => newId("row");

/** A fresh optimistic-concurrency token, chosen by the service (ADR-008 rule 5). */
export const newVersion = (): string => randomUUID();

/**
 * A row's id in the link graph and in revisions: `<collection id>/<row id>`,
 * since row ids are only unique within their collection. Page and collection
 * ids never contain a slash, so the two cannot collide (ADR-024).
 */
export const rowNodeId = (collectionId: string, rowId: string): string => `${collectionId}/${rowId}`;

/** The collection and row in a row's node id, or null for any other id. */
export function parseRowNodeId(id: string): { collectionId: string; rowId: string } | null {
  const at = id.indexOf("/");
  if (at <= 0 || at === id.length - 1 || id.indexOf("/", at + 1) !== -1) return null;
  return { collectionId: id.slice(0, at), rowId: id.slice(at + 1) };
}

/** The record id a revision is filed under. Rows are scoped by collection. */
export function revisionRecordId(
  kind: "page" | "row",
  id: string,
  collectionId?: string | null,
): string {
  return kind === "row" ? `${collectionId}/${id}` : id;
}
