import { DatabaseSync } from "node:sqlite";
import type {
  ChunkInput,
  Id,
  SearchIndex,
  SearchIndexCapabilities,
  SearchResult,
  WorkspaceId,
} from "@cairn/core";

/**
 * SQLite FTS5 search index, separate from the document store (ADR-005 rule 1).
 *
 * FTS5 ships in Node's bundled SQLite, so this needs no native dependency.
 * `bm25()` returns a negative number where more negative is better, so it is
 * negated to match the port's contract of higher meaning better.
 */

const SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
  workspace_id UNINDEXED,
  chunk_id     UNINDEXED,
  page_id      UNINDEXED,
  heading_path UNINDEXED,
  ordinal      UNINDEXED,
  text
);
`;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface HitRecord {
  chunk_id: string;
  page_id: string;
  heading_path: string;
  score: number;
  snippet: string;
}

/**
 * Turn user text into an FTS5 MATCH expression. Every token is quoted, so
 * punctuation and FTS5 operators in a query are treated as text rather than
 * syntax. A query Claude wrote should never be able to produce a syntax error.
 */
function toMatchExpression(query: string): string | null {
  const tokens = query
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 0)
    .map((token) => `"${token}"`);
  return tokens.length === 0 ? null : tokens.join(" OR ");
}

export interface SqliteSearchIndexOptions {
  location?: string;
}

export class SqliteSearchIndex implements SearchIndex {
  readonly capabilities: SearchIndexCapabilities = { vectors: false };

  private readonly db: DatabaseSync;

  constructor(options: SqliteSearchIndexOptions = {}) {
    this.db = new DatabaseSync(options.location ?? ":memory:");
  }

  async init(): Promise<void> {
    this.db.exec(SCHEMA);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async replaceChunksForPage(
    workspaceId: WorkspaceId,
    pageId: Id,
    chunks: ChunkInput[],
  ): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM chunks WHERE workspace_id = ? AND page_id = ?")
        .run(workspaceId, pageId);
      const insert = this.db.prepare(
        `INSERT INTO chunks
         (workspace_id, chunk_id, page_id, heading_path, ordinal, text)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const chunk of chunks) {
        insert.run(
          workspaceId,
          chunk.id,
          pageId,
          JSON.stringify(chunk.headingPath),
          chunk.ordinal,
          chunk.text,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async deleteChunksForPage(workspaceId: WorkspaceId, pageId: Id): Promise<void> {
    await this.replaceChunksForPage(workspaceId, pageId, []);
  }

  async search(
    workspaceId: WorkspaceId,
    options: { query: string; limit?: number; cursor?: string | null },
  ): Promise<SearchResult> {
    const limit = Math.max(
      1,
      Math.min(MAX_LIMIT, Math.trunc(options.limit ?? DEFAULT_LIMIT)),
    );
    const offset = decodeOffset(options.cursor);
    const match = toMatchExpression(options.query);

    // A query with no searchable tokens matches nothing. It is not an error:
    // Claude gets an empty result and can retry with different terms.
    if (!match) {
      return { hits: [], mode: "keyword", truncated: false, cursor: null };
    }

    const records = this.db
      .prepare(
        `SELECT chunk_id, page_id, heading_path,
                -bm25(chunks) AS score,
                snippet(chunks, 5, char(91), char(93), char(8230), 16) AS snippet
         FROM chunks
         WHERE chunks MATCH ? AND workspace_id = ?
         ORDER BY bm25(chunks), chunk_id
         LIMIT ? OFFSET ?`,
      )
      .all(match, workspaceId, limit + 1, offset) as unknown as HitRecord[];

    const truncated = records.length > limit;
    const window = truncated ? records.slice(0, limit) : records;

    return {
      hits: window.map((record) => ({
        pageId: record.page_id,
        chunkId: record.chunk_id,
        headingPath: JSON.parse(record.heading_path) as string[],
        snippet: record.snippet,
        score: record.score,
      })),
      mode: "keyword",
      truncated,
      cursor: truncated ? encodeOffset(offset + window.length) : null,
    };
  }
}

function encodeOffset(offset: number): string {
  return Buffer.from(`s:${offset}`, "utf8").toString("base64url");
}

function decodeOffset(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const offset = decoded.startsWith("s:") ? Number(decoded.slice(2)) : Number.NaN;
  return Number.isInteger(offset) && offset >= 0 ? offset : 0;
}
