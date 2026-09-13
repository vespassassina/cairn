import { NotFoundError, ValidationError } from "../errors.js";
import { newCollectionId, newRowId, newVersion, revisionRecordId, rowNodeId } from "../ids.js";
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
import { extractRowReferences } from "../indexer/extract.js";
import { validateRow, validateSchema } from "../query/validate.js";
import type {
  Collection,
  CollectionInput,
  Edge,
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
    await this.checkSchema(workspaceId, id, input);
    return this.store.putCollection(workspaceId, id, { ...input, parentId: input.parentId ?? null }, null, {
      version: newVersion(),
      actor: context.actor,
      at: new Date().toISOString(),
    });
  }

  /**
   * Replace a collection's name and schema, and move it when `parentId` is
   * given (ADR-024). Changing a relation field re-derives the links of every
   * row in the collection, since they come from the schema as well as the row.
   */
  async update(
    workspaceId: WorkspaceId,
    id: Id,
    input: CollectionInput,
    expectedVersion: ExpectedVersion,
    context: WriteContext,
  ): Promise<Collection> {
    await this.checkSchema(workspaceId, id, input);
    const before = await this.store.getCollection(workspaceId, id);
    const parentId = input.parentId !== undefined ? input.parentId : (before?.parentId ?? null);
    const collection = await this.store.putCollection(workspaceId, id, { ...input, parentId }, expectedVersion, {
      version: newVersion(),
      actor: context.actor,
      at: new Date().toISOString(),
    });
    const relations = (c: Collection | null) => JSON.stringify((c?.fields ?? []).filter((f) => f.type === "relation"));
    if (before && relations(before) !== relations(collection)) await this.relinkRows(collection);
    return collection;
  }

  /** Move a collection under a page, or to the top with null. */
  async move(
    workspaceId: WorkspaceId,
    id: Id,
    parentId: Id | null,
    expectedVersion: Version,
    context: WriteContext,
  ): Promise<Collection> {
    const collection = await this.get(workspaceId, id);
    return this.update(workspaceId, id, { name: collection.name, fields: collection.fields, parentId }, expectedVersion, context);
  }

  /** Collections directly under a page, or at the top for null. */
  async children(workspaceId: WorkspaceId, parentId: Id | null): Promise<Collection[]> {
    return (await this.list(workspaceId)).filter((collection) => collection.parentId === parentId);
  }

  /** Pages and rows linking to this row. Eventually consistent, like page backlinks. */
  async rowBacklinks(workspaceId: WorkspaceId, collectionId: Id, id: Id): Promise<Edge[]> {
    return this.store.getInboundEdges(workspaceId, rowNodeId(collectionId, id));
  }

  /** This row's own links, from its relation fields. */
  async rowLinks(workspaceId: WorkspaceId, collectionId: Id, id: Id): Promise<Edge[]> {
    return this.store.getOutboundEdges(workspaceId, rowNodeId(collectionId, id));
  }

  /** Pages linking to the collection itself, with `[[collection-id]]`. */
  async backlinks(workspaceId: WorkspaceId, id: Id): Promise<Edge[]> {
    return this.store.getInboundEdges(workspaceId, id);
  }

  /**
   * Regenerates every row's links in the workspace (PRD P0.9), for reindex.
   * Idempotent: `replaceEdgesForSource` writes the same edges each time.
   */
  async rebuildWorkspace(workspaceId: WorkspaceId): Promise<{ rows: number }> {
    let rows = 0;
    for (const collection of await this.list(workspaceId)) rows += await this.relinkRows(collection);
    return { rows };
  }

  /**
   * True when rows hold relation values but their links were never derived:
   * rows written before relations became links (ADR-024). Looks at the first
   * row with a relation value, so it stays cheap on every start.
   */
  async needsRelink(workspaceId: WorkspaceId): Promise<boolean> {
    for (const collection of await this.list(workspaceId)) {
      if (!collection.fields.some((field) => field.type === "relation")) continue;
      const batch = await this.store.listRows(workspaceId, collection.id, { limit: 50, cursor: null });
      const linked = batch.items.find((row) => extractRowReferences(collection, row).length > 0);
      if (!linked) continue;
      return (await this.store.getOutboundEdges(workspaceId, rowNodeId(collection.id, linked.id))).length === 0;
    }
    return false;
  }

  private async relinkRows(collection: Collection): Promise<number> {
    let count = 0;
    let cursor: string | null = null;
    do {
      const batch: Paged<Row> = await this.store.listRows(collection.workspaceId, collection.id, { limit: 500, cursor });
      for (const row of batch.items) {
        await this.store.replaceEdgesForSource(collection.workspaceId, rowNodeId(collection.id, row.id), extractRowReferences(collection, row));
        count += 1;
      }
      cursor = batch.cursor;
    } while (cursor !== null);
    return count;
  }

  private async checkSchema(workspaceId: WorkspaceId, id: Id, input: CollectionInput): Promise<void> {
    const existing = new Set((await this.list(workspaceId)).map((collection) => collection.id));
    const errors = validateSchema(id, input.fields, (target) => existing.has(target));
    if (errors.length > 0) throw new ValidationError(errors);
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

    const row = await writeWithRevision(
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
    // Derived data after the row, as for pages: a crash in between is
    // repaired by reindex (ADR-005 rules 2 and 3).
    await this.store.replaceEdgesForSource(workspaceId, rowNodeId(collectionId, id), extractRowReferences(collection, row));
    return row;
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
    await this.store.replaceEdgesForSource(workspaceId, rowNodeId(collectionId, id), []);
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
