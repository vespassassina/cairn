/**
 * Domain types. No cloud SDKs, no I/O.
 *
 * Pages and rows are the source of truth. Edges and chunks are derived from
 * them and can be rebuilt at any time (ADR-005 rule 2).
 */

export type Id = string;
export type WorkspaceId = string;

/**
 * Opaque optimistic-concurrency token. Compared by equality, never parsed.
 * Cosmos gives an ETag, DynamoDB a version attribute, SQLite a counter.
 */
export type Version = string;

/** Passed as `expectedVersion` to assert the record does not exist yet. */
export const CREATE_ONLY = null;
export type ExpectedVersion = Version | typeof CREATE_ONLY;

export interface Page {
  id: Id;
  workspaceId: WorkspaceId;
  title: string;
  parentId: Id | null;
  tags: string[];
  /** Markdown in P0. BlockNote JSON arrives with the editor in Phase 2. */
  body: string;
  createdAt: string;
  updatedAt: string;
  version: Version;
}

export interface PageInput {
  title: string;
  parentId?: Id | null;
  tags?: string[];
  body: string;
}

export type EdgeType = "link" | "mention" | "relation" | "parent" | "tag";

export interface Edge {
  workspaceId: WorkspaceId;
  sourceId: Id;
  targetId: Id;
  type: EdgeType;
  /** Anchor text for a link, field name for a relation, raw text for a tag. */
  label: string | null;
}

export type EdgeInput = Omit<Edge, "workspaceId">;

export interface Chunk {
  id: Id;
  workspaceId: WorkspaceId;
  pageId: Id;
  /** Headings above this chunk, outermost first. */
  headingPath: string[];
  text: string;
  /** Position within the page, 0-based. */
  ordinal: number;
}

export type ChunkInput = Omit<Chunk, "workspaceId">;

export type FieldType =
  | "text"
  | "number"
  | "date"
  | "select"
  | "multi_select"
  | "checkbox"
  | "url"
  | "relation";

export interface FieldDef {
  name: string;
  type: FieldType;
  required?: boolean;
  /** For select and multi_select. */
  options?: string[];
}

export interface Collection {
  id: Id;
  workspaceId: WorkspaceId;
  name: string;
  fields: FieldDef[];
  createdAt: string;
  updatedAt: string;
  version: Version;
}

export interface CollectionInput {
  name: string;
  fields: FieldDef[];
}

export type FieldValue = string | number | boolean | string[] | null;

export interface Row {
  id: Id;
  workspaceId: WorkspaceId;
  collectionId: Id;
  values: Record<string, FieldValue>;
  createdAt: string;
  updatedAt: string;
  version: Version;
}

export interface RowInput {
  values: Record<string, FieldValue>;
}

/**
 * A batch of results plus an opaque cursor. Every list operation returns this.
 * Named `Paged` rather than `Page` because `Page` is the document type.
 */
export interface Paged<T> {
  items: T[];
  cursor: string | null;
}
