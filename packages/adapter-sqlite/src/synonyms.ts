import { DatabaseSync } from "node:sqlite";
import { foldTerm, newSynonymId, type SynonymPair, type SynonymsStore, type WorkspaceId, type WriteContext } from "@cairn/core";

/**
 * Per-collection synonyms in SQLite (ADR-077), in the same file as the
 * documents and search index, in a table of its own.
 */

export interface SqliteSynonymsStoreOptions {
  location?: string;
}

interface Row {
  id: string;
  workspace_id: string;
  collection_id: string;
  term: string;
  synonym: string;
  created_at: string;
}

function fromRow(row: Row): SynonymPair {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    collectionId: row.collection_id,
    term: row.term,
    synonym: row.synonym,
    createdAt: row.created_at,
  };
}

export class SqliteSynonymsStore implements SynonymsStore {
  private readonly db: DatabaseSync;

  constructor(options: SqliteSynonymsStoreOptions = {}) {
    this.db = new DatabaseSync(options.location ?? ":memory:");
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS synonyms (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL,
        collection_id TEXT NOT NULL,
        term          TEXT NOT NULL,
        synonym       TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        UNIQUE (workspace_id, collection_id, term, synonym)
      );
      CREATE INDEX IF NOT EXISTS synonyms_by_collection ON synonyms (workspace_id, collection_id);
      CREATE INDEX IF NOT EXISTS synonyms_by_term ON synonyms (workspace_id, term);
    `);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async list(workspaceId: WorkspaceId, collectionId: string): Promise<SynonymPair[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM synonyms WHERE workspace_id = ? AND collection_id = ? ORDER BY created_at",
      )
      .all(workspaceId, collectionId) as unknown as Row[];
    return rows.map(fromRow);
  }

  async listAll(workspaceId: WorkspaceId): Promise<SynonymPair[]> {
    const rows = this.db
      .prepare("SELECT * FROM synonyms WHERE workspace_id = ? ORDER BY created_at")
      .all(workspaceId) as unknown as Row[];
    return rows.map(fromRow);
  }

  async add(
    workspaceId: WorkspaceId,
    collectionId: string,
    term: string,
    synonym: string,
    _by: WriteContext,
  ): Promise<SynonymPair> {
    const foldedTerm = foldTerm(term);
    const foldedSynonym = foldTerm(synonym);
    const existing = this.db
      .prepare(
        "SELECT * FROM synonyms WHERE workspace_id = ? AND collection_id = ? AND term = ? AND synonym = ?",
      )
      .get(workspaceId, collectionId, foldedTerm, foldedSynonym) as Row | undefined;
    if (existing) return fromRow(existing);

    const row: Row = {
      id: newSynonymId(),
      workspace_id: workspaceId,
      collection_id: collectionId,
      term: foldedTerm,
      synonym: foldedSynonym,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO synonyms (id, workspace_id, collection_id, term, synonym, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.workspace_id, row.collection_id, row.term, row.synonym, row.created_at);
    return fromRow(row);
  }

  async remove(workspaceId: WorkspaceId, collectionId: string, term: string, synonym: string): Promise<void> {
    this.db
      .prepare(
        "DELETE FROM synonyms WHERE workspace_id = ? AND collection_id = ? AND term = ? AND synonym = ?",
      )
      .run(workspaceId, collectionId, foldTerm(term), foldTerm(synonym));
  }
}
