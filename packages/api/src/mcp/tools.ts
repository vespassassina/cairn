import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Actor, Revision } from "@cairn/core";
import { budgetList, budgetText, DEFAULT_TOKEN_BUDGET } from "../budget.js";
import type { AppContext } from "../context.js";
import {
  tableJson,
  describeError,
  editPage,
  EDIT_MODES,
  linkJson,
  moveRecord,
  pageSummary,
  renderDiff,
  revisionSummary,
  rowJson,
  toFieldDefs,
} from "../operations.js";

export { replaceSection } from "../operations.js";

/**
 * The MCP tools from PRD section 8, plus `create_table`, which section 8
 * originally omitted because tables were assumed to be created in the web
 * editor. The editor is Phase 2, so without it tables cannot be used.
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

/** A domain error, worded for an MCP client (the mapping is shared, ADR-013). */
function toolError(error: unknown): ToolResult {
  return failure(
    describeError(error, {
      conflict: "Merge your change into current_content and retry with current_version.",
      notFound: (kind, id) => `${kind} ${id} does not exist. Use search to find the right id.`,
      validation: "Fix the named fields and call again.",
    }).body,
  );
}

const CHANGE_NOTE = z
  .string()
  .max(500)
  .optional()
  .describe(
    "One line saying why you made this change. Shown to the owner next to the change in their review of recent edits. Write it for them, not for yourself.",
  );

