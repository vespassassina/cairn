/**
 * A store that can write a self-contained, verified copy of itself (ADR-049).
 *
 * This is a capability, not part of `DocumentStore`. Taking a snapshot means
 * something quite different for a file on a disk and for a hosted database
 * that backs itself up, so forcing every adapter to answer the same question
 * would be forcing an answer rather than asking one. Callers check for it.
 */
export interface Snapshotter {
  /**
   * Write a complete, consistent copy to `destination`, then prove it can be
   * read back. Throws if the source cannot be read soundly, which is the point:
   * a backup that quietly carries damage forward is worse than no backup.
   *
   * `destination` must not already exist. On failure nothing is left behind.
   */
  snapshot(destination: string): Promise<SnapshotResult>;
}

export interface SnapshotResult {
  /** Size of the copy, in bytes. */
  bytes: number;
  /** How long it took, in milliseconds. Worth logging: it runs during shutdown. */
  ms: number;
}

export function canSnapshot(store: unknown): store is Snapshotter {
  return typeof (store as Snapshotter | null)?.snapshot === "function";
}
