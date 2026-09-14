import { NotFoundError } from "../errors.js";
import { newPageId } from "../ids.js";
import { diffLines, type Diff } from "../history/diff.js";
import { readHistory, sweepOrphans, writeWithRevision } from "../history/revisions.js";
import { chunkPage, DEFAULT_CHUNK_OPTIONS, type ChunkOptions } from "../indexer/chunk.js";
import { extractReferences } from "../indexer/extract.js";
import { normalizeVerifiedAt } from "../freshness.js";
import { normalizeSources } from "../sources.js";
import type { DocumentStore } from "../ports/document-store.js";
import type { SearchIndex } from "../ports/search-index.js";
import type {
  Edge,
  ExpectedVersion,
  Id,
  Page,
  PageInput,
  PageSnapshot,
  Revision,
  Version,
  WorkspaceId,
  WriteContext,
} from "../types.js";

export interface PageServiceOptions {
  chunking?: ChunkOptions;
}

/** A revision of a page, with its diff against the version it replaced. */
export interface PageRevisionView {
  revision: Revision;
  snapshot: PageSnapshot;
  /** Diff of the body against the parent revision. Null for the first one. */
  diff: Diff | null;
  /** Whether the title or tags changed too, since the diff covers the body only. */
  titleChanged: boolean;
  tagsChanged: boolean;
  /** Sources this revision added, and ones it dropped (ADR-027). */
  sourcesAdded: string[];
  sourcesRemoved: string[];
  /** Whether this revision confirmed the page's facts (ADR-028). */
  verified: boolean;
}

function snapshotOf(input: PageInput): PageSnapshot {
  return {
    title: input.title,
    parentId: input.parentId ?? null,
    tags: input.tags ?? [],
    body: input.body,
    sources: input.sources ?? [],
    verifiedAt: input.verifiedAt ?? null,
  };
}

/** What a revision's sources changed against the one before it (ADR-027). */
export function sourceChanges(
  before: readonly string[] | undefined,
  after: readonly string[] | undefined,
): { sourcesAdded: string[]; sourcesRemoved: string[] } {
  // A revision from before ADR-027 carries no list, which is not a removal.
  if (after === undefined) return { sourcesAdded: [], sourcesRemoved: [] };
  const was = new Set(before ?? []);
  const now = new Set(after);
  return {
    sourcesAdded: after.filter((source) => !was.has(source)),
    sourcesRemoved: before === undefined ? [] : before.filter((source) => !now.has(source)),
  };
}

/**
 * The page write path.
 *
 * Order matters and is part of the design (ADR-005 rule 3, ADR-008 rule 3):
 *
 * 1. The revision, immutable and keyed by the new version.
 * 2. The page, checked against the expected version.
 * 3. Its edges and chunks.
 *
 * A crash after 1 leaves a revision off the chain, which no reader sees. A
 * crash after 2 leaves stale derived data, which {@link rebuildPage} and
 * {@link rebuildWorkspace} repair. Nothing is ever left half-written in a way a
 * reader can observe.
 */
export class PageService {
  private readonly chunking: ChunkOptions;

  constructor(
    private readonly store: DocumentStore,
    private readonly search: SearchIndex,
    options: PageServiceOptions = {},
  ) {
    this.chunking = options.chunking ?? DEFAULT_CHUNK_OPTIONS;
  }

  async get(workspaceId: WorkspaceId, id: Id): Promise<Page> {
    const page = await this.store.getPage(workspaceId, id);
    if (!page) throw new NotFoundError("page", id);
    return page;
  }

  async create(
    workspaceId: WorkspaceId,
    input: PageInput,
    context: WriteContext,
    id: Id = newPageId(),
  ): Promise<Page> {
    return this.write(workspaceId, id, input, null, context);
  }

  /**
   * @throws VersionConflictError carrying the current page, so the caller can
   * merge and retry (PRD section 5, edge case 3).
   */
  async update(
    workspaceId: WorkspaceId,
    id: Id,
    input: PageInput,
    expectedVersion: ExpectedVersion,
    context: WriteContext,
  ): Promise<Page> {
    return this.write(workspaceId, id, input, expectedVersion, context);
  }

  /**
   * Records a deletion revision holding the last content, then deletes the
   * page. History survives the deletion (ADR-008 consequence 4).
   */
  async delete(
    workspaceId: WorkspaceId,
    id: Id,
    expectedVersion: Version,
    context: WriteContext,
  ): Promise<void> {
    const page = await this.get(workspaceId, id);
    await writeWithRevision(
      this.store,
      {
        workspaceId,
        kind: "page",
        recordId: id,
        tableId: null,
        expectedVersion,
        snapshot: snapshotOf(page),
        deleted: true,
      },
      context,
      () => this.store.deletePage(workspaceId, id, expectedVersion),
    );
    await this.store.replaceEdgesForSource(workspaceId, id, []);
    await this.search.deleteChunksForPage(workspaceId, id);
  }

  /** Pages linking to this one. Eventually consistent (PRD P0.3). */
  async backlinks(workspaceId: WorkspaceId, id: Id): Promise<Edge[]> {
    return this.store.getInboundEdges(workspaceId, id);
  }

