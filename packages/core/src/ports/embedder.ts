/**
 * Turns text into vectors for semantic search (ADR-022). Optional: without
 * one, search runs in keyword mode, and nothing else changes (PRD principle 3).
 *
 * An embedder is slow compared with a keyword index and may fail, so callers
 * never put it on the write path: chunks are indexed by keyword at once, and
 * embedded in the background.
 */
export interface Embedder {
  /**
   * The model and its settings, such as `Xenova/bge-small-en-v1.5 q8`.
   * Vectors stored under another name are stale and are rebuilt.
   */
  readonly model: string;

  /**
   * Loads the model. May download it the first time. Rejects if the model
   * cannot be loaded; the caller then stays in keyword mode.
   */
  init(): Promise<void>;

  /** Length of every vector. Known once `init` has resolved. */
  readonly dimensions: number;

  /** Vectors for stored text, one per input, normalised to length 1. */
  embedDocuments(texts: string[]): Promise<Float32Array[]>;

  /**
   * The vector for a search query, normalised to length 1. Some models want
   * an instruction in front of a query; the embedder adds it.
   */
  embedQuery(text: string): Promise<Float32Array>;

  close(): Promise<void>;
}
