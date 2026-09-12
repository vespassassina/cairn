import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  NotFoundError,
  ValidationError,
  VersionConflictError,
  type Actor,
  type Diff,
  type Page,
  type Revision,
} from "@cairn/core";
import { budgetList, budgetText, DEFAULT_TOKEN_BUDGET } from "../budget.js";
import type { AppContext } from "../context.js";

/**
 * The MCP tools from PRD section 8, plus `create_collection`, which section 8
 * originally omitted because collections were assumed to be created in the web
 * editor. The editor is Phase 2, so without it collections cannot be used.
 *
 * Every write is attributed to the calling agent and recorded as a revision
 * (ADR-008). Write tools take an optional `change_note`, shown to the owner in
 * the review console's recent changes.
 *
 * Every tool returns compact JSON as text. Descriptions are written for Claude
 * as the reader: they say what to do when a result is thin or a call fails,
 * because that is the difference between a retry and a dead end.
 */

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function failure(value: unknown): ToolResult {
  return { ...json(value), isError: true };
}

/**
 * Turns a domain error into something Claude can act on rather than a stack
 * trace. A version conflict carries the current content so the next call can
 * merge; a validation error names every bad field at once.
 */
function toolError(error: unknown): ToolResult {
  if (error instanceof VersionConflictError) {
    return failure({
      error: "version_conflict",
      message: `${error.kind} changed since you read it. Merge your change into current_content and retry with current_version.`,
      current_version: (error.current as { version?: string } | null)?.version ?? null,
      current_content: error.current,
    });
  }
  if (error instanceof ValidationError) {
    return failure({
      error: "validation_failed",
      message: "Fix the named fields and call again.",
      fields: error.errors,
    });
  }
  if (error instanceof NotFoundError) {
    return failure({
      error: "not_found",
      message: `${error.kind} ${error.id} does not exist. Use search to find the right id.`,
    });
  }
  return failure({
    error: "internal",
    message: error instanceof Error ? error.message : String(error),
  });
}

const CHANGE_NOTE = z
  .string()
  .max(500)
  .optional()
  .describe(
    "One line saying why you made this change. Shown to the owner next to the change in their review of recent edits. Write it for them, not for yourself.",
  );

