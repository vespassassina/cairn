import {
  addSources,
  CairnError,
  NotFoundError,
  parseRowNodeId,
  ValidationError,
  VersionConflictError,
  type Table,
  type Diff,
  type Edge,
  type FieldDef,
  type FieldType,
  type Page,
  type Revision,
  type Row,
  type WriteContext,
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
    version: table.version,
    updated_at: table.updatedAt,
    fields: table.fields,
  };
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
    // Appending nothing leaves the body alone: an edit that only adds sources.
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
