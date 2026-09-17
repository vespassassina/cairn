import {
  addSources,
  CairnError,
  NotFoundError,
  PageHasChildrenError,
  PageNotDeletedError,
  parseRowNodeId,
  ValidationError,
  VersionConflictError,
  type Table,
  type Diff,
  type Edge,
  type FieldDef,
  type FieldType,
  type Page,
  type Paged,
  type Revision,
  type WriteContext,
  type Row,
  type SearchHit,
  type SearchMode,
} from "@cairn/core";
import type { AppContext } from "./context.js";

/**
 * What the MCP tools and the REST API share (ADR-013 rule 1).
 *
 * A surface translates between its protocol and these functions. It never
 * decides anything itself, so a page edited over REST and over MCP goes
 * through the same code, and the two cannot drift.
 */

// Shapes returned to agents, on every surface.

export function pageSummary(page: Page): Record<string, unknown> {
  return {
    id: page.id,
    title: page.title,
    parent_id: page.parentId,
    tags: page.tags,
    sources: page.sources,
    verified_at: page.verifiedAt,
    updated_at: page.updatedAt,
    updated_by: { kind: page.updatedBy.kind, name: page.updatedBy.label },
    version: page.version,
  };
}

export function rowJson(row: Row): Record<string, unknown> {
  return { id: row.id, values: row.values, sources: row.sources, version: row.version, updated_at: row.updatedAt };
}

export function tableJson(table: Table): Record<string, unknown> {
  return {
    id: table.id,
    name: table.name,
    parent_id: table.parentId,
    description: table.description,
    version: table.version,
    updated_at: table.updatedAt,
    fields: table.fields,
  };
}

/** A page's immediate children, as every surface reports them alongside a read. */
export function childSummaryJson(child: ChildSummary): Record<string, unknown> {
  return { id: child.id, title: child.title, has_children: child.hasChildren, changed_at: child.changedAt };
}

/** A field definition as a request sends it, with no undefined keys. */
export interface FieldInput {
  name: string;
  type: FieldType;
  required?: boolean | undefined;
  options?: string[] | undefined;
  target?: string | undefined;
  multiple?: boolean | undefined;
}

export function toFieldDefs(fields: FieldInput[]): FieldDef[] {
  return fields.map((field) => ({
    name: field.name,
    type: field.type,
    ...(field.required === undefined ? {} : { required: field.required }),
    ...(field.options === undefined ? {} : { options: field.options }),
    ...(field.target === undefined ? {} : { target: field.target }),
    ...(field.multiple === undefined ? {} : { multiple: field.multiple }),
  }));
}

/**
 * One end of a link, named for what it is (ADR-024): `page_id` for a page,
 * `table_id` for a table, and both `table_id` and `row_id`
 * for a row. `tableIds` tells a table from a page, since a link to
 * either is written `[[id]]`.
 */
export function linkJson(edge: Edge, end: "source" | "target", tableIds: ReadonlySet<string>): Record<string, unknown> {
  const id = end === "source" ? edge.sourceId : edge.targetId;
  if (edge.type === "cairn_link") {
    // The target is another Cairn's page address, not an id in this
    // workspace (ADR-038); only ever the target end, since this edge is
    // never written to point at anything of ours.
    return { cairn_url: id, type: edge.type, label: edge.label };
  }
  const row = parseRowNodeId(id);
  const where = row
    ? { table_id: row.tableId, row_id: row.rowId }
    : tableIds.has(id)
      ? { table_id: id }
      : { page_id: id };
  return { ...where, type: edge.type, label: edge.label };
}

export function revisionSummary(revision: Revision): Record<string, unknown> {
  return {
    version: revision.version,
    replaced: revision.parentVersion,
    at: revision.createdAt,
    by: { kind: revision.actor.kind, name: revision.actor.label },
    note: revision.note,
    deleted: revision.deleted || undefined,
  };
}

/** What a revision did to the sources, only when it did something (ADR-027). */
export function sourceChangesJson(view: { sourcesAdded: string[]; sourcesRemoved: string[] }): Record<string, unknown> {
  return {
    sources_added: view.sourcesAdded.length > 0 ? view.sourcesAdded : undefined,
    sources_removed: view.sourcesRemoved.length > 0 ? view.sourcesRemoved : undefined,
  };
}

