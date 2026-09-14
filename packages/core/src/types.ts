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

/**
 * Who made a change (ADR-008 rule 4). Every write names one, so the review
 * console can say whether a person or an agent changed a page, and which one.
 */
export interface Actor {
  kind: "user" | "agent";
  /** Stable identity: `owner` in dev mode, an OAuth client id later. */
  id: string;
  /** Shown to people. A user agent string for MCP clients until auth lands. */
  label: string;
}

/**
 * What the service tells an adapter about a write. The service chooses the
 * version so a record and its revision share it (ADR-008 rule 5), and chooses
 * the time so both carry the same timestamp.
 */
export interface WriteMeta {
  version: Version;
  actor: Actor;
  at: string;
}

/** What a caller supplies with every write: who, and optionally why. */
export interface WriteContext {
  actor: Actor;
  note?: string | null;
}

export interface Page {
  id: Id;
  workspaceId: WorkspaceId;
  title: string;
  parentId: Id | null;
  tags: string[];
  /** Markdown in P0. BlockNote JSON arrives with the editor in Phase 2. */
  body: string;
  /** Where its facts came from: URLs or short citations (ADR-027). */
  sources: string[];
  /**
   * When someone last confirmed its facts still hold, separate from when it
   * was last edited. Null when never (ADR-028).
   */
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Who made the latest write, so a page view needs no history read. */
  updatedBy: Actor;
  version: Version;
}

export interface PageInput {
  title: string;
  parentId?: Id | null;
  tags?: string[];
  body: string;
  /**
   * The whole list. Omitted on an update: the page keeps the sources it has,
   * so a write that does not mention them never drops them (ADR-027).
   */
  sources?: string[];
  /**
   * True: this write confirms the page's facts, so `verifiedAt` becomes the
   * time of the write (ADR-028).
   */
  verified?: boolean;
  /**
   * The exact value, for import, sync and restore. Omitted on an update: the
   * page keeps the one it has. Omitted on a create: the time of the write if
   * the page has sources, otherwise null.
   */
  verifiedAt?: string | null;
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
  /**
   * For relation: what it links to. `"pages"`, the default, or a table
   * id, which may be this table's own (ADR-024).
   */
  target?: string;
  /** For relation: a list of links rather than one. */
  multiple?: boolean;
}

export interface Table {
  id: Id;
  workspaceId: WorkspaceId;
  name: string;
  fields: FieldDef[];
  /** The page it sits under in the tree, or null at the top (ADR-024). */
  parentId: Id | null;
  createdAt: string;
  updatedAt: string;
  updatedBy: Actor;
  version: Version;
}

export interface TableInput {
  name: string;
  fields: FieldDef[];
  /** Omitted on an update: stays where it is. Null: moves to the top. */
  parentId?: Id | null;
}

export type FieldValue = string | number | boolean | string[] | null;

export interface Row {
  id: Id;
  workspaceId: WorkspaceId;
  tableId: Id;
  values: Record<string, FieldValue>;
  /** Where its values came from, as for a page (ADR-027). */
  sources: string[];
  createdAt: string;
  updatedAt: string;
  updatedBy: Actor;
  version: Version;
}

export interface RowInput {
  values: Record<string, FieldValue>;
  /** The whole list. Omitted on an update: the row keeps the sources it has. */
  sources?: string[];
}

/**
 * Revisions (ADR-008). One immutable snapshot per write of a page or row,
 * linked into a chain by `parentVersion`.
 *
 * History is read by walking that chain back from the record's current
 * version. A revision off the chain, left by a crash between writing it and
 * writing the record, is therefore never shown.
 */
export type RevisionKind = "page" | "row";

export interface PageSnapshot {
  title: string;
  parentId: Id | null;
  tags: string[];
  body: string;
  /** Missing in revisions written before ADR-027. */
  sources?: string[];
  /** Missing in revisions written before ADR-028. */
  verifiedAt?: string | null;
}

export interface RowSnapshot {
  tableId: Id;
  values: Record<string, FieldValue>;
  /** Missing in revisions written before ADR-027. */
  sources?: string[];
}

export interface Revision {
  workspaceId: WorkspaceId;
  kind: RevisionKind;
  /**
   * The page id for a page. For a row, `<tableId>/<rowId>`, because row
   * ids are only unique within their table. Build it with
   * `revisionRecordId`, never by hand.
   */
  recordId: Id;
  /** The table a row belongs to. Null for pages. */
  tableId: Id | null;
  /** The version the record has after this write. */
  version: Version;
  /** The version this write replaced. Null for the first revision. */
  parentVersion: Version | null;
  actor: Actor;
  /** Why the change was made, when the writer said. */
  note: string | null;
  createdAt: string;
  /** True for the revision that records a deletion. Its snapshot is the last content. */
  deleted: boolean;
  snapshot: PageSnapshot | RowSnapshot;
}

export type RevisionInput = Omit<Revision, "workspaceId">;

/**
 * A batch of results plus an opaque cursor. Every list operation returns this.
 * Named `Paged` rather than `Page` because `Page` is the document type.
 */
export interface Paged<T> {
  items: T[];
  cursor: string | null;
}