  async neighbours(
    workspaceId: WorkspaceId,
    id: Id,
  ): Promise<{ outbound: Edge[]; inbound: Edge[] }> {
    const [outbound, inbound] = await Promise.all([
      this.store.getOutboundEdges(workspaceId, id),
      this.store.getInboundEdges(workspaceId, id),
    ]);
    return { outbound, inbound };
  }

  // History (ADR-008).

  /**
   * Revisions of a page, newest first. Works for a deleted page too, starting
   * from its deletion revision.
   */
  async history(
    workspaceId: WorkspaceId,
    id: Id,
    options: { limit?: number } = {},
  ): Promise<Revision[]> {
    const page = await this.store.getPage(workspaceId, id);
    return readHistory(this.store, workspaceId, "page", id, page?.version ?? null, options);
  }

  /** One revision, with the body diff against the revision it replaced. */
  async revision(
    workspaceId: WorkspaceId,
    id: Id,
    version: Version,
  ): Promise<PageRevisionView> {
    const revision = await this.store.getRevision(workspaceId, "page", id, version);
    if (!revision) throw new NotFoundError("revision", `${id}@${version}`);
    const snapshot = revision.snapshot as PageSnapshot;

    const parent = revision.parentVersion
      ? await this.store.getRevision(workspaceId, "page", id, revision.parentVersion)
      : null;
    const before = parent ? (parent.snapshot as PageSnapshot) : null;

    return {
      revision,
      snapshot,
      diff: before ? diffLines(before.body, snapshot.body) : null,
      titleChanged: before !== null && before.title !== snapshot.title,
      tagsChanged:
        before !== null && JSON.stringify(before.tags) !== JSON.stringify(snapshot.tags),
      ...sourceChanges(before?.sources, snapshot.sources),
      // Set by this write, not carried over or restored from an older one.
      verified: snapshot.verifiedAt === revision.createdAt,
    };
  }

  /**
   * Restore a page to an earlier revision. An ordinary update whose content
   * comes from the old snapshot, so it creates a new revision and can itself
   * be undone (ADR-008 consequence 3).
   */
  async restore(
    workspaceId: WorkspaceId,
    id: Id,
    version: Version,
    expectedVersion: Version,
    context: WriteContext,
  ): Promise<Page> {
    // A revision from before ADR-027 has no sources, and one from before
    // ADR-028 no verification time: the page keeps its own.
    const { snapshot } = await this.revision(workspaceId, id, version);
    return this.update(workspaceId, id, snapshot, expectedVersion, {
      actor: context.actor,
      note: context.note ?? `Restored version ${version.slice(0, 8)}`,
    });
  }

  // Maintenance.

  /** Regenerates derived data for one page from the page itself. Idempotent. */
  async rebuildPage(workspaceId: WorkspaceId, id: Id): Promise<void> {
    const page = await this.store.getPage(workspaceId, id);
    if (!page) {
      // The page is gone, so its derived data should be too.
      await this.store.replaceEdgesForSource(workspaceId, id, []);
      await this.search.deleteChunksForPage(workspaceId, id);
      return;
    }
    await this.index(page);
  }

  /**
   * Regenerates every edge and chunk in the workspace (PRD P0.9), and sweeps
   * revisions left off their chain by a crashed write (ADR-008 rule 3).
   * Streams page ids so a large workspace never lands in memory.
   */
  async rebuildWorkspace(
    workspaceId: WorkspaceId,
  ): Promise<{ pages: number; orphanRevisions: number }> {
    let pages = 0;
    let orphanRevisions = 0;
    for await (const id of this.store.iteratePageIds(workspaceId)) {
      await this.rebuildPage(workspaceId, id);
      const page = await this.store.getPage(workspaceId, id);
      if (page) {
        orphanRevisions += await sweepOrphans(this.store, workspaceId, "page", id, page.version);
      }
      pages += 1;
    }
    return { pages, orphanRevisions };
  }

  private async write(
    workspaceId: WorkspaceId,
    id: Id,
    input: PageInput,
    expectedVersion: ExpectedVersion,
    context: WriteContext,
  ): Promise<Page> {
    const at = new Date().toISOString();
    // A new page has nothing to keep; the check against it comes in putPage.
    const current = expectedVersion === null ? null : await this.store.getPage(workspaceId, id);
    const { verified, verifiedAt, ...rest } = input;
    const sources = input.sources === undefined ? (current?.sources ?? []) : normalizeSources(input.sources);
    input = {
      ...rest,
      sources,
      verifiedAt: verified
        ? at
        : verifiedAt !== undefined
          ? normalizeVerifiedAt(verifiedAt)
          : expectedVersion === null
            ? // A page written with its sources counts as checked (ADR-028).
              sources.length > 0
              ? at
              : null
            : (current?.verifiedAt ?? null),
    };
    const page = await writeWithRevision(
      this.store,
      {
        workspaceId,
        kind: "page",
        recordId: id,
        tableId: null,
        expectedVersion,
        snapshot: snapshotOf(input),
        at,
      },
      context,
      (meta) => this.store.putPage(workspaceId, id, input, expectedVersion, meta),
    );
    await this.index(page);
    return page;
  }

  private async index(page: Page): Promise<void> {
    const { edges } = extractReferences(page);
    await this.store.replaceEdgesForSource(page.workspaceId, page.id, edges);
    await this.search.replaceChunksForPage(
      page.workspaceId,
      page.id,
      chunkPage(page, this.chunking),
    );
  }
}