function revisionSummary(revision: Revision): Record<string, unknown> {
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
function renderDiff(diff: Diff | null, context = 2): string | null {
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

function pageSummary(page: Page): Record<string, unknown> {
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

export function registerTools(server: McpServer, context: AppContext, actor: Actor): void {
  const ws = context.workspaceId;
  const by = (note: string | undefined) => ({ actor, note: note ?? null });

  server.registerTool(
    "search",
    {
      title: "Search pages",
      description:
        "Keyword search over page content. Returns page ids, heading paths and snippets, not whole pages: read a page with get_page once you know which one you want. " +
        "Results come back in keyword mode unless embeddings are enabled, so a query that reads like a sentence will do worse than its distinctive words. " +
        "If the results look thin, try again with synonyms, related terms or a single unusual word before concluding nothing exists. " +
        "Check the `mode` field to see which path ran.",
      inputSchema: {
        query: z.string().min(1).describe("Words to search for."),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().optional().describe("From a previous truncated result."),
      },
    },
    async ({ query, limit, cursor }): Promise<ToolResult> => {
      try {
        const result = await context.search.search(ws, {
          query,
          limit: limit ?? 10,
          cursor: cursor ?? null,
        });
        const budgeted = budgetList(result.hits, (hit) =>
          `${hit.headingPath.join(" > ")}${hit.snippet}`,
        );
        return json({
          mode: result.mode,
          hits: budgeted.items.map((hit) => ({
            page_id: hit.pageId,
            heading_path: hit.headingPath,
            snippet: hit.snippet,
            score: Number(hit.score.toFixed(4)),
          })),
          truncated: result.truncated || budgeted.truncated,
          cursor: result.cursor,
          hint:
            budgeted.items.length === 0
              ? "Nothing matched. Try synonyms, a shorter query, or one distinctive word."
              : undefined,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_page",
    {
      title: "Read a page",
      description:
        "Full page content as Markdown, with its version token. Keep the version: update_page needs it. " +
        "Set include_backlinks to see which pages link here, which often surfaces context the user did not mention. " +
        "A long page is truncated, and next_offset lets you continue.",
      inputSchema: {
        page_id: z.string(),
        include_backlinks: z.boolean().optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ page_id, include_backlinks, offset }): Promise<ToolResult> => {
      try {
        const page = await context.pages.get(ws, page_id);
        const body = budgetText(page.body, DEFAULT_TOKEN_BUDGET, offset ?? 0);
        const backlinks = include_backlinks
          ? await context.pages.backlinks(ws, page_id)
          : null;

        return json({
          ...pageSummary(page),
          body: body.text,
          truncated: body.truncated,
          next_offset: body.nextOffset,
          backlinks:
            backlinks?.map((edge) => ({ page_id: edge.sourceId, type: edge.type })) ??
            undefined,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "create_page",
    {
      title: "Create a page",
      description:
        "Create a page with a Markdown body. Link to another page with [[page-id]] or [label](cairn:page-id); those links become the graph that get_backlinks and get_neighbours read. " +
        "Tags can be given in the tags list or written inline as #tag.",
      inputSchema: {
        title: z.string().min(1),
        body: z.string().default(""),
        parent_id: z.string().optional(),
        tags: z.array(z.string()).optional(),
        change_note: CHANGE_NOTE,
      },
    },
    async ({ title, body, parent_id, tags, change_note }): Promise<ToolResult> => {
      try {
        const page = await context.pages.create(
          ws,
          { title, body, parentId: parent_id ?? null, tags: tags ?? [] },
          by(change_note),
        );
        return json(pageSummary(page));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "update_page",
    {
      title: "Update a page",
      description:
        "Update a page. Requires the version from get_page, so a concurrent edit is reported instead of silently overwritten. " +
        "Every update is kept in the page's history and the owner can restore any earlier version, so edit with confidence, and say why in change_note. " +
        "Prefer mode 'append' or 'replace_section' over 'replace_body': they leave the rest of the user's page alone. " +
        "On a version_conflict, merge your change into the returned current_content and retry with current_version.",
      inputSchema: {
        page_id: z.string(),
        version: z.string().describe("From get_page. Not optional."),
        mode: z.enum(["replace_body", "append", "replace_section"]).default("append"),
        content: z.string().describe("Markdown to write."),
        section: z
          .string()
          .optional()
          .describe("Heading text, required for replace_section."),
        title: z.string().optional(),
        tags: z.array(z.string()).optional(),
        change_note: CHANGE_NOTE,
      },
    },
    async ({ page_id, version, mode, content, section, title, tags, change_note }): Promise<ToolResult> => {
      try {
        const page = await context.pages.get(ws, page_id);
        let body: string;

        if (mode === "replace_body") {
          body = content;
        } else if (mode === "append") {
          body = page.body.trimEnd() === "" ? content : `${page.body.trimEnd()}\n\n${content}`;
        } else {
          if (!section) {
            return failure({
              error: "validation_failed",
              message: "mode 'replace_section' needs the heading text in `section`.",
              fields: [{ field: "section", message: "required for replace_section" }],
            });
          }
          const replaced = replaceSection(page.body, section, content);
          if (!replaced) {
            return failure({
              error: "not_found",
              message: `no heading matching "${section}" on this page. Read it with get_page, or append instead.`,
            });
          }
          body = replaced;
        }

        const updated = await context.pages.update(
          ws,
          page_id,
          {
            title: title ?? page.title,
            body,
            parentId: page.parentId,
            tags: tags ?? page.tags,
          },
          version,
          by(change_note),
        );
        return json(pageSummary(updated));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_backlinks",
    {
      title: "Pages linking here",
      description:
        "Pages that link to, mention or parent this page. Useful for finding context the user did not name. Updated within a few seconds of a write, not instantly.",
      inputSchema: { page_id: z.string() },
    },
    async ({ page_id }): Promise<ToolResult> => {
      try {
        const edges = await context.pages.backlinks(ws, page_id);
        return json({
          backlinks: edges.map((edge) => ({
            page_id: edge.sourceId,
            type: edge.type,
            label: edge.label,
          })),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_neighbours",
    {
      title: "One hop around a page",
      description:
        "Everything one hop from this page, in both directions: links, mentions, parent and tags. Call it repeatedly to walk further; the server does not expand the graph for you.",
      inputSchema: { page_id: z.string() },
    },
    async ({ page_id }): Promise<ToolResult> => {
      try {
        const { outbound, inbound } = await context.pages.neighbours(ws, page_id);
        return json({
          outbound: outbound.map((e) => ({ page_id: e.targetId, type: e.type, label: e.label })),
          inbound: inbound.map((e) => ({ page_id: e.sourceId, type: e.type, label: e.label })),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_collections",
    {
      title: "List collections",
      description:
        "Collections with their field schemas. Read this before query_collection or upsert_row so you use the right field names and types.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      try {
        const collections = await context.collections.list(ws);
        return json({
          collections: collections.map((collection) => ({
            id: collection.id,
            name: collection.name,
            version: collection.version,
            fields: collection.fields,
          })),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "create_collection",
    {
      title: "Create a collection",
      description:
        "Create a collection with a typed schema. Field types: text, number, date, select, multi_select, checkbox, url, relation. " +
        "select and multi_select need an options list. Mark a field required only when a row is meaningless without it.",
      inputSchema: {
        name: z.string().min(1),
        fields: z
          .array(
            z.object({
              name: z.string().min(1),
              type: z.enum([
                "text",
                "number",
                "date",
                "select",
                "multi_select",
                "checkbox",
                "url",
                "relation",
              ]),
              required: z.boolean().optional(),
              options: z.array(z.string()).optional(),
            }),
          )
          .min(1),
      },
    },
    async ({ name, fields }): Promise<ToolResult> => {
      try {
        // Drop the keys the caller left out rather than passing explicit
        // undefined, which the domain types do not accept.
        const collection = await context.collections.create(
          ws,
          {
            name,
            fields: fields.map((field) => ({
              name: field.name,
              type: field.type,
              ...(field.required === undefined ? {} : { required: field.required }),
              ...(field.options === undefined ? {} : { options: field.options }),
            })),
          },
          by(undefined),
        );
        return json({ id: collection.id, name: collection.name, version: collection.version });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "query_collection",
    {
      title: "Query collection rows",
      description:
        "Filter and sort rows. Operators: eq, ne, lt, lte, gt, gte, contains, in, exists. " +
        "contains is a substring match on text and a membership test on multi_select. Conditions combine with AND. " +
        "Field names come from list_collections.",
      inputSchema: {
        collection_id: z.string(),
        where: z
          .array(
            z.object({
              field: z.string(),
              op: z.enum([
                "eq",
                "ne",
                "lt",
                "lte",
                "gt",
                "gte",
                "contains",
                "in",
                "exists",
              ]),
              value: z.unknown().optional(),
            }),
          )
          .optional(),
        sort: z
          .array(
            z.object({
              field: z.string(),
              direction: z.enum(["asc", "desc"]).default("asc"),
            }),
          )
          .optional(),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional(),
      },
    },
    async ({ collection_id, where, sort, limit, cursor }): Promise<ToolResult> => {
      try {
        const result = await context.collections.queryRows(ws, collection_id, {
          where: where as never,
          sort: sort as never,
          limit: limit ?? 25,
          cursor: cursor ?? null,
        });
        const budgeted = budgetList(result.items, (row) => JSON.stringify(row.values));
        return json({
          rows: budgeted.items.map((row) => ({
            id: row.id,
            values: row.values,
            version: row.version,
          })),
          truncated: budgeted.truncated || result.cursor !== null,
          cursor: result.cursor,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "upsert_row",
    {
      title: "Create or update a row",
      description:
        "Create a row, or update one by passing row_id and its version. Validation reports every bad field at once, so one retry can fix them all. " +
        "Dates are ISO 8601 strings, multi_select takes a list of option names.",
      inputSchema: {
        collection_id: z.string(),
        values: z.record(z.string(), z.unknown()),
        row_id: z.string().optional(),
        version: z
          .string()
          .optional()
          .describe("Required when updating an existing row."),
        change_note: CHANGE_NOTE,
      },
    },
    async ({ collection_id, values, row_id, version, change_note }): Promise<ToolResult> => {
      try {
        const row = await context.collections.upsertRow(
          ws,
          collection_id,
          { values: values as never },
          by(change_note),
          {
            ...(row_id ? { id: row_id } : {}),
            ...(version !== undefined ? { expectedVersion: version } : {}),
          },
        );
        return json({ id: row.id, values: row.values, version: row.version });
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    "get_history",
    {
      title: "History of a page or row",
      description:
        "Earlier versions of a page, or of a row when collection_id is given, newest first, with who made each change, when, and why. " +
        "Use it to see what changed recently before editing, or to find a version to compare with get_revision. The owner sees the same history.",
      inputSchema: {
        page_id: z.string().optional().describe("For a page's history."),
        collection_id: z.string().optional().describe("With row_id, for a row's history."),
        row_id: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ page_id, collection_id, row_id, limit }): Promise<ToolResult> => {
      try {
        let revisions: Revision[];
        if (page_id) {
          revisions = await context.pages.history(ws, page_id, { limit: limit ?? 10 });
        } else if (collection_id && row_id) {
          revisions = await context.collections.rowHistory(ws, collection_id, row_id, {
            limit: limit ?? 10,
          });
        } else {
          return failure({
            error: "validation_failed",
            message: "Pass page_id, or collection_id with row_id.",
            fields: [{ field: "page_id", message: "or collection_id and row_id" }],
          });
        }
        return json({
          revisions: revisions.map(revisionSummary),
          hint:
            revisions.length === 0
              ? "No history recorded. The record may predate history, or the id may be wrong."
              : undefined,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_revision",
    {
      title: "One earlier version",
      description:
        "The content of one version from get_history, and what changed compared with the version before it, as a diff with + and - lines. " +
        "To undo a change, read the version you want back and write it with update_page mode 'replace_body'.",
      inputSchema: {
        version: z.string(),
        page_id: z.string().optional(),
        collection_id: z.string().optional(),
        row_id: z.string().optional(),
      },
    },
    async ({ version, page_id, collection_id, row_id }): Promise<ToolResult> => {
      try {
        if (page_id) {
          const view = await context.pages.revision(ws, page_id, version);
          const body = budgetText(view.snapshot.body);
          return json({
            ...revisionSummary(view.revision),
            title: view.snapshot.title,
            tags: view.snapshot.tags,
            body: body.text,
            truncated: body.truncated,
            title_changed: view.titleChanged || undefined,
            tags_changed: view.tagsChanged || undefined,
            diff: renderDiff(view.diff),
          });
        }
        if (collection_id && row_id) {
          const view = await context.collections.rowRevision(ws, collection_id, row_id, version);
          return json({
            ...revisionSummary(view.revision),
            values: view.snapshot.values,
            diff: renderDiff(view.diff),
          });
        }
        return failure({
          error: "validation_failed",
          message: "Pass page_id, or collection_id with row_id.",
          fields: [{ field: "page_id", message: "or collection_id and row_id" }],
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

/**
 * Replace the body under a Markdown heading, leaving the rest of the page
 * untouched. This is the Markdown equivalent of PRD user story 5: update one
 * block without overwriting the user's edits elsewhere.
 */
export function replaceSection(
  body: string,
  heading: string,
  content: string,
): string | null {
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

  return [
    ...lines.slice(0, start + 1),
    "",
    content.trim(),
    "",
    ...lines.slice(end),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
