import { NotFoundError, ValidationError } from "../errors.js";
import { newCollectionId, newRowId, newVersion, revisionRecordId } from "../ids.js";
import { diffLines, type Diff } from "../history/diff.js";
import { readHistory, writeWithRevision } from "../history/revisions.js";
import type { DocumentStore } from "../ports/document-store.js";
import {
  clampLimit,
  decodeOffsetCursor,
  encodeOffsetCursor,
  matchesQuery,
  sortRows,
  type RowQuery,
} from "../query/filter.js";
import { validateRow } from "../query/validate.js";
import type {
  Collection,
  CollectionInput,
  ExpectedVersion,
  Id,
  Paged,
  Revision,
  Row,
  RowInput,
  RowSnapshot,
  Version,
  WorkspaceId,
  WriteContext,
} from "../types.js";

/** A revision of a row, with its diff against the version it replaced. */
export interface RowRevisionView {
  revision: Revision;
  snapshot: RowSnapshot;
  /** One line per field, so a changed value reads as a one-line change. */
  diff: Diff | null;
}

function valuesAsLines(values: RowSnapshot["values"]): string {
  return Object.keys(values)
    .sort()
    .map((key) => `${key}: ${JSON.stringify(values[key])}`)
    .join("\n");
}

/** How many rows one in-memory query pass will pull from the store. */
const MAX_SCAN = 5_000;

/**
 * Collections and rows.
 *
 * Filtering and sorting run here, in memory, over one collection (ADR-005 rule
 * 5). An adapter that declares `rowQueryPushdown` handles the same query
 * natively, and the conformance suite proves the two agree.
 */
export class CollectionService {
  constructor(private readonly store: DocumentStore) {}

  async get(workspaceId: WorkspaceId, id: Id): Promise<Collection> {
    const collection = await this.store.getCollection(workspaceId, id);
    if (!collection) throw new NotFoundError("collection", id);
    return collection;
  }

  async list(workspaceId: WorkspaceId): Promise<Collection[]> {
    return this.store.listCollections(workspaceId);
  }

  /** Schemas are not versioned yet (ADR-008 consequence 5), but carry an actor. */
  async create(
    workspaceId: WorkspaceId,
    input: CollectionInput,
    context: WriteContext,
    id: Id = newCollectionId(),
  ): Promise<Collection> {
    return this.store.putCollection(workspaceId, id, input, null, {
      version: newVersion(),
      actor: context.actor,
      at: new Date().toISOString(),
    });
  }

  async update(
    workspaceId: WorkspaceId,
    id: Id,
    input: CollectionInput,
    expectedVersion: ExpectedVersion,
    context: WriteContext,
  ): Promise<Collection> {
    return this.store.putCollection(workspaceId, id, input, expectedVersion, {
      version: newVersion(),
      actor: context.actor,
      at: new Date().toISOString(),
    });
  }

  /**
   * Create or update a row. Validation happens before the write and reports
   * every bad field at once (PRD P0.4).
   *
   * @throws ValidationError with one entry per offending field.
   */
  async upsertRow(
    workspaceId: WorkspaceId,
    collectionId: Id,
    input: RowInput,
    context: WriteContext,
    options: { id?: Id; expectedVersion?: ExpectedVersion } = {},
  ): Promise<Row> {
    const collection = await this.get(workspaceId, collectionId);
    const errors = validateRow(collection, input);
    if (errors.length > 0) throw new ValidationError(errors);

    const id = options.id ?? newRowId();
    const expectedVersion =
      options.expectedVersion !== undefined ? options.expectedVersion : null;

    return writeWithRevision(
      this.store,
      {
        workspaceId,
        kind: "row",
        recordId: revisionRecordId("row", id, collectionId),
        collectionId,
        expectedVersion,
        snapshot: { collectionId, values: input.values },
      },
      context,
      (meta) => this.store.putRow(workspaceId, collectionId, id, input, expectedVersion, meta),
    );
  }

  async getRow(
    workspaceId: WorkspaceId,
    collectionId: Id,
    id: Id,
  ): Promise<Row> {
    const row = await this.store.getRow(workspaceId, collectionId, id);
    if (!row) throw new NotFoundError("row", id);
    return row;
  }