/**
 * When each page was last verified, keyed by id, for search hits (ADR-028).
 * One point read per distinct page; a page deleted since it was indexed is
 * left out.
 */
export async function verifiedTimes(
  context: AppContext,
  pageIds: readonly string[],
): Promise<Map<string, string | null>> {
  const times = new Map<string, string | null>();
  for (const id of new Set(pageIds)) {
    const page = await context.store.getPage(context.workspaceId, id);
    if (page) times.set(id, page.verifiedAt);
  }
  return times;
}

/** One page's matching passages, best first, as a page-grouped search result names it (ADR-057). */
export interface PagePassage {
  headingPath: string[];
  snippet: string;
  score: number;
}

export interface PageHit {
  pageId: string;
  /** The best passage's score, since that is what ranked the page. */
  score: number;
  passages: PagePassage[];
  /** Passages that matched but were not attached, beyond the cap of 3. */
  morePassages: number;
}

export interface PagedSearchResult {
  mode: SearchMode;
  pages: PageHit[];
  truncated: boolean;
  cursor: string | null;
}

const MAX_PASSAGES_PER_PAGE = 3;

/**
 * A page appears once, its best passage leading and up to two more attached
 * to it, in the order chunk hits already arrived in (ADR-057). The internal
 * index keeps returning chunk hits; this is the layer above it that groups
 * them, so callers that want raw chunks (rebuild, eval) are unaffected.
 */
export function groupIntoPages(hits: readonly SearchHit[]): PageHit[] {
  const order: string[] = [];
  const byPage = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    if (!byPage.has(hit.pageId)) {
      byPage.set(hit.pageId, []);
      order.push(hit.pageId);
    }
    byPage.get(hit.pageId)!.push(hit);
  }
  return order.map((pageId) => {
    const chunks = byPage.get(pageId)!;
    return {
      pageId,
      score: chunks[0]!.score,
      passages: chunks.slice(0, MAX_PASSAGES_PER_PAGE).map((chunk) => ({
        headingPath: chunk.headingPath,
        snippet: chunk.snippet,
        score: chunk.score,
      })),
      morePassages: Math.max(0, chunks.length - MAX_PASSAGES_PER_PAGE),
    };
  });
}

/**
 * Each round asks the index for this many more chunks; the adapter's own cap
 * (100 in adapter-sqlite) already bounds a single call, so this just matches
 * that ceiling instead of guessing a smaller number and needing more rounds.
 */
const CHUNKS_PER_ROUND = 100;
/**
 * Safety cap on how many chunk-level rounds one page-level search issues.
 * Five rounds of 100 chunks (500 chunks) comfortably covers any query that
 * has enough distinct pages to answer a reasonable page limit; beyond that,
 * a query is either too broad to be useful or the corpus itself is unusual,
 * and either way it is better to say "no more" than to keep querying.
 */
const MAX_SEARCH_ROUNDS = 5;

function encodePageCursor(skip: number): string {
  return Buffer.from(`p:${skip}`, "utf8").toString("base64url");
}

function decodePageCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^p:(\d+)$/.exec(decoded);
  if (!match) {
    throw new ValidationError([
      { field: "cursor", message: "not a valid search cursor. Search again without a cursor to start over." },
    ]);
  }
  return Number(match[1]);
}

/**
 * Search grouped into pages (ADR-057): a limit counts pages, not chunks, and
 * a page's further passages are attached to it rather than filling their own
 * slots. Re-runs the chunk-level query from scratch, in growing batches,
 * since `SearchIndex.search` is deterministic and gives no other way to know
 * how many chunks make up N distinct pages.
 */
