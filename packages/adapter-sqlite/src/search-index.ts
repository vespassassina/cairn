import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getLoadablePath } from "sqlite-vec";
import {
  extractPhrases,
  isNegatedEverywhere,
  queryTerms,
  requiredMatches,
  sameWords,
  type ChunkInput,
  type Embedder,
  type Id,
  type SearchIndex,
  type SearchIndexCapabilities,
  type SearchIndexStatus,
  type SearchMode,
  type SearchResult,
  type WorkspaceId,
} from "@cairn/core";

/**
 * SQLite FTS5 search index, separate from the document store (ADR-005 rule 1),
 * with optional vectors through the sqlite-vec extension (ADR-022).
 *
 * FTS5 ships in Node's bundled SQLite, so keyword search needs no native
 * dependency. `bm25()` returns a negative number where more negative is
 * better, so it is negated to match the port's contract of higher meaning
 * better.
 *
 * Text is stemmed with FTS5's Porter tokenizer, so "peptides" finds
 * "peptide" and "combine" finds "combined" (ADR-021). Porter is English;
 * other languages are left mostly as they are, and query and text are always
 * stemmed the same way, so it never stops a word matching itself.
 *
 * A chunk's heading path, the page title and the headings above it, is
 * indexed as its own column and weighs more than body text in BM25, so a page
 * ranks above the short sections of other pages that merely link to it.
 *
 * FTS5 finds candidates that contain any term, ranked by BM25. Then the rules
 * every backend shares (core `search/terms.ts`) drop pages that contain too
 * few of the query's terms, and pages with more of them rank first. Which
 * page holds which term is asked of FTS5 itself, so it agrees with the
 * tokenizer and the stemmer exactly.
 *
 * With an embedder, chunks are embedded in the background after each write,
 * never on the write path. Hybrid search merges the keyword ranking with the
 * nearest vectors by reciprocal rank fusion, and drops vectors that do not
 * stand out from their neighbours (`margin`), so a question with no answer
 * still returns nothing.
 * Until the model is loaded, or if it fails, search runs in keyword mode and
 * says so.
 */

const TOKENIZER = "porter unicode61 remove_diacritics 2";

/**
 * How much a match in the heading path counts against one in the text, as a
 * BM25 column weight. Chosen with `pnpm eval` and the title check recorded in
 * docs/CHANGELOG.md.
 */
export const HEADING_WEIGHT = 5;

// `heading` comes after `text`, so `text` keeps column 5 for snippet().
const SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
  workspace_id UNINDEXED,
  chunk_id     UNINDEXED,
  page_id      UNINDEXED,
  heading_path UNINDEXED,
  ordinal      UNINDEXED,
  text,
  heading,
  tokenize = '${TOKENIZER}'
);
`;

/** BM25 with a weight per column, in schema order; unindexed columns do not count. */
const RANK = `bm25(chunks, 0, 0, 0, 0, 0, 1.0, ${HEADING_WEIGHT})`;

/**
 * Created only when an embedder is configured (ADR-004). `vector_chunks` says
 * which chunk, with which text, each vector belongs to; its `id` is the vector's
 * rowid in `chunk_vectors`.
 */
const VECTOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS vector_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS vector_chunks (
  id           INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  chunk_id     TEXT NOT NULL,
  page_id      TEXT NOT NULL,
  text_hash    TEXT NOT NULL,
  UNIQUE (workspace_id, chunk_id)
);
CREATE INDEX IF NOT EXISTS vector_chunks_page ON vector_chunks (workspace_id, page_id);
`;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/**
 * How many BM25-ranked chunks are considered. A page that holds most of the
 * terms ranks well in BM25, so it is inside this window long before the
 * window runs out.
 */
const CANDIDATES = 1000;
/** Nearest vectors considered per query. */
const VECTOR_CANDIDATES = 50;
/** Reciprocal rank fusion constant, the usual 60: `1 / (60 + rank)`. */
const RRF_K = 60;
/** Chunks handed to the embedder, and written, per step. The embedder batches as it sees fit. */
const EMBED_BATCH = 32;
/**
 * When a vector match counts (ADR-022). Measured with bge-small-en-v1.5 on
 * the 96-page eval wiki, over 41 queries.
 *
 * A fixed similarity cannot separate the two cases that matter: a
 * conversational question with an answer ("something to help me fall
 * asleep", 0.657 to the DSIP page) scores like a question near the wiki's
 * topic with none ("insulin pump battery replacement", 0.654). What differs
 * is whether the match stands out from its neighbours. The margin is the
 * similarity above the average of the 10th to 50th nearest chunks: 0.023 to
 * 0.061 for questions with no answer, 0.058 to 0.203 for questions with one,
 * the only one under 0.065 being found by keyword anyway.
 *
 * A workspace too small to have a neighbourhood uses a fixed similarity.
 */