export function registerTools(server: McpServer, context: AppContext, actor: Actor): void {
  const ws = context.workspaceId;
  const by = (note: string | undefined) => ({ actor, note: note ?? null });

  server.registerTool(
    "search",
    {
      title: "Search pages",
      description:
        "Search page content by keyword and, when `mode` is hybrid, by meaning for English text. Returns page ids, heading paths and snippets, not whole pages: read a page with get_page once you know which one you want. " +
        "A keyword match needs most of your words on the page, in any form (tendon, tendons); filler words are ignored. A match by meaning needs none of them. " +
        "No results means nothing close: try other words, or a single unusual one, before concluding nothing exists.",
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
        mode: z.enum(EDIT_MODES).default("append"),
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
        const updated = await editPage(
          context,
          page_id,
          version,
          { mode, content, section, title, tags },
          by(change_note),
        );
        return json(pageSummary(updated));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  const tableIds = async () => new Set((await context.tables.list(ws)).map((table) => table.id));
  const WHICH = {
    page_id: z.string().optional(),
    table_id: z.string().optional().describe("With row_id, a row."),
    row_id: z.string().optional(),
  };
  const needOne = () =>
    failure({
      error: "validation_failed",
      message: "Pass page_id, or table_id, or table_id with row_id.",
      fields: [{ field: "page_id", message: "or table_id, with row_id for a row" }],
    });

  server.registerTool(
    "get_backlinks",
    {
      title: "What links here",
      description:
        "Pages and rows linking to, mentioning or parenting a page, table or row. Useful for context the user did not name. Updated within seconds of a write.",
      inputSchema: WHICH,
    },
    async ({ page_id, table_id, row_id }): Promise<ToolResult> => {
      try {
        const edges = page_id
          ? await context.pages.backlinks(ws, page_id)
          : table_id && row_id
            ? await context.tables.rowBacklinks(ws, table_id, row_id)
            : table_id
              ? await context.tables.backlinks(ws, table_id)
              : null;
        if (edges === null) return needOne();
        const ids = await tableIds();
        return json({ backlinks: edges.map((edge) => linkJson(edge, "source", ids)) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_neighbours",
    {
      title: "One hop around a page or row",
      description:
        "Everything one hop from a page or row, both directions: links, mentions, parent, tags, relations. Call it again to walk further.",
      inputSchema: { page_id: WHICH.page_id, table_id: WHICH.table_id, row_id: WHICH.row_id },
    },
    async ({ page_id, table_id, row_id }): Promise<ToolResult> => {
      try {
        let outbound, inbound;
        if (page_id) ({ outbound, inbound } = await context.pages.neighbours(ws, page_id));
        else if (table_id && row_id) {
          [outbound, inbound] = await Promise.all([
            context.tables.rowLinks(ws, table_id, row_id),
            context.tables.rowBacklinks(ws, table_id, row_id),
          ]);
        } else return needOne();
        const ids = await tableIds();
        return json({
          outbound: outbound.map((e) => linkJson(e, "target", ids)),
          inbound: inbound.map((e) => linkJson(e, "source", ids)),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "move",
    {
      title: "Move a page or table",
      description:
        "Put a page or table under a page, or at the top with parent_id null. Only its place changes. Needs its current version.",
      inputSchema: {
        id: z.string(),
        parent_id: z.string().nullable(),
        version: z.string(),
        change_note: CHANGE_NOTE,
      },
    },
    async ({ id, parent_id, version, change_note }): Promise<ToolResult> => {
      try {
        return json(await moveRecord(context, id, parent_id, version, by(change_note)));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description:
        "Tables with their field schemas. Read this before query_table or upsert_row so you use the right field names and types.",
      inputSchema: {},
    },
    async (): Promise<ToolResult> => {
      try {
        const tables = await context.tables.list(ws);
        return json({ tables: tables.map(tableJson) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "create_table",
    {
      title: "Create a table",
      description:
        "Create a table with a typed schema. Field types: text, number, date, select, multi_select, checkbox, url, relation. " +
        "select and multi_select need an options list. A relation links to pages, or to a table's rows with target (its own id allowed); multiple holds a list. " +
        "Mark a field required only when a row is meaningless without it. parent_id: the page it sits under.",
      inputSchema: {
        name: z.string().min(1),
        parent_id: z.string().optional(),
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
              target: z.string().optional(),
              multiple: z.boolean().optional(),
            }),
          )
          .min(1),
      },
    },
    async ({ name, fields, parent_id }): Promise<ToolResult> => {
      try {
        const table = await context.tables.create(
          ws,
          { name, fields: toFieldDefs(fields), parentId: parent_id ?? null },
          by(undefined),
        );
        return json({ id: table.id, name: table.name, version: table.version });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "query_table",
    {
      title: "Query table rows",
      description:
        "Filter and sort rows. Operators: eq, ne, lt, lte, gt, gte, contains, in, exists. " +
        "contains is a substring match on text and a membership test on multi_select. Conditions combine with AND. " +
        "Field names come from list_tables.",
      inputSchema: {
        table_id: z.string(),
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
    async ({ table_id, where, sort, limit, cursor }): Promise<ToolResult> => {
      try {
        const result = await context.tables.queryRows(ws, table_id, {
          where: where as never,
          sort: sort as never,
          limit: limit ?? 25,
          cursor: cursor ?? null,
        });
        const budgeted = budgetList(result.items, (row) => JSON.stringify(row.values));
        return json({
          rows: budgeted.items.map(rowJson),
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
        "Dates are ISO 8601 strings, multi_select takes a list of option names, and a relation takes an id, or a list of ids when the field is multiple.",
      inputSchema: {
        table_id: z.string(),
        values: z.record(z.string(), z.unknown()),
        row_id: z.string().optional(),
        version: z
          .string()
          .optional()
          .describe("Required when updating an existing row."),
        change_note: CHANGE_NOTE,
      },
    },
    async ({ table_id, values, row_id, version, change_note }): Promise<ToolResult> => {
      try {
        const row = await context.tables.upsertRow(
          ws,
          table_id,
          { values: values as never },
          by(change_note),
          {
            ...(row_id ? { id: row_id } : {}),
            ...(version !== undefined ? { expectedVersion: version } : {}),
          },
        );
        return json(rowJson(row));
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
        "Earlier versions of a page, or of a row when table_id is given, newest first, with who made each change, when, and why. " +
        "Use it to see what changed recently before editing, or to find a version to compare with get_revision. The owner sees the same history.",
      inputSchema: {
        page_id: z.string().optional().describe("For a page's history."),
        table_id: z.string().optional().describe("With row_id, for a row's history."),
        row_id: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ page_id, table_id, row_id, limit }): Promise<ToolResult> => {
      try {
        let revisions: Revision[];
        if (page_id) {
          revisions = await context.pages.history(ws, page_id, { limit: limit ?? 10 });
        } else if (table_id && row_id) {
          revisions = await context.tables.rowHistory(ws, table_id, row_id, {
            limit: limit ?? 10,
          });
        } else {
          return failure({
            error: "validation_failed",
            message: "Pass page_id, or table_id with row_id.",
            fields: [{ field: "page_id", message: "or table_id and row_id" }],
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
        table_id: z.string().optional(),
        row_id: z.string().optional(),
      },
    },
    async ({ version, page_id, table_id, row_id }): Promise<ToolResult> => {
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
        if (table_id && row_id) {
          const view = await context.tables.rowRevision(ws, table_id, row_id, version);
          return json({
            ...revisionSummary(view.revision),
            values: view.snapshot.values,
            diff: renderDiff(view.diff),
          });
        }
        return failure({
          error: "validation_failed",
          message: "Pass page_id, or table_id with row_id.",
          fields: [{ field: "page_id", message: "or table_id and row_id" }],
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