export async function searchPages(
  context: AppContext,
  options: { query: string; limit?: number; cursor?: string | null; mode?: SearchMode },
): Promise<PagedSearchResult> {
  const limit = options.limit ?? 10;
  const skip = options.cursor ? decodePageCursor(options.cursor) : 0;
  const needed = skip + limit;

  let hits: SearchHit[] = [];
  let pages = groupIntoPages(hits);
  let mode: SearchMode = "keyword";
  let chunkCursor: string | null = null;
  let round = 0;

  while (pages.length <= needed && round < MAX_SEARCH_ROUNDS) {
    const result = await context.search.search(context.workspaceId, {
      query: options.query,
      limit: CHUNKS_PER_ROUND,
      cursor: chunkCursor,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    mode = result.mode;
    hits = [...hits, ...result.hits];
    pages = groupIntoPages(hits);
    round += 1;
    if (!result.truncated) break;
    chunkCursor = result.cursor;
  }

  const window = pages.slice(skip, needed);
  const truncated = pages.length > needed;
  return {
    mode,
    pages: window,
    truncated,
    cursor: truncated ? encodePageCursor(needed) : null,
  };
}

/** A compact unified-style diff: only changed lines and a little context. */
export function renderDiff(diff: Diff | null, context = 2): string | null {
  if (!diff) return null;
  const keep = new Set<number>();
  diff.lines.forEach((line, i) => {
    if (line.op === "equal") return;
    for (let j = Math.max(0, i - context); j <= Math.min(diff.lines.length - 1, i + context); j += 1) {
      keep.add(j);
    }
  });
  const out: string[] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (last !== -1 && i > last + 1) out.push("…");
    const line = diff.lines[i]!;
    out.push(`${line.op === "add" ? "+" : line.op === "remove" ? "-" : " "} ${line.text}`);
    last = i;
  }
  return out.join("\n");
}

// Editing a page.

export const EDIT_MODES = ["replace_body", "append", "replace_section"] as const;
export type EditMode = (typeof EDIT_MODES)[number];

export interface PageEdit {
  mode: EditMode;
  content: string;
  /** Heading text, for replace_section. */
  section?: string | undefined;
  title?: string | undefined;
  tags?: string[] | undefined;
  /** Added to the page's sources; the ones it has are kept (ADR-027). */
  sources?: string[] | undefined;
  /** The page's facts were re-checked and still hold (ADR-028). */
  verified?: boolean | undefined;
}

/** The heading named in a replace_section edit is not on the page. */
export class SectionNotFoundError extends CairnError {
  constructor(readonly section: string) {
    super(
      `no heading matching "${section}" on this page. Read the page, or append instead.`,
      "not_found",
    );
  }
}

/**
 * Apply an edit mode to a page and write it with a version check. The modes
 * other than replace_body leave the rest of the page alone, which is PRD user
 * story 5: update one part without overwriting someone else's edits.
 */
export async function editPage(
  context: AppContext,
  pageId: string,
  expectedVersion: string,
  edit: PageEdit,
  write: WriteContext,
): Promise<Page> {
  const ws = context.workspaceId;
  const page = await context.pages.get(ws, pageId);
  let body: string;

  if (edit.mode === "replace_body") {
    body = edit.content;
  } else if (edit.mode === "append") {
    // Appending nothing leaves the body alone: an edit that only adds sources
    // or marks the page verified.
    body =
      edit.content.trim() === ""
        ? page.body
        : page.body.trimEnd() === ""
          ? edit.content
          : `${page.body.trimEnd()}\n\n${edit.content}`;
  } else {
    if (!edit.section) {
      throw new ValidationError([{ field: "section", message: "required for replace_section" }]);
    }
    const replaced = replaceSection(page.body, edit.section, edit.content);
    if (replaced === null) throw new SectionNotFoundError(edit.section);
    body = replaced;
  }

  const sources = addSources(page.sources, edit.sources);
  return context.pages.update(
    ws,
    pageId,
    {
      title: edit.title ?? page.title,
      body,
      parentId: page.parentId,
      tags: edit.tags ?? page.tags,
      ...(sources === undefined ? {} : { sources }),
      ...(edit.verified ? { verified: true } : {}),
    },
    expectedVersion,
    write,
  );
}

/**
 * Create or update a row, adding `sources` to the ones it has rather than
 * replacing them (ADR-027). What the agent-facing writes use: MCP
 * `upsert_row` and the CLI. REST `PUT` replaces the whole row, sources too.
 */
export async function writeRow(
  context: AppContext,
  tableId: string,
  values: Record<string, unknown>,
  sources: string[] | undefined,
  write: WriteContext,
  options: { id?: string; expectedVersion?: string } = {},
): Promise<Row> {
  const ws = context.workspaceId;
  const existing =
    options.id !== undefined && options.expectedVersion !== undefined && sources?.length
      ? await context.tables.getRow(ws, tableId, options.id)
      : null;
  const merged = addSources(existing?.sources ?? [], sources);
  return context.tables.upsertRow(
    ws,
    tableId,
    { values: values as Row["values"], ...(merged === undefined ? {} : { sources: merged }) },
    write,
    options,
  );
}

/**
 * Replace the body under a Markdown heading, leaving the rest of the page
 * untouched.
 */
export function replaceSection(body: string, heading: string, content: string): string | null {
  const lines = body.split("\n");
  const target = heading.trim().toLowerCase();
  const headingAt = (line: string): number | null => {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    return match ? match[1]!.length : null;
  };

  const start = lines.findIndex((line) => {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    return match?.[2]!.trim().toLowerCase() === target;
  });
  if (start === -1) return null;

  const depth = headingAt(lines[start]!)!;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const level = headingAt(lines[i]!);
    if (level !== null && level <= depth) {
      end = i;
      break;
    }
  }

  return [...lines.slice(0, start + 1), "", content.trim(), "", ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}

// Errors.

export interface ErrorBody {
  error: string;
  message: string;
  [key: string]: unknown;
}

export interface DescribedError {
  status: 400 | 404 | 409 | 422 | 500;
  body: ErrorBody;
}

/** The next step to suggest, in the words of each surface. */
export interface ErrorWording {
  conflict: string;
  notFound: (kind: string, id: string) => string;
  validation: string;
}

/**
 * Turns a domain error into something an agent can act on rather than a
 * stack trace. A version conflict carries the current content so the next
 * call can merge; a validation error names every bad field at once.
 */
export function describeError(error: unknown, wording: ErrorWording): DescribedError {
  if (error instanceof VersionConflictError) {
    return {
      status: 409,
      body: {
        error: "version_conflict",
        message: `${error.kind} changed since you read it. ${wording.conflict}`,
        current_version: (error.current as { version?: string } | null)?.version ?? null,
        current_content: error.current,
      },
    };
  }
  if (error instanceof ValidationError) {
    return {
      status: 422,
      body: { error: "validation_failed", message: wording.validation, fields: error.errors },
    };
  }
  if (error instanceof NotFoundError) {
    return {
      status: 404,
      body: { error: "not_found", message: wording.notFound(error.kind, error.id) },
    };
  }
  if (error instanceof CairnError && error.code === "not_found") {
    return { status: 404, body: { error: "not_found", message: error.message } };
  }
  if (error instanceof PageHasChildrenError) {
    return { status: 422, body: { error: "has_children", message: error.message, count: error.count } };
  }
  if (error instanceof PageNotDeletedError) {
    return { status: 422, body: { error: "not_deleted", message: error.message } };
  }
  return {
    status: 500,
    body: { error: "internal", message: error instanceof Error ? error.message : String(error) },
  };
}

/**
 * Move a page or a table under a page, or to the top with null
 * (ADR-024). The id says which: pages are tried first. Needs the version the
 * caller read, like any other write.
 */
/**
 * Publish a page, or take it down (ADR-032). The console and the CLI both do
 * this, so the rule lives here: only a page can be published, and publishing
 * it publishes everything under it.
 */
export async function publishPage(
  context: AppContext,
  id: string,
  isPublic: boolean,
  version: string,
  by: WriteContext,
): Promise<{ id: string; public: boolean; version: string }> {
  const ws = context.workspaceId;
  const page = await context.store.getPage(ws, id);
  if (!page) throw new NotFoundError("page", id);
  const written = await context.pages.update(
    ws,
    id,
    { title: page.title, body: page.body, tags: page.tags, parentId: page.parentId, public: isPublic },
    version,
    by,
  );
  return { id, public: written.public, version: written.version };
}

export async function moveRecord(
  context: AppContext,
  id: string,
  parentId: string | null,
  version: string,
  by: WriteContext,
): Promise<{ kind: "page" | "table"; id: string; parent_id: string | null; version: string }> {
  const ws = context.workspaceId;
  if (parentId === id) throw new ValidationError([{ field: "parent_id", message: "a record cannot be its own parent" }]);
  if (parentId !== null && !(await context.store.getPage(ws, parentId))) {
    throw new ValidationError([{ field: "parent_id", message: `no page ${parentId}; a parent must be a page` }]);
  }
  const page = await context.store.getPage(ws, id);
  if (page) {
    // Sources left out: the page keeps its own (ADR-027).
    // A page under one of its own descendants would cut a loop out of the tree.
    for (let at = parentId, depth = 0; at !== null && depth < 64; depth += 1) {
      if (at === id) throw new ValidationError([{ field: "parent_id", message: "that page is inside this one" }]);
      at = (await context.store.getPage(ws, at))?.parentId ?? null;
    }
    const moved = await context.pages.update(ws, id, { title: page.title, body: page.body, tags: page.tags, parentId }, version, by);
    return { kind: "page", id, parent_id: moved.parentId, version: moved.version };
  }
  const table = await context.store.getTable(ws, id);
  if (!table) throw new NotFoundError("page or table", id);
  const moved = await context.tables.move(ws, id, parentId, version, by);
  return { kind: "table", id, parent_id: moved.parentId, version: moved.version };
}

// Walking the tree (ADR-058).

export interface ChildSummary {
  id: string;
  title: string;
  hasChildren: boolean;
  changedAt: string;
}

/** Every immediate child of a page, or every top-level page for null, unsorted and unpaged. */
async function collectChildren(
  context: AppContext,
  parentId: string | null,
): Promise<Page[]> {
  const all: Page[] = [];
  let cursor: string | null = null;
  for (;;) {
    const batch: Paged<Page> = await context.store.listPages(context.workspaceId, {
      parentId,
      limit: 500,
      cursor,
    });
    all.push(...batch.items);
    if (!batch.cursor) return all;
    cursor = batch.cursor;
  }
}

const CHILDREN_PAGE_LIMIT = 50;
const MAX_CHILDREN_LIMIT = 200;

function encodeChildrenCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, "utf8").toString("base64url");
}

function decodeChildrenCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const match = /^o:(\d+)$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match) throw new ValidationError([{ field: "cursor", message: "not a cursor from list_children" }]);
  return Number(match[1]);
}

/**
 * Immediate children of a page, in title order, or the top-level pages when
 * `parentId` is omitted (ADR-058). One surface, three translations: MCP's
 * `list_children`, `GET /pages?parent=`, and `cairn ls`.
 */
export async function listChildren(
  context: AppContext,
  options: { parentId?: string | null; cursor?: string | null; limit?: number },
): Promise<{ items: ChildSummary[]; cursor: string | null }> {
  const parentId = options.parentId === undefined ? null : options.parentId;
  const all = await collectChildren(context, parentId);
  all.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const offset = decodeChildrenCursor(options.cursor);
  const limit = Math.max(1, Math.min(MAX_CHILDREN_LIMIT, options.limit ?? CHILDREN_PAGE_LIMIT));
  const slice = all.slice(offset, offset + limit);
  const items = await Promise.all(
    slice.map(async (page): Promise<ChildSummary> => {
      const kids = await context.store.listPages(context.workspaceId, { parentId: page.id, limit: 1 });
      return { id: page.id, title: page.title, hasChildren: kids.items.length > 0, changedAt: page.editedAt };
    }),
  );
  const nextOffset = offset + slice.length;
  return { items, cursor: nextOffset < all.length ? encodeChildrenCursor(nextOffset) : null };
}