  /** Records a deletion revision holding the last values, then deletes. */
  async deleteRow(
    workspaceId: WorkspaceId,
    collectionId: Id,
    id: Id,
    expectedVersion: Version,
    context: WriteContext,
  ): Promise<void> {
    const row = await this.getRow(workspaceId, collectionId, id);
    await writeWithRevision(
      this.store,
      {
        workspaceId,
        kind: "row",
        recordId: revisionRecordId("row", id, collectionId),
        collectionId,
        expectedVersion,
        snapshot: { collectionId, values: row.values },
        deleted: true,
      },
      context,
      () => this.store.deleteRow(workspaceId, collectionId, id, expectedVersion),
    );
  }

  // History (ADR-008).

  async rowHistory(
    workspaceId: WorkspaceId,
    collectionId: Id,
    id: Id,
    options: { limit?: number } = {},
  ): Promise<Revision[]> {
    const row = await this.store.getRow(workspaceId, collectionId, id);
    return readHistory(
      this.store,
      workspaceId,
      "row",
      revisionRecordId("row", id, collectionId),
      row?.version ?? null,
      options,
    );
  }

  async rowRevision(
    workspaceId: WorkspaceId,
    collectionId: Id,
    id: Id,
    version: Version,
  ): Promise<RowRevisionView> {
    const recordId = revisionRecordId("row", id, collectionId);
    const revision = await this.store.getRevision(workspaceId, "row", recordId, version);
    if (!revision) throw new NotFoundError("revision", `${recordId}@${version}`);
    const snapshot = revision.snapshot as RowSnapshot;
    const parent = revision.parentVersion
      ? await this.store.getRevision(workspaceId, "row", recordId, revision.parentVersion)
      : null;
    return {
      revision,
      snapshot,
      diff: parent
        ? diffLines(
            valuesAsLines((parent.snapshot as RowSnapshot).values),
            valuesAsLines(snapshot.values),
          )
        : null,
    };
  }

  /** Restore a row's values from an earlier revision, as a new revision. */
  async restoreRow(
    workspaceId: WorkspaceId,
    collectionId: Id,
    id: Id,
    version: Version,
    expectedVersion: Version,
    context: WriteContext,
  ): Promise<Row> {
    const { snapshot } = await this.rowRevision(workspaceId, collectionId, id, version);
    return this.upsertRow(
      workspaceId,
      collectionId,
      { values: snapshot.values },
      { actor: context.actor, note: context.note ?? `Restored version ${version.slice(0, 8)}` },
      { id, expectedVersion },
    );
  }

  /**
   * Filter and sort rows. Uses the adapter's native implementation when it has
   * one, and core's in-memory evaluation otherwise. Both must agree.
   */
  async queryRows(
    workspaceId: WorkspaceId,
    collectionId: Id,
    query: RowQuery = {},
    options: { pushdown?: boolean } = {},
  ): Promise<Paged<Row>> {
    const pushdown = options.pushdown ?? true;
    if (pushdown && this.store.capabilities.rowQueryPushdown && this.store.queryRows) {
      return this.store.queryRows(workspaceId, collectionId, query);
    }
    return this.queryRowsInMemory(workspaceId, collectionId, query);
  }

  private async queryRowsInMemory(
    workspaceId: WorkspaceId,
    collectionId: Id,
    query: RowQuery,
  ): Promise<Paged<Row>> {
    const limit = clampLimit(query.limit);
    const offset = decodeOffsetCursor(query.cursor);

    const rows: Row[] = [];
    let cursor: string | null = null;
    do {
      const batch: Paged<Row> = await this.store.listRows(workspaceId, collectionId, {
        limit: 500,
        cursor,
      });
      rows.push(...batch.items);
      cursor = batch.cursor;
    } while (cursor !== null && rows.length < MAX_SCAN);

    const matched = sortRows(
      rows.filter((row) => matchesQuery(row, query.where)),
      query.sort,
    );
    const window = matched.slice(offset, offset + limit);
    const nextOffset = offset + window.length;

    return {
      items: window,
      cursor: nextOffset < matched.length ? encodeOffsetCursor(nextOffset) : null,
    };
  }
}