export const DEFAULT_MARGIN = 0.065;
export const DEFAULT_MIN_SIMILARITY = 0.7;
/** Nearest chunks needed before the margin means anything. */
const NEIGHBOURHOOD = 20;

interface HitRecord {
  chunk_id: string;
  page_id: string;
  heading_path: string;
  score: number;
  snippet: string;
}

interface ChunkRow {
  chunk_id: string;
  page_id: string;
  heading_path: string;
  text: string;
}

/**
 * Quote a term for FTS5, so operators in a query are treated as text rather
 * than syntax. A query Claude wrote should never produce a syntax error.
 */
function quote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * How far apart NEAR still counts a phrase's words as together (ADR-076).
 * Fixed, not a setting: chosen for Cairn's own prose length with `pnpm eval`,
 * and one fewer thing an agent has to know to write a phrase query.
 */
const NEAR_DISTANCE = 10;

/** An MATCH clause for one query term plus its synonyms (ADR-077), OR'd together. */
function altQuery(term: string, synonyms: string[]): string {
  const alts = [term, ...synonyms];
  return alts.length === 1 ? quote(alts[0]!) : `(${alts.map(quote).join(" OR ")})`;
}

/** A MATCH clause asking FTS5 for a quoted phrase's words within NEAR_DISTANCE of each other. */
function nearQuery(words: string[]): string {
  return `NEAR(${words.map(quote).join(" ")}, ${NEAR_DISTANCE})`;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("base64url");
}

/** Float32 vector as the little-endian bytes sqlite-vec reads. */
function vectorBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** A short extract for a chunk found by meaning, where FTS5 has no match to cut around. */
function excerpt(text: string, words = 24): string {
  const all = text.split(/\s+/).filter((word) => word.length > 0);
  return all.length <= words ? all.join(" ") : `${all.slice(0, words).join(" ")}\u2026`;
}

export interface SqliteSearchIndexOptions {
  location?: string;
  /** Turns on vectors and hybrid search (ADR-022). */
  embedder?: Embedder;
  /** A vector match must be this far above its neighbourhood's similarity. */
  margin?: number;
  /** In a workspace too small for a neighbourhood, the similarity a match needs. */
  minSimilarity?: number;
  /** Told when the model fails to load or run. Search carries on by keyword. */
  onVectorError?: (error: unknown) => void;
}

export class SqliteSearchIndex implements SearchIndex {
  readonly capabilities: SearchIndexCapabilities;
  needsRebuild = false;

  private readonly db: DatabaseSync;
  private readonly embedder: Embedder | null;
  private readonly margin: number;
  private readonly minSimilarity: number;
  private readonly onVectorError: (error: unknown) => void;

  private vectors: SearchIndexStatus["vectors"];
  private vectorDetail: string | null = null;
  private startup: Promise<void> = Promise.resolve();
  private worker: Promise<void> | null = null;
  private closing = false;
  /** Pages whose chunks may lack vectors, by workspace. */
  private readonly pending = new Map<WorkspaceId, Set<Id>>();
  /** Bumped on every write to a page, so a vector computed for old text is discarded. */
  private readonly generation = new Map<string, number>();

