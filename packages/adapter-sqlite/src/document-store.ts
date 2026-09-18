import { rename, rm, stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  VersionConflictError,
  type SnapshotResult,
  type Actor,
  type Table,
  type TableInput,
  type DocumentStore,
  type DocumentStoreCapabilities,
  type Edge,
  type EdgeInput,
  type ExpectedVersion,
  type Id,
  type Page,
  type PageInput,
  type Paged,
  type Revision,
  type RevisionInput,
  type RevisionKind,
  type Row,
  type RowInput,
  type Version,
  type WorkspaceId,
  type WriteMeta,
} from "@cairn/core";

/**
 * SQLite document store, on Node's built-in `node:sqlite`. No native build
 * step, no dependency.
 *
 * This adapter is the reference implementation and the one CI always runs
 * (PRD R3). It declares no pushdown capability: table filtering stays in
 * core, which keeps the in-memory path exercised on every run.
 */

/**
 * The actor recorded for rows written before revisions existed (ADR-008).
 * Used as a column default so an existing database migrates in place.
 */
const LEGACY_ACTOR = JSON.stringify({
  kind: "user",
  id: "legacy",
  label: "Before history was recorded",
} satisfies Actor);

// Tables are stored under the name they had before ADR-026: the
// `collections` table and the `collection_id` columns. Storage names are
// private to this adapter, and keeping them needs no migration.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  workspace_id TEXT NOT NULL,
  id           TEXT NOT NULL,
  title        TEXT NOT NULL,
  parent_id    TEXT,
  tags         TEXT NOT NULL,
  body         TEXT NOT NULL,
  sources      TEXT NOT NULL DEFAULT '[]',
  verified_at  TEXT,
  edited_at    TEXT,
  public       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  updated_by   TEXT NOT NULL DEFAULT '${LEGACY_ACTOR}',
  version      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS pages_by_parent
  ON pages (workspace_id, parent_id, id);

CREATE TABLE IF NOT EXISTS edges (
  workspace_id TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  type         TEXT NOT NULL,
  label        TEXT,
  PRIMARY KEY (workspace_id, source_id, target_id, type)
);
CREATE INDEX IF NOT EXISTS edges_by_target
  ON edges (workspace_id, target_id);

