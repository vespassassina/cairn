import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Actor, Revision } from "@cairn/core";
import { budgetList, budgetText, DEFAULT_TOKEN_BUDGET } from "../budget.js";
import type { AppContext } from "../context.js";
import {
  tableJson,
  childSummaryJson,
  childrenPreview,
  deletePage,
  describeError,
  editPage,
  EDIT_MODES,
  linkJson,
  listChanges,
  listChildren,
  moveRecord,
  pageSummary,
  renderDiff,
  revisionDetail,
  revisionSummary,
  rowJson,
  sourceChangesJson,
  verifiedTimes,
  toFieldDefs,
  writeRow,
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

// Lengths and counts are checked in core (ADR-027), so the schema every
// session loads stays short.
const SOURCES = z
  .array(z.string())
  .optional()
  .describe(
    "Where this came from: URLs or short citations (\"Smith 2021, J Pept Sci\"). Added to the record's list.",
  );

const VERIFIED = z
  .boolean()
  .optional()
  .describe("true if you re-checked the page's facts and they still hold. Works with empty content in append mode.");

// Required, unlike CHANGE_NOTE: a table has no write history to fall back on
// (ADR-058), so this is the only record of why it exists.
const REQUIRED_CHANGE_NOTE = z
  .string()
  .max(500)
  .describe(
    "One line saying why you're creating this table. Shown to the owner next to the change in their review of recent edits. Write it for them, not for yourself.",
  );

const FIELDS = z
  .array(
    z.object({
      name: z.string().min(1),
      type: z.enum(["text", "number", "date", "select", "multi_select", "checkbox", "url", "relation"]),
      required: z.boolean().optional(),
      options: z.array(z.string()).optional(),
      target: z.string().optional(),
      multiple: z.boolean().optional(),
    }),
  )
  .min(1);

const TABLE_DESCRIPTION = z
  .string()
  .max(280)
  .nullable()
  .optional()
  .describe("One short line, shown in list_tables, the console and the workspace summary.");

export function registerTools(server: McpServer, context: AppContext, actor: Actor): void {
  const ws = context.workspaceId;
  const by = (note: string | undefined) => ({ actor, note: note ?? null });

  server.registerTool(
    "search",
    {
      title: "Search pages",
      description:
        "Search page content by keyword, and by meaning for English text when embeddings are enabled. The result's `mode` field says which one answered: `hybrid` (keyword and meaning) or `keyword` (meaning unavailable); it is not a setting you choose. Returns page ids, heading paths and snippets, not whole pages: read a page with get_page once you know which one you want. " +
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
        const verified = await verifiedTimes(context, budgeted.items.map((hit) => hit.pageId));
        return json({
          mode: result.mode,
          hits: budgeted.items.map((hit) => ({
            page_id: hit.pageId,
            heading_path: hit.headingPath,
            snippet: hit.snippet,
            score: Number(hit.score.toFixed(4)),
            // Only when set, so a wiki nobody has verified costs nothing more.
            verified_at: verified.get(hit.pageId) ?? undefined,
          })),
          truncated: result.truncated || budgeted.truncated,
          cursor: result.cursor,
          hint:
            budgeted.items.length === 0
              ? `Nothing matched "${query}". Try synonyms, a shorter query, or one distinctive word.`
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
        "A long page is truncated, and next_offset lets you continue. " +
        "Lists up to 8 immediate children with more_children for the rest; call list_children to walk further or see more of them.",
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
        const children = await childrenPreview(context, page_id);

        return json({
          ...pageSummary(page),
          body: body.text,
          truncated: body.truncated,
          next_offset: body.nextOffset,
          backlinks:
            backlinks?.map((edge) => ({ page_id: edge.sourceId, type: edge.type })) ??
            undefined,
          children: children.items.length > 0 ? children.items.map(childSummaryJson) : undefined,
          more_children: children.more > 0 ? children.more : undefined,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "list_children",
    {
      title: "List a page's children",
      description:
        "Immediate children of a page, in title order, each with whether it has children of its own. " +
        "Omit page_id for the top-level pages, the same set cairn collections shows. Call again with cursor to see the rest.",
      inputSchema: {
        page_id: z.string().optional().describe("Omit for the top-level pages."),
        cursor: z.string().optional().describe("From a previous truncated result."),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ page_id, cursor, limit }): Promise<ToolResult> => {
      try {
        const result = await listChildren(context, {
          parentId: page_id ?? null,
          cursor: cursor ?? null,
          ...(limit === undefined ? {} : { limit }),
        });
        return json({
          children: result.items.map(childSummaryJson),
          cursor: result.cursor,
          hint:
            result.items.length === 0
              ? "No children. This page has no pages beneath it, or is itself a leaf."
              : undefined,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "delete_page",
    {
      title: "Delete a page",
      description:
        "Delete a page. Refused when it still has children, naming how many: move or delete them first, or move this page itself instead of deleting it. " +
        "Its history is kept either way; get_revision still reaches whatever it held before you deleted it. Needs its current version, from get_page.",
      inputSchema: {
        page_id: z.string(),
        version: z.string().describe("From get_page. Not optional."),
        change_note: CHANGE_NOTE,
      },
    },
    async ({ page_id, version, change_note }): Promise<ToolResult> => {
      try {
        await deletePage(context, page_id, version, by(change_note));
        return json({ deleted: page_id });
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
        "Create a page with a Markdown body. Link to another page with [[page-id]] or [label](cairn:page-id); those links become the graph that get_backlinks and get_neighbours read. A Markdown link to another Cairn's published page (its address ends /w/id) becomes a cairn_link edge the same way. " +
        "Tags can be given in the tags list or written inline as #tag.",
      inputSchema: {
        title: z.string().min(1),
        body: z.string().default(""),
        parent_id: z.string().optional(),
        tags: z.array(z.string()).optional(),
        sources: SOURCES,
        change_note: CHANGE_NOTE,
      },
    },
    async ({ title, body, parent_id, tags, sources, change_note }): Promise<ToolResult> => {
      try {
        const page = await context.pages.create(
          ws,
          { title, body, parentId: parent_id ?? null, tags: tags ?? [], sources: sources ?? [] },
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
        sources: SOURCES,
        verified: VERIFIED,
        change_note: CHANGE_NOTE,
      },
    },
    async ({ page_id, version, mode, content, section, title, tags, sources, verified, change_note }): Promise<ToolResult> => {
      try {
        const updated = await editPage(
          context,
          page_id,
          version,
          { mode, content, section, title, tags, sources, verified },
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
        "Mark a field required only when a row is meaningless without it. parent_id: the page it sits under. change_note is required: say why this table exists.",
      inputSchema: {
        name: z.string().min(1),
        parent_id: z.string().optional(),
        description: TABLE_DESCRIPTION,
        fields: FIELDS,
        change_note: REQUIRED_CHANGE_NOTE,
      },
    },
    async ({ name, fields, parent_id, description, change_note }): Promise<ToolResult> => {
      try {
        const table = await context.tables.create(
          ws,
          { name, fields: toFieldDefs(fields), parentId: parent_id ?? null, description: description ?? null },
          by(change_note),
        );
        return json(tableJson(table));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "update_table",
    {
      title: "Change a table's schema",
      description:
        "Rename a table, change its fields, move it, or change its description. Existing rows keep their values; a field you drop stays on rows that still hold it but is no longer queryable. " +
        "Needs its current version, from list_tables.",
      inputSchema: {
        table_id: z.string(),
        version: z.string().describe("From list_tables. Not optional."),
        name: z.string().min(1),
        fields: FIELDS,
        parent_id: z.string().nullable().optional().describe("Omit to leave it where it is."),
        description: TABLE_DESCRIPTION,
        change_note: CHANGE_NOTE,
      },
    },
    async ({ table_id, version, name, fields, parent_id, description, change_note }): Promise<ToolResult> => {
      try {
        const table = await context.tables.update(
          ws,
          table_id,
          {
            name,
            fields: toFieldDefs(fields),
            ...(parent_id === undefined ? {} : { parentId: parent_id }),
            ...(description === undefined ? {} : { description }),
          },
          version,
          by(change_note),
        );
        return json(tableJson(table));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "get_changes",
    {
      title: "Recent changes across the workspace",
      description:
        "Revisions newest first: what changed, who changed it, and when. Pass since with an earlier call's newest to see only what's new. Call again with cursor to go further back.",
      inputSchema: {
        since: z.string().optional().describe("An ISO 8601 time, such as a previous call's newest."),
        actor_kind: z.enum(["user", "agent"]).optional().describe("Only changes made by a person, or only by an agent."),
        cursor: z.string().optional().describe("From a previous call, to go further back."),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ since, actor_kind, cursor, limit }): Promise<ToolResult> => {
      try {
        const result = await listChanges(context, {
          ...(since === undefined ? {} : { since }),
          ...(actor_kind === undefined ? {} : { actorKind: actor_kind }),
          cursor: cursor ?? null,
          ...(limit === undefined ? {} : { limit }),
        });
        return json({
          changes: result.changes.map(revisionDetail),
          newest: result.newest,
          cursor: result.cursor,
        });
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
        const budgeted = budgetList(result.items, (row) => JSON.stringify([row.values, row.sources]));
        return json({
          // An empty sources list is left out, to spend no tokens on it.
          rows: budgeted.items.map((row) => {
            const { sources, ...rest } = rowJson(row);
            return (sources as string[]).length > 0 ? { ...rest, sources } : rest;
          }),
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
        sources: SOURCES,
        change_note: CHANGE_NOTE,
      },
    },
    async ({ table_id, values, row_id, version, sources, change_note }): Promise<ToolResult> => {
      try {
        const row = await writeRow(
          context,
          table_id,
          values,
          sources,
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
            sources: view.snapshot.sources,
            verified_at: view.snapshot.verifiedAt,
            body: body.text,
            truncated: body.truncated,
            title_changed: view.titleChanged || undefined,
            tags_changed: view.tagsChanged || undefined,
            ...sourceChangesJson(view),
            verified: view.verified || undefined,
            diff: renderDiff(view.diff),
          });
        }
        if (table_id && row_id) {
          const view = await context.tables.rowRevision(ws, table_id, row_id, version);
          return json({
            ...revisionSummary(view.revision),
            values: view.snapshot.values,
            sources: view.snapshot.sources,
            ...sourceChangesJson(view),
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
