import { NotFoundError } from "../errors.js";
import { newPageId } from "../ids.js";
import { chunkPage, DEFAULT_CHUNK_OPTIONS, type ChunkOptions } from "../indexer/chunk.js";
import { extractReferences } from "../indexer/extract.js";
import type { DocumentStore } from "../ports/document-store.js";
import type { SearchIndex } from "../ports/search-index.js";
import type {
  Edge,
  ExpectedVersion,
  Id,
  Page,
  PageInput,
  WorkspaceId,
} from "../types.js";

export interface PageServiceOptions {
  chunking?: ChunkOptions;
}

/**
 * The page write path.
 *
 * Order matters and is part of the design (ADR-005 rule 3). The page is
 * written first and either succeeds or conflicts. Derived data follows. A
 * crash in between leaves the page correct and its edges and chunks stale,
 * which {@link rebuildPage} and {@link rebuildWorkspace} repair. Nothing is
 * ever left half-written, because no caller may assume the two are atomic.
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
    id: Id = newPageId(),
  ): Promise<Page> {
    const page = await this.store.putPage(workspaceId, id, input, null);
    await this.index(page);
    return page;
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
  ): Promise<Page> {
    const page = await this.store.putPage(workspaceId, id, input, expectedVersion);
    await this.index(page);
    return page;
  }

  async delete(
    workspaceId: WorkspaceId,
    id: Id,
    expectedVersion: ExpectedVersion,
  ): Promise<void> {
    await this.store.deletePage(workspaceId, id, expectedVersion);
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
   * Regenerates every edge and chunk in the workspace (PRD P0.9). The recovery
   * path for a bad index, a changed chunking strategy or a half-applied write.
   * Streams page ids so a large workspace never lands in memory.
   */
  async rebuildWorkspace(workspaceId: WorkspaceId): Promise<{ pages: number }> {
    let pages = 0;
    for await (const id of this.store.iteratePageIds(workspaceId)) {
      await this.rebuildPage(workspaceId, id);
      pages += 1;
    }
    return { pages };
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
