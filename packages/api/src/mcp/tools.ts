import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  NotFoundError,
  ValidationError,
  VersionConflictError,
  type Page,
} from "@cairn/core";
import { budgetList, budgetText, DEFAULT_TOKEN_BUDGET } from "../budget.js";
import type { AppContext } from "../context.js";

/**
 * The MCP tools from PRD section 8, plus `create_collection`, which section 8
 * omits because collections were assumed to be created in the web editor. The
 * editor is Phase 2, so without it collections cannot be tested at all.
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

function pageSummary(page: Page): Record<string, unknown> {
  return {
    id: page.id,
    title: page.title,
    parent_id: page.parentId,
    tags: page.tags,
    updated_at: page.updatedAt,
    version: page.version,
  };
}

export function registerTools(server: McpServer, context: AppContext): void {
  const ws = context.workspaceId;

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
      },
    },
    async ({ title, body, parent_id, tags }): Promise<ToolResult> => {
      try {
        const page = await context.pages.create(ws, {
          title,
          body,
          parentId: parent_id ?? null,
          tags: tags ?? [],
        });
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
      },
    },
    async ({ page_id, version, mode, content, section, title, tags }): Promise<ToolResult> => {
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
        const collection = await context.collections.create(ws, {
          name,
          fields: fields.map((field) => ({
            name: field.name,
            type: field.type,
            ...(field.required === undefined ? {} : { required: field.required }),
            ...(field.options === undefined ? {} : { options: field.options }),
          })),
        });
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
      },
    },
    async ({ collection_id, values, row_id, version }): Promise<ToolResult> => {
      try {
        const row = await context.collections.upsertRow(
          ws,
          collection_id,
          { values: values as never },
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
