import type {
  Actor,
  Table,
  TableInput,
  EdgeInput,
  Edge,
  ExpectedVersion,
  Id,
  Page,
  PageInput,
  Paged,
  Revision,
  RevisionInput,
  RevisionKind,
  Row,
  RowInput,
  Version,
  WorkspaceId,
  WriteMeta,
} from "../types.js";
import type { RowQuery } from "../query/filter.js";

/**
 * What an adapter claims it can do. Capabilities never change behaviour that
 * callers can observe: a pushdown query must return exactly what core's
 * in-memory evaluation would return (ADR-005 rule 5).
 */
export interface DocumentStoreCapabilities {
  /** Adapter implements `queryRows` natively. Core falls back when false. */
  readonly rowQueryPushdown: boolean;
}

/**
 * The source-of-truth store, plus the derived edge store.
 *
 * Consistency is stated per operation and is part of the contract (ADR-005
 * rule 4). Two levels exist:
 *
 * 1. Immediate. A read after a successful write sees that write. All point
 *    reads and writes of pages, tables and rows are immediate.
 * 2. Eventual, bounded at {@link EVENTUAL_CONSISTENCY_BOUND_MS}. Everything
 *    derived, and every list operation, may lag. Tests poll, they never read
 *    once straight after a write.
 *
 * No method spans more than one document transactionally, and callers must not
 * assume one (ADR-005 rule 3).
 */
export interface DocumentStore {
  readonly capabilities: DocumentStoreCapabilities;

  /** Create schema or containers. Idempotent, safe to call on every start. */
  init(): Promise<void>;
  close(): Promise<void>;

  // Pages. Source of truth.

  /** Immediate. */
  getPage(workspaceId: WorkspaceId, id: Id): Promise<Page | null>;

  /**
   * Immediate. Pass `expectedVersion: null` to create, or the version last
   * read to update. The new version, actor and time come from `meta`: the
   * adapter stores them as given and never invents its own (ADR-008 rule 5).
   *
   * @throws VersionConflictError carrying the current page.
   */
  putPage(
    workspaceId: WorkspaceId,
    id: Id,
    input: PageInput,
    expectedVersion: ExpectedVersion,
    meta: WriteMeta,
  ): Promise<Page>;

  /** Immediate. @throws VersionConflictError */
  deletePage(
    workspaceId: WorkspaceId,
    id: Id,
    expectedVersion: ExpectedVersion,
  ): Promise<void>;

  /** Eventual. `parentId` of null lists roots, undefined lists everything. */
  listPages(
    workspaceId: WorkspaceId,
    options?: { parentId?: Id | null; limit?: number; cursor?: string | null },
  ): Promise<Paged<Page>>;

  // Edges. Derived, rebuildable, idempotent.

  /**
   * Replaces every edge whose source is `sourceId`. The only way to write
   * edges (ADR-005 rule 2). Calling it twice with the same input leaves the
   * same state.
   */
  replaceEdgesForSource(
    workspaceId: WorkspaceId,
    sourceId: Id,
    edges: EdgeInput[],
  ): Promise<void>;

  /** Eventual. */
  getOutboundEdges(workspaceId: WorkspaceId, sourceId: Id): Promise<Edge[]>;

  /** Eventual. Backlinks. One partition query, never a scan. */
  getInboundEdges(workspaceId: WorkspaceId, targetId: Id): Promise<Edge[]>;

  // Tables and rows.

  /** Immediate. */
  getTable(workspaceId: WorkspaceId, id: Id): Promise<Table | null>;

  /** Immediate. @throws VersionConflictError */
  putTable(
    workspaceId: WorkspaceId,
    id: Id,
    input: TableInput,
    expectedVersion: ExpectedVersion,
    meta: WriteMeta,
  ): Promise<Table>;

  /** Eventual. */
  listTables(workspaceId: WorkspaceId): Promise<Table[]>;

  /** Immediate. */
  getRow(workspaceId: WorkspaceId, tableId: Id, id: Id): Promise<Row | null>;

  /**
   * Immediate. Validation happens in core before this is called, so an adapter
   * never inspects field semantics.
   *
   * @throws VersionConflictError
   */
  putRow(
    workspaceId: WorkspaceId,
    tableId: Id,
    id: Id,
    input: RowInput,
    expectedVersion: ExpectedVersion,
    meta: WriteMeta,
  ): Promise<Row>;

