import type { ChunkInput, Id, WorkspaceId } from "../types.js";

/**
 * Search is its own adapter, independent of the document store (ADR-005 rule
 * 1). Azure pairs Cosmos with Cosmos full-text, AWS pairs DynamoDB with a
 * serialized index in S3, self-hosted pairs SQLite with FTS5.
 */

export type SearchMode = "keyword" | "hybrid";

export interface SearchHit {
  pageId: Id;
  chunkId: Id;
  /** Headings above the match, outermost first. Shown to Claude for context. */
  headingPath: string[];
  /** Short extract with the match in it. Never the whole chunk. */
  snippet: string;
  /**
   * Backend-native relevance, higher is better. Comparable within one result
   * set only. BM25 scoring differs between Cosmos, FTS5 and a JavaScript
   * index, which is why recall is reported per backend (PRD section 10).
   */
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /**
   * Which path produced these hits. `keyword` when embeddings are off or the
   * endpoint failed. Never an error: optional services degrade, they do not
   * throw into the core path (PRD principle 3).
   */
  mode: SearchMode;
  /** True when the result was cut to fit a budget. `cursor` continues it. */
  truncated: boolean;
  cursor: string | null;
}

export interface SearchIndexCapabilities {
  /** Adapter can store and query vectors. Off until embeddings are enabled. */
  readonly vectors: boolean;
}

export interface SearchIndex {
  readonly capabilities: SearchIndexCapabilities;

  init(): Promise<void>;
  close(): Promise<void>;

  /**
   * Replaces every chunk of one page. The only way to write chunks, and
   * idempotent, so a rebuild produces the same index (ADR-005 rule 2).
   */
  replaceChunksForPage(
    workspaceId: WorkspaceId,
    pageId: Id,
    chunks: ChunkInput[],
  ): Promise<void>;

  /** Removes a page from the index. Same as replacing with an empty list. */
  deleteChunksForPage(workspaceId: WorkspaceId, pageId: Id): Promise<void>;

  /**
   * Eventual, bounded by EVENTUAL_CONSISTENCY_BOUND_MS.
   *
   * Never throws for a query that simply matches nothing, and never throws
   * because an optional vector backend is unavailable. It falls back to
   * keyword mode and says so in `mode`.
   */
  search(
    workspaceId: WorkspaceId,
    options: {
      query: string;
      limit?: number;
      cursor?: string | null;
      /** Ignored, with `mode: "keyword"` returned, when vectors are off. */
      mode?: SearchMode;
    },
  ): Promise<SearchResult>;
}
