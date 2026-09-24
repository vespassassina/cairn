import type { Id, WriteContext, WorkspaceId } from "../types.js";

/**
 * Per-collection synonyms (ADR-077): pairs of words the owner or an agent
 * says mean the same thing in one domain, so a search for either finds pages
 * that only use the other. "Collection" is a top-level page (the same sense
 * `mcp/summary.ts` already uses for "Collections (top-level pages)"), not a
 * `Table` (ADR-024's "collection"): keeping the pairs scoped to a domain
 * lets "GHRP" mean something under Peptides without also expanding an
 * unrelated word under Projects.
 *
 * A dedicated store, not the generic table/row mechanism (ADR-024's
 * `Table`): a pair is two short words, not a record with typed fields, and
 * keeping it out of `list_tables` and `query_table` keeps those tools free
 * of a workspace's growing synonym lists.
 */

export interface SynonymPair {
  id: Id;
  workspaceId: WorkspaceId;
  /** The top-level page this pair belongs to. */
  collectionId: Id;
  /** Folded the way `core/search/terms.ts` folds a query term. */
  term: string;
  /** Folded the same way. Unordered with `term`: either side finds the other. */
  synonym: string;
  createdAt: string;
}

export interface SynonymsStore {
  init(): Promise<void>;
  close(): Promise<void>;

  /** A collection's own pairs, in the order they were added. */
  list(workspaceId: WorkspaceId, collectionId: Id): Promise<SynonymPair[]>;

  /**
   * Adds a pair, folding both words first. Adding the same pair twice, in
   * either order, returns the existing one rather than a duplicate.
   */
  add(
    workspaceId: WorkspaceId,
    collectionId: Id,
    term: string,
    synonym: string,
    by: WriteContext,
  ): Promise<SynonymPair>;

  /** Removes a pair. Does nothing if it is not there. */
  remove(workspaceId: WorkspaceId, collectionId: Id, term: string, synonym: string): Promise<void>;

  /**
   * Every pair in the workspace, across every collection. Search has no
   * collection to scope to (ADR-077): a query is asked of the whole
   * workspace, so expansion is too, and "collection" only shapes where a
   * human curates a pair, not where it fires at query time.
   */
  listAll(workspaceId: WorkspaceId): Promise<SynonymPair[]>;
}
