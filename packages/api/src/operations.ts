import {
  CairnError,
  NotFoundError,
  ValidationError,
  VersionConflictError,
  type Collection,
  type Diff,
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
    updated_at: page.updatedAt,
    updated_by: { kind: page.updatedBy.kind, name: page.updatedBy.label },
    version: page.version,
  };
}

export function rowJson(row: Row): Record<string, unknown> {
  return { id: row.id, values: row.values, version: row.version, updated_at: row.updatedAt };
}

export function collectionJson(collection: Collection): Record<string, unknown> {
  return {
    id: collection.id,
    name: collection.name,
    version: collection.version,
    updated_at: collection.updatedAt,
    fields: collection.fields,
  };
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
    body = page.body.trimEnd() === "" ? edit.content : `${page.body.trimEnd()}\n\n${edit.content}`;
  } else {
    if (!edit.section) {
      throw new ValidationError([{ field: "section", message: "required for replace_section" }]);
    }
    const replaced = replaceSection(page.body, edit.section, edit.content);
    if (replaced === null) throw new SectionNotFoundError(edit.section);
    body = replaced;
  }

  return context.pages.update(
    ws,
    pageId,
    { title: edit.title ?? page.title, body, parentId: page.parentId, tags: edit.tags ?? page.tags },
    expectedVersion,
    write,
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