CREATE TABLE IF NOT EXISTS collections (
  workspace_id TEXT NOT NULL,
  id           TEXT NOT NULL,
  name         TEXT NOT NULL,
  fields       TEXT NOT NULL,
  parent_id    TEXT,
  description  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  updated_by   TEXT NOT NULL DEFAULT '${LEGACY_ACTOR}',
  version      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS revisions (
  workspace_id   TEXT NOT NULL,
  kind           TEXT NOT NULL,
  record_id      TEXT NOT NULL,
  version        TEXT NOT NULL,
  collection_id  TEXT,
  parent_version TEXT,
  actor          TEXT NOT NULL,
  actor_kind     TEXT NOT NULL,
  note           TEXT,
  created_at     TEXT NOT NULL,
  deleted        INTEGER NOT NULL,
  snapshot       TEXT NOT NULL,
  PRIMARY KEY (workspace_id, kind, record_id, version)
);
CREATE INDEX IF NOT EXISTS revisions_by_record
  ON revisions (workspace_id, kind, record_id, created_at DESC, version DESC);
CREATE INDEX IF NOT EXISTS revisions_recent
  ON revisions (workspace_id, created_at DESC, version DESC);
CREATE INDEX IF NOT EXISTS revisions_recent_by_actor
  ON revisions (workspace_id, actor_kind, created_at DESC, version DESC);

CREATE TABLE IF NOT EXISTS rows_ (
  workspace_id  TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  id            TEXT NOT NULL,
  values_       TEXT NOT NULL,
  sources       TEXT NOT NULL DEFAULT '[]',
  edited_at     TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  updated_by    TEXT NOT NULL DEFAULT '${LEGACY_ACTOR}',
  version       TEXT NOT NULL,
  PRIMARY KEY (workspace_id, collection_id, id)
);
`;

interface PageRecord {
  workspace_id: string;
  id: string;
  title: string;
  parent_id: string | null;
  tags: string;
  body: string;
  sources: string;
  verified_at: string | null;
  edited_at: string | null;
  public: number | null;
  created_at: string;
  updated_at: string;
  updated_by: string;
  version: string;
}

interface TableRecord {
  workspace_id: string;
  id: string;
  name: string;
  fields: string;
  parent_id: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string;
  version: string;
}

interface RowRecord {
  workspace_id: string;
  collection_id: string;
  id: string;
  values_: string;
  sources: string;
  edited_at: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string;
  version: string;
}

interface RevisionRecord {
  workspace_id: string;
  kind: string;
  record_id: string;
  version: string;
  collection_id: string | null;
  parent_version: string | null;
  actor: string;
  actor_kind: string;
  note: string | null;
  created_at: string;
  deleted: number;
  snapshot: string;
}

/** A revision row as read back with its SQLite rowid (see listRevisions). */
type RevisionRow = RevisionRecord & { rowid: number };

function toRevision(record: RevisionRecord): Revision {
  return {
    workspaceId: record.workspace_id,
    kind: record.kind as RevisionKind,
    recordId: record.record_id,
    tableId: record.collection_id,
    version: record.version,
    parentVersion: record.parent_version,
    actor: JSON.parse(record.actor) as Actor,
    note: record.note,
    createdAt: record.created_at,
    deleted: record.deleted === 1,
    snapshot: JSON.parse(record.snapshot) as Revision["snapshot"],
  };
}

/**
 * Keyset cursor for revision lists: the last item's time and rowid.
 * Not `version`: version is a random UUID (packages/core/src/ids.ts), so
 * ordering or bounding by it within the same created_at millisecond is
 * meaningless. rowid is SQLite's own monotonic insertion order (see
 * listRevisions and listDeletedPages, which caught this as a CI flake).
 */
function encodeRevisionCursor(row: RevisionRow): string {
  return Buffer.from(JSON.stringify([row.created_at, row.rowid]), "utf8").toString("base64url");
}

function decodeRevisionCursor(cursor: string | null | undefined): [string, number] | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    return Array.isArray(value) && value.length === 2 && Number.isFinite(Number(value[1]))
      ? [String(value[0]), Number(value[1])]
      : null;
  } catch {
    return null;
  }
}

/**
 * `node:sqlite` types every column as `SQLOutputValue`, so reading a row back
 * into its record type needs one widening step. Kept in one place rather than
 * repeated as a cast at every call site.
 */
function asRecords<T>(records: unknown[]): T[] {
  return records as T[];
}


function toPage(record: PageRecord): Page {
  return {
    id: record.id,
    workspaceId: record.workspace_id,
    title: record.title,
    parentId: record.parent_id,
    tags: JSON.parse(record.tags) as string[],
    body: record.body,
    sources: JSON.parse(record.sources) as string[],
    verifiedAt: record.verified_at,
    editedAt: record.edited_at ?? record.updated_at,
    public: record.public === 1,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    updatedBy: JSON.parse(record.updated_by) as Actor,
    version: record.version,
  };
}

function toTable(record: TableRecord): Table {
  return {
    id: record.id,
    workspaceId: record.workspace_id,
    name: record.name,
    fields: JSON.parse(record.fields) as Table["fields"],
    parentId: record.parent_id ?? null,
    description: record.description ?? null,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    updatedBy: JSON.parse(record.updated_by) as Actor,
    version: record.version,
  };
}

function toRow(record: RowRecord): Row {
  return {
    id: record.id,
    workspaceId: record.workspace_id,
    tableId: record.collection_id,
    values: JSON.parse(record.values_) as Row["values"],
    sources: JSON.parse(record.sources) as string[],
    editedAt: record.edited_at ?? record.updated_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    updatedBy: JSON.parse(record.updated_by) as Actor,
    version: record.version,
  };
}

/** Cursors are the last id of the previous batch, base64url encoded. */
function encodeCursor(lastId: string): string {
  return Buffer.from(lastId, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): string {
  return cursor ? Buffer.from(cursor, "base64url").toString("utf8") : "";
}

function clampLimit(limit: number | undefined, fallback = 50): number {
  if (limit === undefined) return fallback;
  return Math.max(1, Math.min(1_000, Math.trunc(limit)));
}

export interface SqliteDocumentStoreOptions {
  /** File path, or `:memory:` for an ephemeral store. */
  location?: string;
}

export class SqliteDocumentStore implements DocumentStore {
  readonly capabilities: DocumentStoreCapabilities = {
    rowQueryPushdown: false,
  };

  private readonly db: DatabaseSync;

  constructor(options: SqliteDocumentStoreOptions = {}) {
    this.db = new DatabaseSync(options.location ?? ":memory:");
    this.db.exec("PRAGMA journal_mode = WAL");
    // Other connections share the file (search index, auth store, Litestream):
    // wait for a lock instead of failing with "database is locked".
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  async init(): Promise<void> {
    // Tables created before revisions existed lack `updated_by`. CREATE TABLE
    // IF NOT EXISTS does not add columns, so add it here before the schema's
    // indexes run. Idempotent.
    for (const table of ["pages", "collections", "rows_"]) {
      const exists = this.db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (!exists) continue;
      const columns = asRecords<{ name: string }>(
        this.db.prepare(`PRAGMA table_info(${table})`).all(),
      );
      if (!columns.some((column) => column.name === "updated_by")) {
        this.db.exec(
          `ALTER TABLE ${table} ADD COLUMN updated_by TEXT NOT NULL DEFAULT '${LEGACY_ACTOR}'`,
        );
      }
      // Tables gained a place in the page tree (ADR-024).
      if (table === "collections" && !columns.some((column) => column.name === "parent_id")) {
        this.db.exec("ALTER TABLE collections ADD COLUMN parent_id TEXT");
      }
      // Tables gained a one-line description (ADR-058).
      if (table === "collections" && !columns.some((column) => column.name === "description")) {
        this.db.exec("ALTER TABLE collections ADD COLUMN description TEXT");
      }
      // Pages and rows gained sources (ADR-027).
      if (table !== "collections" && !columns.some((column) => column.name === "sources")) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN sources TEXT NOT NULL DEFAULT '[]'`);
      }
      // Pages gained a verification time (ADR-028).
      if (table === "pages" && !columns.some((column) => column.name === "verified_at")) {
        this.db.exec("ALTER TABLE pages ADD COLUMN verified_at TEXT");
      }
      // Pages and rows gained an edit time (ADR-030). Until a record is next
      // written, its edit time reads as its update time.
      if (table !== "collections" && !columns.some((column) => column.name === "edited_at")) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN edited_at TEXT`);
      }
      // Pages gained a published flag (ADR-032). Every page that existed
      // before it is private, which is the only safe migration.
      if (table === "pages" && !columns.some((column) => column.name === "public")) {
        this.db.exec("ALTER TABLE pages ADD COLUMN public INTEGER NOT NULL DEFAULT 0");
      }
    }
    this.db.exec(SCHEMA);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  /**
   * A backup, made the only way that cannot carry damage forward (ADR-049).
   *
   * `VACUUM INTO` does not copy pages. It reads the database through its
   * B-trees and writes a brand new file, so the result is a logical
   * reconstruction with a fresh page layout rather than a byte mirror. Two
   * things follow, both measured rather than assumed:
   *
   * 1. A corrupt source is refused, with "database disk image is malformed",
   *    instead of being copied into the backup. This is the difference
   *    between a backup and Litestream, which replicates damage faithfully
   *    because it works at the page level (docs/LESSONS.md).
   * 2. The copy is self-contained and current. Changes still sitting in the
   *    write-ahead log are included, and the copy has no log of its own, so
   *    it can be moved or uploaded as one file.
   *
   * It is also cheap: 9ms for a 7MB database, twice the size of the Cairn
   * this was written for, which is what makes it affordable on a write and
   * during the seconds available at shutdown.
   *
   * The catch, and the reason for the temporary file: a refused vacuum still
   * leaves a partial file at the destination. A truncated file that looks
   * like a backup is precisely the failure this whole change exists to
   * prevent, so the copy is built under a temporary name, read back, and only
   * then given its real one.
   */
  async snapshot(destination: string): Promise<SnapshotResult> {
    const partial = `${destination}.partial`;
    await rm(partial, { force: true });
    const started = Date.now();
    try {
      // A bound parameter, not interpolation: the path is a string literal to
      // SQLite, and one containing a quote would otherwise be a syntax error.
      this.db.prepare("VACUUM INTO ?").run(partial);
    } catch (error) {
      await rm(partial, { force: true });
      throw new Error(
        `could not copy the database: ${error instanceof Error ? error.message : String(error)}. ` +
          "A vacuum refuses a database it cannot read soundly, so this usually means the database itself is damaged rather than that the copy failed. " +
          "Check it with: sqlite3 <database> 'pragma integrity_check'",
        { cause: error },
      );
    }

    // Reading it back is the whole difference between a file and a backup.
    let readBack: DatabaseSync | null = null;
    try {
      readBack = new DatabaseSync(partial, { readOnly: true });
      const row = readBack.prepare("PRAGMA integrity_check").get() as
        | { integrity_check?: string }
        | undefined;
      if (row?.integrity_check !== "ok") {
        throw new Error(`the copy did not pass its integrity check: ${row?.integrity_check ?? "no answer"}`);
      }
    } catch (error) {
      readBack?.close();
      await rm(partial, { force: true });
      throw new Error(
        `the copy of the database could not be read back: ${error instanceof Error ? error.message : String(error)}. ` +
          "It has been deleted rather than kept, because a backup that cannot be read is worse than none: it is the one you would reach for.",
        { cause: error },
      );
    }
    readBack.close();

    const { size } = await stat(partial);
    // Only now does it get the name a restore would look for.
    await rename(partial, destination);
    return { bytes: size, ms: Date.now() - started };
  }

  // Pages.

  async getPage(workspaceId: WorkspaceId, id: Id): Promise<Page | null> {
    const record = this.db
      .prepare("SELECT * FROM pages WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, id) as PageRecord | undefined;
    return record ? toPage(record) : null;
  }

  async putPage(
    workspaceId: WorkspaceId,
    id: Id,
    input: PageInput,
    expectedVersion: ExpectedVersion,
    meta: WriteMeta,
  ): Promise<Page> {
    const existing = await this.getPage(workspaceId, id);
    this.assertVersion("page", id, existing, expectedVersion);

    const page: Page = {
      id,
      workspaceId,
      title: input.title,
      parentId: input.parentId ?? null,
      tags: input.tags ?? [],
      body: input.body,
      sources: input.sources ?? [],
      verifiedAt: input.verifiedAt ?? null,
      editedAt: input.editedAt ?? meta.at,
      public: input.public ?? existing?.public ?? false,
      createdAt: existing?.createdAt ?? meta.at,
      updatedAt: meta.at,
      updatedBy: meta.actor,
      version: meta.version,
    };

    // The WHERE clause makes the check-and-set atomic, so two concurrent
    // writers cannot both pass the read above.
    const applied = existing
      ? this.db
          .prepare(
            `UPDATE pages SET title = ?, parent_id = ?, tags = ?, body = ?, sources = ?, verified_at = ?,
             edited_at = ?, public = ?, updated_at = ?, updated_by = ?, version = ?
             WHERE workspace_id = ? AND id = ? AND version = ?`,
          )
          .run(
            page.title,
            page.parentId,
            JSON.stringify(page.tags),
            page.body,
            JSON.stringify(page.sources),
            page.verifiedAt,
            page.editedAt,
            page.public ? 1 : 0,
            page.updatedAt,
            JSON.stringify(page.updatedBy),
            page.version,
            workspaceId,
            id,
            existing.version,
          )
      : this.db
          .prepare(
            `INSERT OR IGNORE INTO pages
             (workspace_id, id, title, parent_id, tags, body, sources, verified_at, edited_at, public, created_at, updated_at, updated_by, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            workspaceId,
            id,
            page.title,
            page.parentId,
            JSON.stringify(page.tags),
            page.body,
            JSON.stringify(page.sources),
            page.verifiedAt,
            page.editedAt,
            page.public ? 1 : 0,
            page.createdAt,
            page.updatedAt,
            JSON.stringify(page.updatedBy),
            page.version,
          );

    if (applied.changes === 0) {
      throw new VersionConflictError(
        "page",
        id,
        expectedVersion,
        await this.getPage(workspaceId, id),
      );
    }
    return page;
  }

  async deletePage(
    workspaceId: WorkspaceId,
    id: Id,
    expectedVersion: ExpectedVersion,
  ): Promise<void> {
    const existing = await this.getPage(workspaceId, id);
    this.assertVersion("page", id, existing, expectedVersion);
    this.db
      .prepare("DELETE FROM pages WHERE workspace_id = ? AND id = ? AND version = ?")
      .run(workspaceId, id, existing!.version);
  }

  async listPages(
    workspaceId: WorkspaceId,
    options: { parentId?: Id | null; limit?: number; cursor?: string | null } = {},
  ): Promise<Paged<Page>> {
    const limit = clampLimit(options.limit);
    const after = decodeCursor(options.cursor);

    // Three statements rather than one with a dynamic WHERE clause, so each
    // stays a fixed string that SQLite can prepare and cache.
    const [sql, params]: [string, Array<string | number>] =
      options.parentId === undefined
        ? [
            `SELECT * FROM pages WHERE workspace_id = ? AND id > ?
             ORDER BY id LIMIT ?`,
            [workspaceId, after, limit + 1],
          ]
        : options.parentId === null
          ? [
              `SELECT * FROM pages WHERE workspace_id = ? AND parent_id IS NULL AND id > ?
               ORDER BY id LIMIT ?`,
              [workspaceId, after, limit + 1],
            ]
          : [
              `SELECT * FROM pages WHERE workspace_id = ? AND parent_id = ? AND id > ?
               ORDER BY id LIMIT ?`,
              [workspaceId, options.parentId, after, limit + 1],
            ];

    const records = asRecords<PageRecord>(
      this.db.prepare(sql).all(...params),
    );

    return this.paginate(records.map(toPage), limit);
  }

  async *iteratePageIds(workspaceId: WorkspaceId): AsyncIterable<Id> {
    let after = "";
    for (;;) {
      const batch = this.db
        .prepare(
          "SELECT id FROM pages WHERE workspace_id = ? AND id > ? ORDER BY id LIMIT 500",
        )
        .all(workspaceId, after) as Array<{ id: string }>;
      if (batch.length === 0) return;
      for (const record of batch) yield record.id;
      after = batch[batch.length - 1]!.id;
    }
  }

  async pruneRevisions(
    workspaceId: WorkspaceId,
    kind: RevisionKind,
    recordId: Id,
    keep: Version,
  ): Promise<number> {
    const result = this.db
      .prepare(
        "DELETE FROM revisions WHERE workspace_id = ? AND kind = ? AND record_id = ? AND version != ?",
      )
      .run(workspaceId, kind, recordId, keep);
    return Number(result.changes);
  }

  async compact(): Promise<void> {
    this.db.exec("VACUUM");
  }

  // Edges. Derived data, replaced wholesale per source (ADR-005 rule 2).

  async replaceEdgesForSource(
    workspaceId: WorkspaceId,
    sourceId: Id,
    edges: EdgeInput[],
  ): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM edges WHERE workspace_id = ? AND source_id = ?")
        .run(workspaceId, sourceId);
      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO edges (workspace_id, source_id, target_id, type, label)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const edge of edges) {
        insert.run(workspaceId, sourceId, edge.targetId, edge.type, edge.label);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async getOutboundEdges(workspaceId: WorkspaceId, sourceId: Id): Promise<Edge[]> {
    return this.readEdges(
      "SELECT * FROM edges WHERE workspace_id = ? AND source_id = ? ORDER BY target_id, type",
      workspaceId,
      sourceId,
    );
  }

  async getInboundEdges(workspaceId: WorkspaceId, targetId: Id): Promise<Edge[]> {
    return this.readEdges(
      "SELECT * FROM edges WHERE workspace_id = ? AND target_id = ? ORDER BY source_id, type",
      workspaceId,
      targetId,
    );
  }

  // Tables and rows.

  async getTable(workspaceId: WorkspaceId, id: Id): Promise<Table | null> {
    const record = this.db
      .prepare("SELECT * FROM collections WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, id) as TableRecord | undefined;
    return record ? toTable(record) : null;
  }

  async putTable(
    workspaceId: WorkspaceId,
    id: Id,
    input: TableInput,
    expectedVersion: ExpectedVersion,
    meta: WriteMeta,
  ): Promise<Table> {
    const existing = await this.getTable(workspaceId, id);
    this.assertVersion("table", id, existing, expectedVersion);

    const table: Table = {
      id,
      workspaceId,
      name: input.name,
      fields: input.fields,
      parentId: input.parentId ?? null,
      description: input.description ?? null,
      createdAt: existing?.createdAt ?? meta.at,
      updatedAt: meta.at,
      updatedBy: meta.actor,
      version: meta.version,
    };

    const applied = existing
      ? this.db
          .prepare(
            `UPDATE collections SET name = ?, fields = ?, parent_id = ?, description = ?, updated_at = ?, updated_by = ?, version = ?
             WHERE workspace_id = ? AND id = ? AND version = ?`,
          )
          .run(
            table.name,
            JSON.stringify(table.fields),
            table.parentId,
            table.description,
            table.updatedAt,
            JSON.stringify(table.updatedBy),
            table.version,
            workspaceId,
            id,
            existing.version,
          )
      : this.db
          .prepare(
            `INSERT OR IGNORE INTO collections
             (workspace_id, id, name, fields, parent_id, description, created_at, updated_at, updated_by, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            workspaceId,
            id,
            table.name,
            JSON.stringify(table.fields),
            table.parentId,
            table.description,
            table.createdAt,
            table.updatedAt,
            JSON.stringify(table.updatedBy),
            table.version,
          );

    if (applied.changes === 0) {
      throw new VersionConflictError(
        "table",
        id,
        expectedVersion,
        await this.getTable(workspaceId, id),
      );
    }
    return table;
  }

  async listTables(workspaceId: WorkspaceId): Promise<Table[]> {
    const records = asRecords<TableRecord>(
      this.db
        .prepare("SELECT * FROM collections WHERE workspace_id = ? ORDER BY id")
        .all(workspaceId),
    );
    return records.map(toTable);
  }

  async getRow(
    workspaceId: WorkspaceId,
    tableId: Id,
    id: Id,
  ): Promise<Row | null> {
    const record = this.db
      .prepare(
        "SELECT * FROM rows_ WHERE workspace_id = ? AND collection_id = ? AND id = ?",
      )
      .get(workspaceId, tableId, id) as RowRecord | undefined;
    return record ? toRow(record) : null;
  }

  async putRow(
    workspaceId: WorkspaceId,
    tableId: Id,
    id: Id,
    input: RowInput,
    expectedVersion: ExpectedVersion,
    meta: WriteMeta,
  ): Promise<Row> {
    const existing = await this.getRow(workspaceId, tableId, id);
    this.assertVersion("row", id, existing, expectedVersion);

    const row: Row = {
      id,
      workspaceId,
      tableId,
      values: input.values,
      sources: input.sources ?? [],
      editedAt: input.editedAt ?? meta.at,
      createdAt: existing?.createdAt ?? meta.at,
      updatedAt: meta.at,
      updatedBy: meta.actor,
      version: meta.version,
    };

    const applied = existing
      ? this.db
          .prepare(
            `UPDATE rows_ SET values_ = ?, sources = ?, edited_at = ?, updated_at = ?, updated_by = ?, version = ?
             WHERE workspace_id = ? AND collection_id = ? AND id = ? AND version = ?`,
          )
          .run(
            JSON.stringify(row.values),
            JSON.stringify(row.sources),
            row.editedAt,
            row.updatedAt,
            JSON.stringify(row.updatedBy),
            row.version,
            workspaceId,
            tableId,
            id,
            existing.version,
          )
      : this.db
          .prepare(
            `INSERT OR IGNORE INTO rows_
             (workspace_id, collection_id, id, values_, sources, edited_at, created_at, updated_at, updated_by, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            workspaceId,
            tableId,
            id,
            JSON.stringify(row.values),
            JSON.stringify(row.sources),
            row.editedAt,
            row.createdAt,
            row.updatedAt,
            JSON.stringify(row.updatedBy),
            row.version,
          );

    if (applied.changes === 0) {
      throw new VersionConflictError(
        "row",
        id,
        expectedVersion,
        await this.getRow(workspaceId, tableId, id),
      );
    }
    return row;
  }

  async deleteRow(
    workspaceId: WorkspaceId,
    tableId: Id,
    id: Id,
    expectedVersion: ExpectedVersion,
  ): Promise<void> {
    const existing = await this.getRow(workspaceId, tableId, id);
    this.assertVersion("row", id, existing, expectedVersion);
    this.db
      .prepare(
        `DELETE FROM rows_
         WHERE workspace_id = ? AND collection_id = ? AND id = ? AND version = ?`,
      )
      .run(workspaceId, tableId, id, existing!.version);
  }

  async listRows(
    workspaceId: WorkspaceId,
    tableId: Id,
    options: { limit?: number; cursor?: string | null } = {},
  ): Promise<Paged<Row>> {
    const limit = clampLimit(options.limit);
    const after = decodeCursor(options.cursor);
    const records = asRecords<RowRecord>(
      this.db
        .prepare(
          `SELECT * FROM rows_
           WHERE workspace_id = ? AND collection_id = ? AND id > ?
           ORDER BY id LIMIT ?`,
        )
        .all(workspaceId, tableId, after, limit + 1),
    );
    return this.paginate(records.map(toRow), limit);
  }

  // Revisions (ADR-008). Immutable: inserted once, deleted only to clean up
  // after a version conflict, never updated.

  async putRevision(workspaceId: WorkspaceId, revision: RevisionInput): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO revisions
         (workspace_id, kind, record_id, version, collection_id, parent_version,
          actor, actor_kind, note, created_at, deleted, snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspaceId,
        revision.kind,
        revision.recordId,
        revision.version,
        revision.tableId,
        revision.parentVersion,
        JSON.stringify(revision.actor),
        revision.actor.kind,
        revision.note,
        revision.createdAt,
        revision.deleted ? 1 : 0,
        JSON.stringify(revision.snapshot),
      );
  }

  async getRevision(
    workspaceId: WorkspaceId,
    kind: RevisionKind,
    recordId: Id,
    version: Version,
  ): Promise<Revision | null> {
    const record = this.db
      .prepare(
        `SELECT * FROM revisions
         WHERE workspace_id = ? AND kind = ? AND record_id = ? AND version = ?`,
      )
      .get(workspaceId, kind, recordId, version) as RevisionRecord | undefined;
    return record ? toRevision(record) : null;
  }

  async deleteRevision(
    workspaceId: WorkspaceId,
    kind: RevisionKind,
    recordId: Id,
    version: Version,
  ): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM revisions
         WHERE workspace_id = ? AND kind = ? AND record_id = ? AND version = ?`,
      )
      .run(workspaceId, kind, recordId, version);
  }

  async listRevisions(
    workspaceId: WorkspaceId,
    kind: RevisionKind,
    recordId: Id,
    options: { limit?: number; cursor?: string | null } = {},
  ): Promise<Paged<Revision>> {
    const limit = clampLimit(options.limit);
    const after = decodeRevisionCursor(options.cursor);
    // The tie-break is rowid, SQLite's own monotonic insertion order, not
    // version: version is a random UUID (packages/core/src/ids.ts), so within
    // the same created_at millisecond, ordering by it picks the "latest"
    // revision at random rather than the one actually written last. undelete
    // (and anything else reading items[0] as "the latest") needs the real
    // one, not a coin flip (caught as a CI flake on rest.test.ts).
    const rows = asRecords<RevisionRow>(
      after
        ? this.db
            .prepare(
              `SELECT *, rowid FROM revisions
               WHERE workspace_id = ? AND kind = ? AND record_id = ?
                 AND (created_at < ? OR (created_at = ? AND rowid < ?))
               ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            )
            .all(workspaceId, kind, recordId, after[0], after[0], after[1], limit + 1)
        : this.db
            .prepare(
              `SELECT *, rowid FROM revisions
               WHERE workspace_id = ? AND kind = ? AND record_id = ?
               ORDER BY created_at DESC, rowid DESC LIMIT ?`,
            )
            .all(workspaceId, kind, recordId, limit + 1),
    );
    return this.paginateRevisions(rows, limit);
  }

  async listRecentRevisions(
    workspaceId: WorkspaceId,
    options: { limit?: number; cursor?: string | null; actorKind?: Actor["kind"] } = {},
  ): Promise<Paged<Revision>> {
    const limit = clampLimit(options.limit);
    const after = decodeRevisionCursor(options.cursor);

    const conditions = ["workspace_id = ?"];
    const params: Array<string | number> = [workspaceId];
    if (options.actorKind) {
      conditions.push("actor_kind = ?");
      params.push(options.actorKind);
    }
    if (after) {
      conditions.push("(created_at < ? OR (created_at = ? AND rowid < ?))");
      params.push(after[0], after[0], after[1]);
    }
    params.push(limit + 1);

    // Conditions are fixed strings chosen above, never caller input, so the
    // statement text stays a closed set.
    const rows = asRecords<RevisionRow>(
      this.db
        .prepare(
          `SELECT *, rowid FROM revisions WHERE ${conditions.join(" AND ")}
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(...params),
    );
    return this.paginateRevisions(rows, limit);
  }

  async listDeletedPages(
    workspaceId: WorkspaceId,
    options: { limit?: number; cursor?: string | null } = {},
  ): Promise<Paged<Revision>> {
    const limit = clampLimit(options.limit);
    const after = decodeRevisionCursor(options.cursor);

    // For each page id with no current row, its single newest revision (the
    // correlated NOT EXISTS finds the newest by ruling out every other one),
    // kept only when that revision is itself the deletion: a page whose
    // newest revision predates a later, still-off-chain write is not
    // reported as deleted (ADR-059).
    const conditions = [
      "r.workspace_id = ?",
      "r.kind = 'page'",
      "r.deleted = 1",
      "NOT EXISTS (SELECT 1 FROM pages p WHERE p.workspace_id = r.workspace_id AND p.id = r.record_id)",
      // The tie-break is r2.rowid, SQLite's own monotonic insertion order,
      // not r2.version: version is a random UUID (packages/core/src/ids.ts),
      // so comparing versions lexically to find "the newer one" is
      // meaningless and, within the same created_at millisecond, wrongly
      // excludes a just-deleted page from this list about as often as it
      // includes it (caught as a CI flake on rest.test.ts).
      `NOT EXISTS (
         SELECT 1 FROM revisions r2
         WHERE r2.workspace_id = r.workspace_id AND r2.kind = 'page' AND r2.record_id = r.record_id
           AND r2.rowid > r.rowid
       )`,
    ];
    const params: Array<string | number> = [workspaceId];
    if (after) {
      conditions.push("(r.created_at < ? OR (r.created_at = ? AND r.rowid < ?))");
      params.push(after[0], after[0], after[1]);
    }
    params.push(limit + 1);

    const rows = asRecords<RevisionRow>(
      this.db
        .prepare(
          `SELECT r.*, r.rowid FROM revisions r WHERE ${conditions.join(" AND ")}
           ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?`,
        )
        .all(...params),
    );
    return this.paginateRevisions(rows, limit);
  }

  // Helpers.

  private paginateRevisions(rows: RevisionRow[], limit: number): Paged<Revision> {
    const hasMore = rows.length > limit;
    const window = hasMore ? rows.slice(0, limit) : rows;
    const last = window[window.length - 1];
    return {
      items: window.map(toRevision),
      cursor: hasMore && last ? encodeRevisionCursor(last) : null,
    };
  }

  private readEdges(sql: string, ...params: string[]): Edge[] {
    const records = this.db.prepare(sql).all(...params) as Array<{
      workspace_id: string;
      source_id: string;
      target_id: string;
      type: string;
      label: string | null;
    }>;
    return records.map((record) => ({
      workspaceId: record.workspace_id,
      sourceId: record.source_id,
      targetId: record.target_id,
      type: record.type as Edge["type"],
      label: record.label,
    }));
  }

  private paginate<T extends { id: string }>(
    items: T[],
    limit: number,
  ): Paged<T> {
    const hasMore = items.length > limit;
    const window = hasMore ? items.slice(0, limit) : items;
    const last = window[window.length - 1];
    return {
      items: window,
      cursor: hasMore && last ? encodeCursor(last.id) : null,
    };
  }

  private assertVersion(
    kind: string,
    id: Id,
    existing: { version: string } | null,
    expectedVersion: ExpectedVersion,
  ): void {
    if (expectedVersion === null) {
      if (existing) {
        throw new VersionConflictError(kind, id, null, existing);
      }
      return;
    }
    if (!existing || existing.version !== expectedVersion) {
      throw new VersionConflictError(kind, id, expectedVersion, existing);
    }
  }
}
