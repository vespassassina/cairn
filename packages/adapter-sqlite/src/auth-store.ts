import { DatabaseSync } from "node:sqlite";
import type { AuthRecordKind, AuthStore } from "@cairn/core";

/**
 * The OAuth server's records in SQLite (ADR-017). One table, in the same
 * file as the documents, separate from them.
 */

export interface SqliteAuthStoreOptions {
  location?: string;
}

export class SqliteAuthStore implements AuthStore {
  private readonly db: DatabaseSync;

  constructor(options: SqliteAuthStoreOptions = {}) {
    this.db = new DatabaseSync(options.location ?? ":memory:");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_records (
        kind       TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        expires_at TEXT,
        PRIMARY KEY (kind, key)
      );
      CREATE INDEX IF NOT EXISTS auth_records_by_expiry ON auth_records (expires_at);
    `);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async putAuth(kind: AuthRecordKind, key: string, value: unknown, expiresAt: string | null): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO auth_records (kind, key, value, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (kind, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      )
      .run(kind, key, JSON.stringify(value), expiresAt);
    // Expired records are only ever read as absent; clear them now and then.
    if (Math.random() < 0.05) {
      this.db.prepare("DELETE FROM auth_records WHERE expires_at IS NOT NULL AND expires_at < ?").run(new Date().toISOString());
    }
  }

  async getAuth<T = unknown>(kind: AuthRecordKind, key: string): Promise<T | null> {
    const row = this.db
      .prepare("SELECT value FROM auth_records WHERE kind = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)")
      .get(kind, key, new Date().toISOString()) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  async takeAuth<T = unknown>(kind: AuthRecordKind, key: string): Promise<T | null> {
    // DELETE ... RETURNING is one statement, so only one caller can get the row.
    const row = this.db
      .prepare(
        "DELETE FROM auth_records WHERE kind = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?) RETURNING value",
      )
      .get(kind, key, new Date().toISOString()) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }
}