/** Up to 8 children plus the count of the rest, for a page read on every surface. */
export async function childrenPreview(
  context: AppContext,
  pageId: string,
): Promise<{ items: ChildSummary[]; more: number }> {
  const all = await collectChildren(context, pageId);
  all.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const shown = all.slice(0, 8);
  const items = await Promise.all(
    shown.map(async (page): Promise<ChildSummary> => {
      const kids = await context.store.listPages(context.workspaceId, { parentId: page.id, limit: 1 });
      return { id: page.id, title: page.title, hasChildren: kids.items.length > 0, changedAt: page.editedAt };
    }),
  );
  return { items, more: all.length - shown.length };
}

/**
 * Delete a page, refusing one that still has children (ADR-058): deleting it
 * would leave them with no parent to walk back to. History is kept either
 * way; `get_revision` still reaches whatever a deleted page held.
 */
export async function deletePage(
  context: AppContext,
  id: string,
  expectedVersion: string,
  by: WriteContext,
): Promise<void> {
  const children = await collectChildren(context, id);
  if (children.length > 0) throw new PageHasChildrenError(id, children.length);
  await context.pages.delete(context.workspaceId, id, expectedVersion, by);
}

/** A deleted page as every surface reports it in `list_deleted_pages` / `cairn deleted`. */
export function deletedPageSummary(revision: Revision): Record<string, unknown> {
  const snapshot = revision.snapshot as { title: string; parentId: string | null; tags: string[] };
  return {
    id: revision.recordId,
    title: snapshot.title,
    parent_id: snapshot.parentId,
    tags: snapshot.tags,
    deleted_at: revision.createdAt,
    deleted_by: { kind: revision.actor.kind, name: revision.actor.label },
    note: revision.note,
  };
}