  /** Immediate. @throws VersionConflictError */
  deleteRow(
    workspaceId: WorkspaceId,
    tableId: Id,
    id: Id,
    expectedVersion: ExpectedVersion,
  ): Promise<void>;

  /**
   * Eventual. Unfiltered, unsorted, paged. This is the lowest common
   * denominator every adapter must provide, and what core filters in memory.
   */
  listRows(
    workspaceId: WorkspaceId,
    tableId: Id,
    options?: { limit?: number; cursor?: string | null },
  ): Promise<Paged<Row>>;

  /**
   * Eventual. Optional pushdown of the filter grammar. Only called when
   * `capabilities.rowQueryPushdown` is true. Must return what core's in-memory
   * evaluation returns for the same query.
   */
  queryRows?(
    workspaceId: WorkspaceId,
    tableId: Id,
    query: RowQuery,
  ): Promise<Paged<Row>>;

  // Revisions. Source of truth for history (ADR-008). Immutable once written.

  /**
   * Immediate. Writes a new revision. Keyed by kind, record and version, and
   * never overwritten: the version is fresh, so this cannot conflict with a
   * concurrent writer.
   */
  putRevision(workspaceId: WorkspaceId, revision: RevisionInput): Promise<void>;

  /** Immediate. */
  getRevision(
    workspaceId: WorkspaceId,
    kind: RevisionKind,
    recordId: Id,
    version: Version,
  ): Promise<Revision | null>;

  /**
   * Removes a revision whose record write failed on a version conflict, so it
   * never appears in recent changes. The only case in which a revision is
   * deleted. Idempotent.
   */
  deleteRevision(
    workspaceId: WorkspaceId,
    kind: RevisionKind,
    recordId: Id,
    version: Version,
  ): Promise<void>;

  /**
   * Eventual. Every revision of one record, newest first. May include a
   * revision off the chain; core walks the chain to decide what to show.
   */
  listRevisions(
    workspaceId: WorkspaceId,
    kind: RevisionKind,
    recordId: Id,
    options?: { limit?: number; cursor?: string | null },
  ): Promise<Paged<Revision>>;

  /**
   * Eventual. Revisions across the workspace, newest first, for the review
   * console's recent changes. `actorKind` filters to people or agents.
   */
  listRecentRevisions(
    workspaceId: WorkspaceId,
    options?: {
      limit?: number;
      cursor?: string | null;
      actorKind?: Actor["kind"];
    },
  ): Promise<Paged<Revision>>;

  /**
   * Eventual. Pages currently deleted: for each page id with no current row,
   * its newest revision, when that revision is itself the deletion (ADR-059).
   * Newest deletion first. The deletion revision's snapshot holds the page's
   * last content, which is what `undelete` recreates it from.
   */
  listDeletedPages(
    workspaceId: WorkspaceId,
    options?: { limit?: number; cursor?: string | null },
  ): Promise<Paged<Revision>>;

  // Maintenance.

  /**
   * Every page id in the workspace, for the derived-data rebuild (PRD P0.9).
   * Streams so a rebuild never loads the workspace into memory.
   */
  iteratePageIds(workspaceId: WorkspaceId): AsyncIterable<Id>;

  /**
   * Immediate. Deletes every revision of one record except `keep`, so only
   * its current content stays reachable (ADR-059). Irreversible: the pruned
   * revisions' snapshots are gone for good. Returns how many were removed.
   */
  pruneRevisions(
    workspaceId: WorkspaceId,
    kind: RevisionKind,
    recordId: Id,
    keep: Version,
  ): Promise<number>;

  /**
   * Optional. Reclaims space an adapter can free after `pruneRevisions`, such
   * as SQLite's `VACUUM`. Adapters with nothing to reclaim, or nowhere local
   * to reclaim it, omit this; `vacuum` then just prunes (ADR-059).
   */
  compact?(): Promise<void>;
}

/**
 * How long a derived read may lag a write. Matches PRD P0.3. The conformance
 * suite polls to this bound, and the indexer is expected to beat it.
 */
export const EVENTUAL_CONSISTENCY_BOUND_MS = 10_000;
