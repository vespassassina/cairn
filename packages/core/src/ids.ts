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

/** The record id a revision is filed under. Rows are scoped by collection. */
export function revisionRecordId(
  kind: "page" | "row",
  id: string,
  collectionId?: string | null,
): string {
  return kind === "row" ? `${collectionId}/${id}` : id;
}
