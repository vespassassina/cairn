import { VersionConflictError } from "../errors.js";
import { newVersion } from "../ids.js";
import type { DocumentStore } from "../ports/document-store.js";
import type {
  ExpectedVersion,
  Id,
  PageSnapshot,
  Paged,
  Revision,
  RevisionKind,
  RowSnapshot,
  Version,
  WorkspaceId,
  WriteContext,
  WriteMeta,
} from "../types.js";

/**
 * The revision half of every write (ADR-008 rule 3), shared by pages and rows.
 *
 * 1. Write the revision. Immutable and keyed by a fresh version, so it cannot
 *    conflict.
 * 2. Write the record, checking the expected version.
 * 3. If step 2 conflicts, delete the revision from step 1.
 *
 * A crash between 1 and 2 leaves a revision off the chain. Readers never see
 * it, because history is read by walking the chain from the record's current
 * version, and {@link sweepOrphans} removes it.
 */
export async function writeWithRevision<T>(
  store: DocumentStore,
  target: {
    workspaceId: WorkspaceId;
    kind: RevisionKind;
    recordId: Id;
    tableId: Id | null;
    expectedVersion: ExpectedVersion;
    snapshot: PageSnapshot | RowSnapshot;
    deleted?: boolean;
  },
  context: WriteContext,
  write: (meta: WriteMeta) => Promise<T>,
): Promise<T> {
  const meta: WriteMeta = {
    version: newVersion(),
    actor: context.actor,
    at: new Date().toISOString(),
  };

  await store.putRevision(target.workspaceId, {
    kind: target.kind,
    recordId: target.recordId,
    tableId: target.tableId,
    version: meta.version,
    parentVersion: target.expectedVersion,
    actor: meta.actor,
    note: context.note?.trim() || null,
    createdAt: meta.at,
    deleted: target.deleted ?? false,
    snapshot: target.snapshot,
  });

  try {
    return await write(meta);
  } catch (error) {
    if (error instanceof VersionConflictError) {
      // Best effort. If this fails too, the revision is off the chain and
      // invisible, and the next sweep removes it.
      await store
        .deleteRevision(target.workspaceId, target.kind, target.recordId, meta.version)
        .catch(() => undefined);
    }
    throw error;
  }
}

/** Upper bound on revisions read for one record's history. */
const MAX_HISTORY_READ = 2_000;

async function readAllRevisions(
  store: DocumentStore,
  workspaceId: WorkspaceId,
  kind: RevisionKind,
  recordId: Id,
): Promise<Revision[]> {
  const all: Revision[] = [];
  let cursor: string | null = null;
  do {
    const batch: Paged<Revision> = await store.listRevisions(workspaceId, kind, recordId, {
      limit: 500,
      cursor,
    });
    all.push(...batch.items);
    cursor = batch.cursor;
  } while (cursor !== null && all.length < MAX_HISTORY_READ);
  return all;
}

/**
 * The history of one record, newest first, found by walking `parentVersion`
 * back from `headVersion`. Revisions off the chain are not returned.
 *
 * `headVersion` is the record's current version. For a deleted record there is
 * no current version, so pass null and the walk starts from the newest
 * deletion revision.
 */
export async function readHistory(
  store: DocumentStore,
  workspaceId: WorkspaceId,
  kind: RevisionKind,
  recordId: Id,
  headVersion: Version | null,
  options: { limit?: number } = {},
): Promise<Revision[]> {
  const all = await readAllRevisions(store, workspaceId, kind, recordId);
  const byVersion = new Map(all.map((revision) => [revision.version, revision]));

  let next: Version | null =
    headVersion ?? all.find((revision) => revision.deleted)?.version ?? null;
  const chain: Revision[] = [];
  const limit = options.limit ?? 50;

  // The seen set guards against a malformed chain looping forever.
  const seen = new Set<Version>();
  while (next !== null && chain.length < limit && !seen.has(next)) {
    seen.add(next);
    const revision = byVersion.get(next);
    if (!revision) break;
    chain.push(revision);
    next = revision.parentVersion;
  }
  return chain;
}

/**
 * An orphan younger than this may belong to a write still between its two
 * steps. Deleting it would break that write's chain, so the sweep leaves it.
 */
export const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Deletes revisions of one record that are off its chain and older than
 * {@link ORPHAN_MIN_AGE_MS}. Run by the rebuild command. Returns how many it
 * removed.
 */
export async function sweepOrphans(
  store: DocumentStore,
  workspaceId: WorkspaceId,
  kind: RevisionKind,
  recordId: Id,
  headVersion: Version,
  now: number = Date.now(),
): Promise<number> {
  const all = await readAllRevisions(store, workspaceId, kind, recordId);
  const onChain = new Set(
    (
      await readHistory(store, workspaceId, kind, recordId, headVersion, {
        limit: Number.MAX_SAFE_INTEGER,
      })
    ).map((revision) => revision.version),
  );
  let removed = 0;
  for (const revision of all) {
    const age = now - Date.parse(revision.createdAt);
    if (!onChain.has(revision.version) && age >= ORPHAN_MIN_AGE_MS) {
      await store.deleteRevision(workspaceId, kind, recordId, revision.version);
      removed += 1;
    }
  }
  return removed;
}
