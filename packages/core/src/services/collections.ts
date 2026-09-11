import { NotFoundError, ValidationError } from "../errors.js";
import { newCollectionId, newRowId } from "../ids.js";
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
  Row,
  RowInput,
  WorkspaceId,
} from "../types.js";

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

  async create(
    workspaceId: WorkspaceId,
    input: CollectionInput,
    id: Id = newCollectionId(),
  ): Promise<Collection> {
    return this.store.putCollection(workspaceId, id, input, null);
  }

  async update(
    workspaceId: WorkspaceId,
    id: Id,
    input: CollectionInput,
    expectedVersion: ExpectedVersion,
  ): Promise<Collection> {
    return this.store.putCollection(workspaceId, id, input, expectedVersion);
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
    options: { id?: Id; expectedVersion?: ExpectedVersion } = {},
  ): Promise<Row> {
    const collection = await this.get(workspaceId, collectionId);
    const errors = validateRow(collection, input);
    if (errors.length > 0) throw new ValidationError(errors);

    const id = options.id ?? newRowId();
    const expectedVersion =
      options.expectedVersion !== undefined ? options.expectedVersion : null;
    return this.store.putRow(workspaceId, collectionId, id, input, expectedVersion);
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

  async deleteRow(
    workspaceId: WorkspaceId,
    collectionId: Id,
    id: Id,
    expectedVersion: ExpectedVersion,
  ): Promise<void> {
    await this.store.deleteRow(workspaceId, collectionId, id, expectedVersion);
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
