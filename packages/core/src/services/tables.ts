import { NotFoundError, ValidationError } from "../errors.js";
import { newTableId, newRowId, newVersion, revisionRecordId, rowNodeId } from "../ids.js";
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
import { validateQuery, validateRow, validateSchema } from "../query/validate.js";
import { normalizeSources } from "../sources.js";
import { editTime } from "../edit-time.js";
import { sourceChanges } from "./pages.js";
import type {
  Table,
  TableInput,
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
  /** Sources this revision added, and ones it dropped (ADR-027). */
  sourcesAdded: string[];
  sourcesRemoved: string[];
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
 * Tables and rows.
 *
 * Filtering and sorting run here, in memory, over one table (ADR-005 rule
 * 5). An adapter that declares `rowQueryPushdown` handles the same query
 * natively, and the conformance suite proves the two agree.
 */
export class TableService {
  constructor(private readonly store: DocumentStore) {}

  async get(workspaceId: WorkspaceId, id: Id): Promise<Table> {
    const table = await this.store.getTable(workspaceId, id);
    if (!table) throw new NotFoundError("table", id);
    return table;
  }

  async list(workspaceId: WorkspaceId): Promise<Table[]> {
    return this.store.listTables(workspaceId);
  }

  /** Schemas are not versioned yet (ADR-008 consequence 5), but carry an actor. */
  async create(
    workspaceId: WorkspaceId,
    input: TableInput,
    context: WriteContext,
    id: Id = newTableId(),
  ): Promise<Table> {
    await this.checkSchema(workspaceId, id, input);
    return this.store.putTable(
      workspaceId,
      id,
      { ...input, parentId: input.parentId ?? null, description: input.description ?? null },
      null,
      {
        version: newVersion(),
        actor: context.actor,
        at: new Date().toISOString(),
      },
    );
  }

  /**
   * Replace a table's name and schema, and move it when `parentId` is
   * given (ADR-024). Changing a relation field re-derives the links of every
   * row in the table, since they come from the schema as well as the row.
   */
  async update(
    workspaceId: WorkspaceId,
    id: Id,
    input: TableInput,
    expectedVersion: ExpectedVersion,
    context: WriteContext,
  ): Promise<Table> {
    await this.checkSchema(workspaceId, id, input);
    const before = await this.store.getTable(workspaceId, id);
    const parentId = input.parentId !== undefined ? input.parentId : (before?.parentId ?? null);
    const description = input.description !== undefined ? input.description : (before?.description ?? null);
    const table = await this.store.putTable(workspaceId, id, { ...input, parentId, description }, expectedVersion, {
      version: newVersion(),
      actor: context.actor,
      at: new Date().toISOString(),
    });
    const relations = (c: Table | null) => JSON.stringify((c?.fields ?? []).filter((f) => f.type === "relation"));
    if (before && relations(before) !== relations(table)) await this.relinkRows(table);
    return table;
  }

  /** Move a table under a page, or to the top with null. */
  async move(
    workspaceId: WorkspaceId,
    id: Id,
    parentId: Id | null,
    expectedVersion: Version,
    context: WriteContext,
  ): Promise<Table> {
    const table = await this.get(workspaceId, id);
    return this.update(workspaceId, id, { name: table.name, fields: table.fields, parentId }, expectedVersion, context);
  }

  /** Tables directly under a page, or at the top for null. */
  async children(workspaceId: WorkspaceId, parentId: Id | null): Promise<Table[]> {
    return (await this.list(workspaceId)).filter((table) => table.parentId === parentId);
  }

  /** Pages and rows linking to this row. Eventually consistent, like page backlinks. */
  async rowBacklinks(workspaceId: WorkspaceId, tableId: Id, id: Id): Promise<Edge[]> {
    return this.store.getInboundEdges(workspaceId, rowNodeId(tableId, id));
  }

  /** This row's own links, from its relation fields. */
  async rowLinks(workspaceId: WorkspaceId, tableId: Id, id: Id): Promise<Edge[]> {
    return this.store.getOutboundEdges(workspaceId, rowNodeId(tableId, id));
  }

  /** Pages linking to the table itself, with `[[table-id]]`. */
  async backlinks(workspaceId: WorkspaceId, id: Id): Promise<Edge[]> {
    return this.store.getInboundEdges(workspaceId, id);
  }

  /**
   * Regenerates every row's links in the workspace (PRD P0.9), for reindex.
   * Idempotent: `replaceEdgesForSource` writes the same edges each time.
   */
  async rebuildWorkspace(workspaceId: WorkspaceId): Promise<{ rows: number }> {
    let rows = 0;
    for (const table of await this.list(workspaceId)) rows += await this.relinkRows(table);
    return { rows };
  }

  /**
   * True when rows hold relation values but their links were never derived:
   * rows written before relations became links (ADR-024). Looks at the first
   * row with a relation value, so it stays cheap on every start.
   */
  async needsRelink(workspaceId: WorkspaceId): Promise<boolean> {
    for (const table of await this.list(workspaceId)) {
      if (!table.fields.some((field) => field.type === "relation")) continue;
      const batch = await this.store.listRows(workspaceId, table.id, { limit: 50, cursor: null });
      const linked = batch.items.find((row) => extractRowReferences(table, row).length > 0);
      if (!linked) continue;
      return (await this.store.getOutboundEdges(workspaceId, rowNodeId(table.id, linked.id))).length === 0;
    }
    return false;
  }

  private async relinkRows(table: Table): Promise<number> {
    let count = 0;
    let cursor: string | null = null;
    do {
      const batch: Paged<Row> = await this.store.listRows(table.workspaceId, table.id, { limit: 500, cursor });
      for (const row of batch.items) {
        await this.store.replaceEdgesForSource(table.workspaceId, rowNodeId(table.id, row.id), extractRowReferences(table, row));
        count += 1;
      }
      cursor = batch.cursor;
    } while (cursor !== null);
    return count;
  }

  private async checkSchema(workspaceId: WorkspaceId, id: Id, input: TableInput): Promise<void> {
    const existing = new Set((await this.list(workspaceId)).map((table) => table.id));
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
    tableId: Id,
    input: RowInput,
    context: WriteContext,
    options: { id?: Id; expectedVersion?: ExpectedVersion } = {},
  ): Promise<Row> {
    const table = await this.get(workspaceId, tableId);
    const errors = validateRow(table, input);
    if (errors.length > 0) throw new ValidationError(errors);

    const id = options.id ?? newRowId();
    const expectedVersion =
      options.expectedVersion !== undefined ? options.expectedVersion : null;
    const current = expectedVersion === null ? null : await this.store.getRow(workspaceId, tableId, id);
    // Omitted sources on an update keep the row's own, as for pages (ADR-027).
    const sources = input.sources !== undefined ? normalizeSources(input.sources) : (current?.sources ?? []);
    input = { ...input, sources, editedAt: editTime(current?.editedAt, input.editedAt) };

    const row = await writeWithRevision(
      this.store,
      {
        workspaceId,
        kind: "row",
        recordId: revisionRecordId("row", id, tableId),
        tableId,
        expectedVersion,
        snapshot: { tableId, values: input.values, sources },
      },
      context,
      (meta) => this.store.putRow(workspaceId, tableId, id, input, expectedVersion, meta),
    );
    // Derived data after the row, as for pages: a crash in between is
    // repaired by reindex (ADR-005 rules 2 and 3).
    await this.store.replaceEdgesForSource(workspaceId, rowNodeId(tableId, id), extractRowReferences(table, row));
    return row;
  }

  async getRow(
    workspaceId: WorkspaceId,
    tableId: Id,
    id: Id,
  ): Promise<Row> {
    const row = await this.store.getRow(workspaceId, tableId, id);
    if (!row) throw new NotFoundError("row", id);
    return row;
  }

  /** Records a deletion revision holding the last values, then deletes. */
  async deleteRow(
    workspaceId: WorkspaceId,
    tableId: Id,
    id: Id,
    expectedVersion: Version,
    context: WriteContext,
  ): Promise<void> {
    const row = await this.getRow(workspaceId, tableId, id);
    await writeWithRevision(
      this.store,
      {
        workspaceId,
        kind: "row",
        recordId: revisionRecordId("row", id, tableId),
        tableId,
        expectedVersion,
        snapshot: { tableId, values: row.values, sources: row.sources },
        deleted: true,
      },
      context,
      () => this.store.deleteRow(workspaceId, tableId, id, expectedVersion),
    );
    await this.store.replaceEdgesForSource(workspaceId, rowNodeId(tableId, id), []);
  }

  // History (ADR-008).

  async rowHistory(
    workspaceId: WorkspaceId,
    tableId: Id,
    id: Id,
    options: { limit?: number } = {},
  ): Promise<Revision[]> {
    const row = await this.store.getRow(workspaceId, tableId, id);
    return readHistory(
      this.store,
      workspaceId,
      "row",
      revisionRecordId("row", id, tableId),
      row?.version ?? null,
      options,
    );
  }

  async rowRevision(
    workspaceId: WorkspaceId,
    tableId: Id,
    id: Id,
    version: Version,
  ): Promise<RowRevisionView> {
    const recordId = revisionRecordId("row", id, tableId);
    const revision = await this.store.getRevision(workspaceId, "row", recordId, version);
    if (!revision) throw new NotFoundError("revision", `${recordId}@${version}`);
    const snapshot = revision.snapshot as RowSnapshot;
    const parent = revision.parentVersion
      ? await this.store.getRevision(workspaceId, "row", recordId, revision.parentVersion)
      : null;
    const before = parent ? (parent.snapshot as RowSnapshot) : null;
    return {
      revision,
      snapshot,
      diff: before ? diffLines(valuesAsLines(before.values), valuesAsLines(snapshot.values)) : null,
      ...sourceChanges(before ? before.sources : [], snapshot.sources),
    };
  }

  /** Restore a row's values from an earlier revision, as a new revision. */
  async restoreRow(
    workspaceId: WorkspaceId,
    tableId: Id,
    id: Id,
    version: Version,
    expectedVersion: Version,
    context: WriteContext,
  ): Promise<Row> {
    const { snapshot } = await this.rowRevision(workspaceId, tableId, id, version);
    return this.upsertRow(
      workspaceId,
      tableId,
      snapshot.sources === undefined ? { values: snapshot.values } : { values: snapshot.values, sources: snapshot.sources },
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
    tableId: Id,
    query: RowQuery = {},
    options: { pushdown?: boolean } = {},
  ): Promise<Paged<Row>> {
    const table = await this.get(workspaceId, tableId);
    const errors = validateQuery(table, query);
    if (errors.length > 0) throw new ValidationError(errors);

    const pushdown = options.pushdown ?? true;
    if (pushdown && this.store.capabilities.rowQueryPushdown && this.store.queryRows) {
      return this.store.queryRows(workspaceId, tableId, query);
    }
    return this.queryRowsInMemory(workspaceId, tableId, query);
  }

  private async queryRowsInMemory(
    workspaceId: WorkspaceId,
    tableId: Id,
    query: RowQuery,
  ): Promise<Paged<Row>> {
    const limit = clampLimit(query.limit);
    const offset = decodeOffsetCursor(query.cursor);

    const rows: Row[] = [];
    let cursor: string | null = null;
    do {
      const batch: Paged<Row> = await this.store.listRows(workspaceId, tableId, {
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