/**
 * Deleted pages, newest deletion first. Shared by REST's `GET /pages/deleted`,
 * MCP's `list_deleted_pages` tool and `cairn deleted` (ADR-059).
 */
export async function listDeletedPages(
  context: AppContext,
  options: { cursor?: string | null; limit?: number },
): Promise<Paged<Revision>> {
  return context.pages.listDeleted(context.workspaceId, options);
}

/**
 * Bring a deleted page back, with its last content, at the same id, so links
 * to it keep working (ADR-059). Shared by REST's `POST /pages/:id/undelete`,
 * MCP's `undelete_page` tool and `cairn undelete`.
 */
export async function undeletePage(context: AppContext, id: string, by: WriteContext): Promise<Page> {
  return context.pages.undelete(context.workspaceId, id, by);
}

/**
 * Prune a page's history to its current version and compact the database
 * (ADR-059). Shared by REST's `POST /pages/:id/vacuum`, MCP's `vacuum_page`
 * tool and `cairn vacuum`.
 */
export async function vacuumPage(
  context: AppContext,
  id: string,
  expectedVersion: string,
): Promise<{ removed: number }> {
  return context.pages.vacuum(context.workspaceId, id, expectedVersion);
}

// The changes feed (ADR-013 rule 4, ADR-058).

export function revisionDetail(revision: Revision): Record<string, unknown> {
  const base = { kind: revision.kind, ...revisionSummary(revision) };
  if (revision.kind === "page") {
    const snapshot = revision.snapshot as { title: string };
    return { ...base, page_id: revision.recordId, title: snapshot.title };
  }
  const rowId = revision.recordId.slice((revision.tableId ?? "").length + 1);
  return { ...base, table_id: revision.tableId, row_id: rowId };
}

/**
 * Revisions across the workspace, newest first, until `limit` or `since`
 * (inclusive). Shared by REST's `GET /changes`, MCP's `changes` tool and
 * `cairn changes`.
 */
export async function listChanges(
  context: AppContext,
  options: { since?: string; actorKind?: "user" | "agent"; cursor?: string | null; limit?: number },
): Promise<{ changes: Revision[]; newest: string | null; cursor: string | null }> {
  const limit = options.limit ?? 50;
  const sinceMs = options.since === undefined ? null : Date.parse(options.since);
  const changes: Revision[] = [];
  let cursor: string | null = options.cursor ?? null;
  let reachedSince = false;
  do {
    const batch: Paged<Revision> = await context.store.listRecentRevisions(context.workspaceId, {
      limit: Math.min(limit - changes.length, 100),
      cursor,
      ...(options.actorKind === undefined ? {} : { actorKind: options.actorKind }),
    });
    for (const revision of batch.items) {
      if (sinceMs !== null && Date.parse(revision.createdAt) < sinceMs) {
        reachedSince = true;
        break;
      }
      changes.push(revision);
    }
    cursor = batch.cursor;
  } while (!reachedSince && cursor !== null && changes.length < limit);

  return {
    changes,
    newest: changes[0]?.createdAt ?? options.since ?? null,
    cursor: reachedSince ? null : cursor,
  };
}