  constructor(options: SqliteSearchIndexOptions = {}) {
    this.embedder = options.embedder ?? null;
    this.margin = options.margin ?? DEFAULT_MARGIN;
    this.minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
    this.onVectorError = options.onVectorError ?? (() => undefined);
    this.capabilities = { vectors: this.embedder !== null };
    this.vectors = this.embedder ? "loading" : "off";
    this.db = new DatabaseSync(options.location ?? ":memory:", {
      allowExtension: this.embedder !== null,
    });
    // Shares the file with the document store, auth store and Litestream.
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  async init(): Promise<void> {
    // An index built with another tokenizer, or without the heading column,
    // cannot be converted in place. Chunks are derived data (ADR-005), so
    // drop it and ask for a rebuild.
    const existing = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunks'")
      .get() as { sql: string } | undefined;
    if (existing && (!existing.sql.includes(TOKENIZER) || !/\bheading,/.test(existing.sql))) {
      this.db.exec("DROP TABLE chunks");
      this.needsRebuild = true;
    }
    this.db.exec(SCHEMA);

    if (this.embedder) {
      try {
        this.db.loadExtension(getLoadablePath());
        this.db.enableLoadExtension(false);
      } catch (error) {
        this.fail(error);
        return;
      }
      // Loading a model takes seconds. Keyword search serves meanwhile.
      this.startup = this.startVectors(this.embedder);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.startup;
    await this.worker;
    await this.embedder?.close();
    this.db.close();
  }

  status(): SearchIndexStatus {
    let pending = 0;
    if (this.vectors === "ready") {
      for (const [workspaceId, pages] of this.pending) {
        for (const pageId of pages) pending += this.missingChunks(workspaceId, pageId).length;
      }
    }
    return {
      vectors: this.vectors,
      model: this.embedder?.model ?? null,
      pending,
      detail: this.vectorDetail,
    };
  }

  async settled(): Promise<void> {
    await this.startup;
    while (this.vectors === "ready" && (this.worker || this.hasPending())) {
      this.kick();
      await this.worker;
    }
  }

  async replaceChunksForPage(
    workspaceId: WorkspaceId,
    pageId: Id,
    chunks: ChunkInput[],
  ): Promise<void> {
    const key = `${workspaceId}/${pageId}`;
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM chunks WHERE workspace_id = ? AND page_id = ?")
        .run(workspaceId, pageId);
      const insert = this.db.prepare(
        `INSERT INTO chunks
         (workspace_id, chunk_id, page_id, heading_path, ordinal, text, heading)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const chunk of chunks) {
        insert.run(
          workspaceId,
          chunk.id,
          pageId,
          JSON.stringify(chunk.headingPath),
          chunk.ordinal,
          chunk.text,
          chunk.headingPath.join("\n"),
        );
      }
      if (this.vectors === "ready") {
        const current = new Map(chunks.map((chunk) => [chunk.id, hashText(chunk.text)]));
        this.dropStaleVectors(workspaceId, pageId, current);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (this.vectors === "ready") {
      this.markPending(workspaceId, pageId);
      this.kick();
    }
  }

  async deleteChunksForPage(workspaceId: WorkspaceId, pageId: Id): Promise<void> {
    await this.replaceChunksForPage(workspaceId, pageId, []);
  }

  async search(
    workspaceId: WorkspaceId,
    options: {
      query: string;
      limit?: number;
      cursor?: string | null;
      mode?: SearchMode;
      synonyms?: Record<string, string[]>;
    },
  ): Promise<SearchResult> {
    const limit = Math.max(
      1,
      Math.min(MAX_LIMIT, Math.trunc(options.limit ?? DEFAULT_LIMIT)),
    );
    const offset = decodeOffset(options.cursor);
    const terms = queryTerms(options.query);

    // A query with no searchable tokens matches nothing. It is not an error:
    // Claude gets an empty result and can retry with different terms.
    if (terms.length === 0) {
      return { hits: [], mode: "keyword", truncated: false, cursor: null };
    }

    const phrases = extractPhrases(options.query);
    const keyword = this.keywordRanking(workspaceId, terms, options.synonyms ?? {}, phrases);
    let mode: SearchMode = "keyword";
    let ranked = keyword;

    if ((options.mode ?? "hybrid") === "hybrid" && this.vectors === "ready") {
      try {
        const query = await this.embedder!.embedQuery(options.query);
        ranked = this.fuse(workspaceId, keyword, this.vectorRanking(workspaceId, query));
        mode = "hybrid";
      } catch (error) {
        // Optional services degrade, they never throw into the core path.
        this.fail(error);
      }
    }

    const records = titleFirst(ranked, options.query).slice(offset, offset + limit + 1);
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
      mode,
      truncated,
      cursor: truncated ? encodeOffset(offset + window.length) : null,
    };
  }

  /** Chunks that pass the keyword rule (ADR-021), best first. */
  private keywordRanking(
    workspaceId: WorkspaceId,
    terms: string[],
    synonyms: Record<string, string[]>,
    phrases: string[][],
  ): HitRecord[] {
    // Which pages hold each term or one of its synonyms (ADR-077), in at
    // least one chunk where that word is not negated (ADR-042): "less
    // hungry" does not count towards "hungry".
    const pagesOf = this.db.prepare(
      "SELECT page_id, text FROM chunks WHERE chunks MATCH ? AND workspace_id = ?",
    );
    const required = requiredMatches(terms.length);
    const coverage = new Map<string, number>();
    for (const term of terms) {
      const alts = [term, ...(synonyms[term] ?? [])];
      const rows = pagesOf.all(altQuery(term, synonyms[term] ?? []), workspaceId) as unknown as {
        page_id: string;
        text: string;
      }[];
      const affirmed = new Set<string>();
      for (const { page_id, text } of rows) {
        if (alts.some((alt) => !isNegatedEverywhere(text, alt))) affirmed.add(page_id);
      }
      for (const page_id of affirmed) coverage.set(page_id, (coverage.get(page_id) ?? 0) + 1);
    }
    const covered = (record: HitRecord) => coverage.get(record.page_id) ?? 0;

    const candidates = this.db
      .prepare(
        `SELECT chunk_id, page_id, heading_path,
                -${RANK} AS score,
                snippet(chunks, 5, char(91), char(93), char(8230), 16) AS snippet
         FROM chunks
         WHERE chunks MATCH ? AND workspace_id = ?
         ORDER BY ${RANK}, chunk_id
         LIMIT ?`,
      )
      .all(
        terms.map((term) => altQuery(term, synonyms[term] ?? [])).join(" OR "),
        workspaceId,
        CANDIDATES,
      ) as unknown as HitRecord[];

    // A quoted phrase (ADR-076) does not narrow which pages match: it only
    // says which of them said the words together rather than scattered, so
    // those rank first. Plain bag-of-words queries never touch this path.
    const phraseChunks = new Set<string>();
    if (phrases.length > 0) {
      const phraseStmt = this.db.prepare(
        "SELECT chunk_id FROM chunks WHERE chunks MATCH ? AND workspace_id = ?",
      );
      for (const words of phrases) {
        const rows = phraseStmt.all(nearQuery(words), workspaceId) as unknown as { chunk_id: string }[];
        for (const row of rows) phraseChunks.add(row.chunk_id);
      }
    }

    return candidates
      .filter((record) => covered(record) >= required)
      .sort(
        (a, b) =>
          covered(b) - covered(a) ||
          Number(phraseChunks.has(b.chunk_id)) - Number(phraseChunks.has(a.chunk_id)) ||
          b.score - a.score ||
          (a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0),
      );
  }

  /** Nearest chunks by meaning that stand out enough, best first. */
  private vectorRanking(
    workspaceId: WorkspaceId,
    query: Float32Array,
  ): { chunk_id: string; page_id: string; similarity: number }[] {
    const rows = this.db
      .prepare(
        `WITH nearest AS (
           SELECT rowid, distance FROM chunk_vectors
           WHERE embedding MATCH ? AND k = ? AND workspace_id = ?
         )
         SELECT c.chunk_id, c.page_id, nearest.distance
         FROM nearest JOIN vector_chunks c ON c.id = nearest.rowid
         ORDER BY nearest.distance`,
      )
      .all(vectorBytes(query), VECTOR_CANDIDATES, workspaceId) as unknown as {
      chunk_id: string;
      page_id: string;
      distance: number;
    }[];
    const nearest = rows.map((row) => ({
      chunk_id: row.chunk_id,
      page_id: row.page_id,
      similarity: 1 - row.distance,
    }));
    let needed = this.minSimilarity;
    if (nearest.length >= NEIGHBOURHOOD) {
      const neighbourhood = nearest.slice(9);
      const typical = neighbourhood.reduce((sum, row) => sum + row.similarity, 0) / neighbourhood.length;
      needed = typical + this.margin;
    }
    return nearest.filter((row) => row.similarity >= needed);
  }

  /** Reciprocal rank fusion of the two rankings. */
  private fuse(
    workspaceId: WorkspaceId,
    keyword: HitRecord[],
    vector: { chunk_id: string; page_id: string; similarity: number }[],
  ): HitRecord[] {
    const fused = new Map<string, { record: HitRecord | null; pageId: string; score: number }>();
    keyword.forEach((record, rank) => {
      fused.set(record.chunk_id, { record, pageId: record.page_id, score: 1 / (RRF_K + rank + 1) });
    });
    vector.forEach((row, rank) => {
      const entry = fused.get(row.chunk_id) ?? { record: null, pageId: row.page_id, score: 0 };
      entry.score += 1 / (RRF_K + rank + 1);
      fused.set(row.chunk_id, entry);
    });

    // Chunks found only by meaning have no FTS5 snippet: read them for one.
    const missing = [...fused].filter(([, entry]) => entry.record === null).map(([id]) => id);
    const texts = new Map<string, ChunkRow>();
    if (missing.length > 0) {
      const rows = this.db
        .prepare(
          `SELECT chunk_id, page_id, heading_path, text FROM chunks
           WHERE workspace_id = ? AND chunk_id IN (${missing.map(() => "?").join(", ")})`,
        )
        .all(workspaceId, ...missing) as unknown as ChunkRow[];
      for (const row of rows) texts.set(row.chunk_id, row);
    }

    const out: HitRecord[] = [];
    for (const [chunkId, entry] of fused) {
      const base = entry.record ?? chunkRecord(texts.get(chunkId));
      if (base) out.push({ ...base, score: entry.score });
    }
    return out.sort(
      (a, b) => b.score - a.score || (a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0),
    );
  }

  private async startVectors(embedder: Embedder): Promise<void> {
    try {
      await embedder.init();
      if (this.closing) return;
      this.prepareVectorTables(embedder);
      this.vectors = "ready";
      this.vectorDetail = null;
      this.reconcile();
      this.kick();
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Creates the vector tables for this model, or recreates them when the
   * model or its dimensions changed: old vectors cannot be compared with new
   * ones, so they are dropped and every chunk is embedded again.
   */
  private prepareVectorTables(embedder: Embedder): void {
    this.db.exec(VECTOR_SCHEMA);
    const meta = new Map(
      (this.db.prepare("SELECT key, value FROM vector_meta").all() as unknown as {
        key: string;
        value: string;
      }[]).map((row) => [row.key, row.value]),
    );
    const wanted = { model: embedder.model, dimensions: String(embedder.dimensions) };
    const exists = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'chunk_vectors'")
      .get();
    if (!exists || meta.get("model") !== wanted.model || meta.get("dimensions") !== wanted.dimensions) {
      this.db.exec("DROP TABLE IF EXISTS chunk_vectors");
      this.db.exec("DELETE FROM vector_chunks");
      this.db.exec(
        `CREATE VIRTUAL TABLE chunk_vectors USING vec0(
          workspace_id TEXT PARTITION KEY,
          embedding float[${embedder.dimensions}] distance_metric=cosine
        )`,
      );
      const set = this.db.prepare("INSERT OR REPLACE INTO vector_meta (key, value) VALUES (?, ?)");
      set.run("model", wanted.model);
      set.run("dimensions", wanted.dimensions);
    }
  }

  /**
   * Compares every chunk with the stored vectors: drops vectors for chunks
   * that are gone or changed, and queues pages with chunks that have none.
   * Runs once the model is ready, which also covers writes made while it was
   * loading and anything a crash left behind.
   */
  private reconcile(): void {
    const stored = new Map<string, { id: number; hash: string }>();
    for (const row of this.db
      .prepare("SELECT id, workspace_id, chunk_id, text_hash FROM vector_chunks")
      .all() as unknown as { id: number; workspace_id: string; chunk_id: string; text_hash: string }[]) {
      stored.set(`${row.workspace_id}/${row.chunk_id}`, { id: row.id, hash: row.text_hash });
    }

    const keep = new Set<number>();
    for (const row of this.db
      .prepare("SELECT workspace_id, chunk_id, page_id, text FROM chunks")
      .all() as unknown as { workspace_id: string; chunk_id: string; page_id: string; text: string }[]) {
      const vector = stored.get(`${row.workspace_id}/${row.chunk_id}`);
      if (vector && vector.hash === hashText(row.text)) keep.add(vector.id);
      else this.markPending(row.workspace_id, row.page_id);
    }

    const stale = [...stored.values()].filter((vector) => !keep.has(vector.id)).map((vector) => vector.id);
    this.deleteVectors(stale);
  }

  private dropStaleVectors(workspaceId: WorkspaceId, pageId: Id, current: Map<string, string>): void {
    const rows = this.db
      .prepare("SELECT id, chunk_id, text_hash FROM vector_chunks WHERE workspace_id = ? AND page_id = ?")
      .all(workspaceId, pageId) as unknown as { id: number; chunk_id: string; text_hash: string }[];
    this.deleteVectors(rows.filter((row) => current.get(row.chunk_id) !== row.text_hash).map((row) => row.id));
  }

  private deleteVectors(ids: number[]): void {
    const vector = this.db.prepare("DELETE FROM chunk_vectors WHERE rowid = ?");
    const link = this.db.prepare("DELETE FROM vector_chunks WHERE id = ?");
    for (const id of ids) {
      vector.run(id);
      link.run(id);
    }
  }

  private markPending(workspaceId: WorkspaceId, pageId: Id): void {
    const pages = this.pending.get(workspaceId) ?? new Set<Id>();
    pages.add(pageId);
    this.pending.set(workspaceId, pages);
  }

  private hasPending(): boolean {
    for (const pages of this.pending.values()) if (pages.size > 0) return true;
    return false;
  }

  /** A page's chunks with no vector for their current text. */
  private missingChunks(workspaceId: WorkspaceId, pageId: Id): (ChunkRow & { hash: string })[] {
    const have = new Map(
      (this.db
        .prepare("SELECT chunk_id, text_hash FROM vector_chunks WHERE workspace_id = ? AND page_id = ?")
        .all(workspaceId, pageId) as unknown as { chunk_id: string; text_hash: string }[]).map((row) => [
        row.chunk_id,
        row.text_hash,
      ]),
    );
    const rows = this.db
      .prepare(
        "SELECT chunk_id, page_id, heading_path, text FROM chunks WHERE workspace_id = ? AND page_id = ? ORDER BY ordinal",
      )
      .all(workspaceId, pageId) as unknown as ChunkRow[];
    return rows
      .map((row) => ({ ...row, hash: hashText(row.text) }))
      .filter((row) => have.get(row.chunk_id) !== row.hash);
  }

  /** Starts the background worker if there is work and it is not running. */
  private kick(): void {
    if (this.worker || this.closing || this.vectors !== "ready" || !this.hasPending()) return;
    this.worker = this.drain()
      .catch((error: unknown) => this.fail(error))
      .finally(() => {
        this.worker = null;
        this.kick();
      });
  }

  private async drain(): Promise<void> {
    while (!this.closing && this.vectors === "ready") {
      const next = this.nextPending();
      if (!next) return;
      const { workspaceId, pageId } = next;
      const key = `${workspaceId}/${pageId}`;
      const missing = this.missingChunks(workspaceId, pageId);
      if (missing.length === 0) {
        this.pending.get(workspaceId)!.delete(pageId);
        continue;
      }
      const batch = missing.slice(0, EMBED_BATCH);
      const generation = this.generation.get(key) ?? 0;
      const vectors = await this.embedder!.embedDocuments(batch.map((chunk) => chunk.text));
      // The page changed while the model ran: these vectors are for old text.
      if (this.closing || (this.generation.get(key) ?? 0) !== generation) continue;

      this.db.exec("BEGIN IMMEDIATE");
      try {
        const link = this.db.prepare(
          `INSERT INTO vector_chunks (workspace_id, chunk_id, page_id, text_hash) VALUES (?, ?, ?, ?)
           ON CONFLICT (workspace_id, chunk_id) DO UPDATE SET text_hash = excluded.text_hash, page_id = excluded.page_id
           RETURNING id`,
        );
        const drop = this.db.prepare("DELETE FROM chunk_vectors WHERE rowid = ?");
        const store = this.db.prepare(
          "INSERT INTO chunk_vectors (rowid, workspace_id, embedding) VALUES (?, ?, ?)",
        );
        batch.forEach((chunk, i) => {
          const { id } = link.get(workspaceId, chunk.chunk_id, pageId, chunk.hash) as { id: number };
          drop.run(id);
          store.run(BigInt(id), workspaceId, vectorBytes(vectors[i]!));
        });
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      // Let requests in between batches.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private nextPending(): { workspaceId: WorkspaceId; pageId: Id } | null {
    for (const [workspaceId, pages] of this.pending) {
      const first = pages.values().next();
      if (!first.done) return { workspaceId, pageId: first.value };
    }
    return null;
  }

  private fail(error: unknown): void {
    this.vectors = "failed";
    this.vectorDetail = error instanceof Error ? error.message : String(error);
    this.onVectorError(error);
  }
}

function chunkRecord(row: ChunkRow | undefined): HitRecord | null {
  if (!row) return null;
  return {
    chunk_id: row.chunk_id,
    page_id: row.page_id,
    heading_path: row.heading_path,
    score: 0,
    snippet: excerpt(row.text),
  };
}

/** The page whose title is exactly the query, first, its chunks in their order (core `sameWords`). */
function titleFirst(ranked: HitRecord[], query: string): HitRecord[] {
  const named = ranked.find((record) => {
    const title = (JSON.parse(record.heading_path) as string[])[0];
    return title !== undefined && sameWords(query, title);
  });
  if (!named) return ranked;
  return [...ranked.filter((r) => r.page_id === named.page_id), ...ranked.filter((r) => r.page_id !== named.page_id)];
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
