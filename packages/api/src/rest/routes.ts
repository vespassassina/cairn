import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Actor, Page, Paged, Revision } from "@cairn/core";
import type { AppContext } from "../context.js";
import {
  describeError,
  editPage,
  EDIT_MODES,
  pageSummary,
  renderDiff,
  revisionSummary,
  rowJson,
} from "../operations.js";
import { workspaceSummary } from "../mcp/summary.js";

/**
 * The REST API at /api/v1 (ADR-013).
 *
 * Same core, same attribution and same error codes as the MCP tools; only the
 * translation differs. Version tokens travel as ETag and If-Match. Auth is
 * applied by the app before these routes run.
 */

type ActorFor = (request: Request) => Actor;

const MAX_LIMIT = 200;

/** Characters for /overview. Larger than the initialize budget, still bounded. */
const OVERVIEW_BUDGET = 4_000;

const CHANGE_NOTE = z.string().max(500).optional();

const FIELD_TYPES = [
  "text",
  "number",
  "date",
  "select",
  "multi_select",
  "checkbox",
  "url",
  "relation",
] as const;

const OPERATORS = ["eq", "ne", "lt", "lte", "gt", "gte", "contains", "in", "exists"] as const;

const schemas = {
  createPage: z.object({
    title: z.string().min(1),
    body: z.string().default(""),
    parent_id: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    change_note: CHANGE_NOTE,
  }),
  editPage: z.object({
    mode: z.enum(EDIT_MODES).default("append"),
    content: z.string(),
    section: z.string().optional(),
    title: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    change_note: CHANGE_NOTE,
  }),
  deleteBody: z.object({ change_note: CHANGE_NOTE }).default({}),
  createCollection: z.object({
    name: z.string().min(1),
    fields: z
      .array(
        z.object({
          name: z.string().min(1),
          type: z.enum(FIELD_TYPES),
          required: z.boolean().optional(),
          options: z.array(z.string()).optional(),
        }),
      )
      .min(1),
  }),
  row: z.object({
    values: z.record(z.string(), z.unknown()),
    change_note: CHANGE_NOTE,
  }),
  query: z.object({
    where: z
      .array(z.object({ field: z.string(), op: z.enum(OPERATORS), value: z.unknown().optional() }))
      .optional(),
    sort: z
      .array(z.object({ field: z.string(), direction: z.enum(["asc", "desc"]).default("asc") }))
      .optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    cursor: z.string().nullable().optional(),
  }),
};

/** Input that does not parse, before any domain rule runs. */
class BadRequest extends Error {
  constructor(
    message: string,
    readonly fields: Array<{ field: string; message: string }> = [],
  ) {
    super(message);
  }
}

/** A write to an existing record that did not say which version it read. */
class PreconditionRequired extends Error {}

const WORDING = {
  conflict: "Read it again, merge your change, and retry with the new ETag in If-Match.",
  notFound: (kind: string, id: string) => `${kind} ${id} does not exist. Search to find the right id.`,
  validation: "Fix the named fields and send the request again.",
};

function fail(c: Context, error: unknown): Response {
  if (error instanceof BadRequest) {
    return c.json({ error: "bad_request", message: error.message, fields: error.fields }, 400);
  }
  if (error instanceof PreconditionRequired) {
    return c.json(
      {
        error: "precondition_required",
        message: "Send the version you read as If-Match, so a concurrent change is not overwritten.",
      },
      428,
    );
  }
  const described = describeError(error, WORDING);
  return c.json(described.body, described.status);
}

async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text.trim() !== "") {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new BadRequest("The body is not valid JSON.");
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequest(
      "The body does not match what this endpoint takes.",
      parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "(body)",
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

function limitParam(c: Context, fallback: number): number {
  const raw = c.req.query("limit");
  if (raw === undefined) return fallback;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new BadRequest(`limit must be a whole number from 1 to ${MAX_LIMIT}.`, [
      { field: "limit", message: "out of range" },
    ]);
  }
  return limit;
}

/** ETags are quoted version tokens. */
function etag(version: string): string {
  return `"${version}"`;
}

/** The version in If-Match, or null when the header is absent. */
function ifMatch(c: Context): string | null {
  const header = c.req.header("if-match");
  if (header === undefined || header.trim() === "") return null;
  const value = header.trim().replace(/^W\//, "");
  if (value === "*") {
    throw new BadRequest("If-Match must name a version. A wildcard would skip the concurrency check.");
  }
  return value.replace(/^"(.*)"$/, "$1");
}

function requireIfMatch(c: Context): string {
  const version = ifMatch(c);
  if (version === null) throw new PreconditionRequired();
  return version;
}

function revisionDetail(revision: Revision): Record<string, unknown> {
  const base = {
    kind: revision.kind,
    ...revisionSummary(revision),
  };
  if (revision.kind === "page") {
    const snapshot = revision.snapshot as { title: string };
    return { ...base, page_id: revision.recordId, title: snapshot.title };
  }
  const rowId = revision.recordId.slice((revision.collectionId ?? "").length + 1);
  return { ...base, collection_id: revision.collectionId, row_id: rowId };
}

/** The page as Markdown with a small header, the cheapest read for an agent. */
function pageMarkdown(page: Page): string {
  return [
    "---",
    `id: ${page.id}`,
    `title: ${JSON.stringify(page.title)}`,
    `version: ${page.version}`,
    `tags: ${JSON.stringify(page.tags)}`,
    `updated: ${page.updatedAt} by ${page.updatedBy.kind} ${JSON.stringify(page.updatedBy.label)}`,
    "---",
    "",
    page.body,
  ].join("\n");
}

export function restRoutes(context: AppContext, actorFor: ActorFor): Hono {
  const api = new Hono();
  const ws = context.workspaceId;
  const by = (c: Context, note: string | undefined) => ({
    actor: actorFor(c.req.raw),
    note: note ?? null,
  });

  api.onError((error, c) => fail(c, error));

  // What the workspace holds: the summary MCP clients get at initialize
  // (ADR-012), with more room, since only a caller who asks pays for it.

  api.get("/overview", async (c) => {
    return c.json({ text: await workspaceSummary(context, OVERVIEW_BUDGET) });
  });

  // Search.

  api.get("/search", async (c) => {
    const query = c.req.query("q")?.trim();
    if (!query) throw new BadRequest("Pass the words to search for as q.", [{ field: "q", message: "required" }]);
    const result = await context.search.search(ws, {
      query,
      limit: limitParam(c, 10),
      cursor: c.req.query("cursor") ?? null,
    });
    return c.json({
      mode: result.mode,
      hits: result.hits.map((hit) => ({
        page_id: hit.pageId,
        heading_path: hit.headingPath,
        snippet: hit.snippet,
        score: Number(hit.score.toFixed(4)),
      })),
      truncated: result.truncated,
      cursor: result.cursor,
    });
  });

  // Pages.

  api.get("/pages", async (c) => {
    const parent = c.req.query("parent");
    const page: Paged<Page> = await context.store.listPages(ws, {
      ...(parent === undefined ? {} : { parentId: parent === "root" ? null : parent }),
      limit: limitParam(c, 50),
      cursor: c.req.query("cursor") ?? null,
    });
    return c.json({ pages: page.items.map(pageSummary), cursor: page.cursor });
  });

  api.post("/pages", async (c) => {
    const input = await parseBody(c, schemas.createPage);
    const page = await context.pages.create(
      ws,
      { title: input.title, body: input.body, parentId: input.parent_id ?? null, tags: input.tags ?? [] },
      by(c, input.change_note),
    );
    c.header("ETag", etag(page.version));
    c.header("Location", `/api/v1/pages/${encodeURIComponent(page.id)}`);
    return c.json(pageSummary(page), 201);
  });

  api.get("/pages/:id", async (c) => {
    const page = await context.pages.get(ws, c.req.param("id"));
    c.header("ETag", etag(page.version));
    if (c.req.query("format") === "markdown") {
      return c.body(pageMarkdown(page), 200, { "content-type": "text/markdown; charset=utf-8" });
    }
    return c.json({ ...pageSummary(page), body: page.body });
  });

  api.patch("/pages/:id", async (c) => {
    const version = requireIfMatch(c);
    const input = await parseBody(c, schemas.editPage);
    const page = await editPage(
      context,
      c.req.param("id"),
      version,
      { mode: input.mode, content: input.content, section: input.section, title: input.title, tags: input.tags },
      by(c, input.change_note),
    );
    c.header("ETag", etag(page.version));
    return c.json(pageSummary(page));
  });

  api.delete("/pages/:id", async (c) => {
    const version = requireIfMatch(c);
    const input = await parseBody(c, schemas.deleteBody);
    await context.pages.delete(ws, c.req.param("id"), version, by(c, input.change_note));
    return c.body(null, 204);
  });

  api.get("/pages/:id/backlinks", async (c) => {
    const edges = await context.pages.backlinks(ws, c.req.param("id"));
    return c.json({
      backlinks: edges.map((edge) => ({ page_id: edge.sourceId, type: edge.type, label: edge.label })),
    });
  });

  api.get("/pages/:id/neighbours", async (c) => {
    const { outbound, inbound } = await context.pages.neighbours(ws, c.req.param("id"));
    return c.json({
      outbound: outbound.map((e) => ({ page_id: e.targetId, type: e.type, label: e.label })),
      inbound: inbound.map((e) => ({ page_id: e.sourceId, type: e.type, label: e.label })),
    });
  });

  api.get("/pages/:id/history", async (c) => {
    const revisions = await context.pages.history(ws, c.req.param("id"), { limit: limitParam(c, 20) });
    return c.json({ revisions: revisions.map(revisionSummary) });
  });

  api.get("/pages/:id/revisions/:version", async (c) => {
    const view = await context.pages.revision(ws, c.req.param("id"), c.req.param("version"));
    return c.json({
      ...revisionSummary(view.revision),
      title: view.snapshot.title,
      tags: view.snapshot.tags,
      body: view.snapshot.body,
      title_changed: view.titleChanged || undefined,
      tags_changed: view.tagsChanged || undefined,
      diff: renderDiff(view.diff),
    });
  });

  // Collections and rows.

  api.get("/collections", async (c) => {
    const collections = await context.collections.list(ws);
    return c.json({
      collections: collections.map((collection) => ({
        id: collection.id,
        name: collection.name,
        version: collection.version,
        fields: collection.fields,
      })),
    });
  });

  api.post("/collections", async (c) => {
    const input = await parseBody(c, schemas.createCollection);
    const collection = await context.collections.create(
      ws,
      {
        name: input.name,
        fields: input.fields.map((field) => ({
          name: field.name,
          type: field.type,
          ...(field.required === undefined ? {} : { required: field.required }),
          ...(field.options === undefined ? {} : { options: field.options }),
        })),
      },
      by(c, undefined),
    );
    c.header("Location", `/api/v1/collections/${encodeURIComponent(collection.id)}`);
    return c.json(
      { id: collection.id, name: collection.name, version: collection.version, fields: collection.fields },
      201,
    );
  });

  api.get("/collections/:cid", async (c) => {
    const collection = await context.collections.get(ws, c.req.param("cid"));
    c.header("ETag", etag(collection.version));
    return c.json({
      id: collection.id,
      name: collection.name,
      version: collection.version,
      fields: collection.fields,
    });
  });

  api.get("/collections/:cid/rows", async (c) => {
    const result = await context.collections.queryRows(ws, c.req.param("cid"), {
      limit: limitParam(c, 50),
      cursor: c.req.query("cursor") ?? null,
    });
    return c.json({ rows: result.items.map(rowJson), cursor: result.cursor });
  });

  api.post("/collections/:cid/query", async (c) => {
    const input = await parseBody(c, schemas.query);
    const result = await context.collections.queryRows(ws, c.req.param("cid"), {
      where: input.where as never,
      sort: input.sort as never,
      limit: input.limit ?? 50,
      cursor: input.cursor ?? null,
    });
    return c.json({ rows: result.items.map(rowJson), cursor: result.cursor });
  });

  api.post("/collections/:cid/rows", async (c) => {
    const input = await parseBody(c, schemas.row);
    const row = await context.collections.upsertRow(
      ws,
      c.req.param("cid"),
      { values: input.values as never },
      by(c, input.change_note),
    );
    c.header("ETag", etag(row.version));
    c.header(
      "Location",
      `/api/v1/collections/${encodeURIComponent(c.req.param("cid"))}/rows/${encodeURIComponent(row.id)}`,
    );
    return c.json(rowJson(row), 201);
  });

  api.get("/collections/:cid/rows/:rid", async (c) => {
    const row = await context.collections.getRow(ws, c.req.param("cid"), c.req.param("rid"));
    c.header("ETag", etag(row.version));
    return c.json(rowJson(row));
  });

  // With If-Match, an update. Without it, a create at this id, which is a
  // version conflict if the row already exists.
  api.put("/collections/:cid/rows/:rid", async (c) => {
    const version = ifMatch(c);
    const input = await parseBody(c, schemas.row);
    const row = await context.collections.upsertRow(
      ws,
      c.req.param("cid"),
      { values: input.values as never },
      by(c, input.change_note),
      { id: c.req.param("rid"), expectedVersion: version },
    );
    c.header("ETag", etag(row.version));
    return c.json(rowJson(row), version === null ? 201 : 200);
  });

  api.delete("/collections/:cid/rows/:rid", async (c) => {
    const version = requireIfMatch(c);
    const input = await parseBody(c, schemas.deleteBody);
    await context.collections.deleteRow(
      ws,
      c.req.param("cid"),
      c.req.param("rid"),
      version,
      by(c, input.change_note),
    );
    return c.body(null, 204);
  });

  api.get("/collections/:cid/rows/:rid/history", async (c) => {
    const revisions = await context.collections.rowHistory(ws, c.req.param("cid"), c.req.param("rid"), {
      limit: limitParam(c, 20),
    });
    return c.json({ revisions: revisions.map(revisionSummary) });
  });

  api.get("/collections/:cid/rows/:rid/revisions/:version", async (c) => {
    const view = await context.collections.rowRevision(
      ws,
      c.req.param("cid"),
      c.req.param("rid"),
      c.req.param("version"),
    );
    return c.json({
      ...revisionSummary(view.revision),
      values: view.snapshot.values,
      diff: renderDiff(view.diff),
    });
  });

  // The changes feed (ADR-013 rule 4).

  api.get("/changes", async (c) => {
    const since = c.req.query("since");
    if (since !== undefined && Number.isNaN(Date.parse(since))) {
      throw new BadRequest("since must be an ISO 8601 time, such as the `newest` value of a previous call.", [
        { field: "since", message: "not a time" },
      ]);
    }
    const actor = c.req.query("actor");
    if (actor !== undefined && actor !== "agent" && actor !== "user") {
      throw new BadRequest("actor must be agent or user.", [{ field: "actor", message: "agent or user" }]);
    }
    const limit = limitParam(c, 50);
    const sinceMs = since === undefined ? null : Date.parse(since);

    // Revisions come newest first. Read until the limit, or until one is older
    // than `since`. `since` is inclusive: a client drops repeats by version.
    const changes: Revision[] = [];
    let cursor: string | null = c.req.query("cursor") ?? null;
    let reachedSince = false;
    do {
      const batch: Paged<Revision> = await context.store.listRecentRevisions(ws, {
        limit: Math.min(limit - changes.length, 100),
        cursor,
        ...(actor === undefined ? {} : { actorKind: actor }),
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

    return c.json({
      changes: changes.map(revisionDetail),
      newest: changes[0]?.createdAt ?? since ?? null,
      cursor: reachedSince ? null : cursor,
    });
  });

  // Last, so it only catches what nothing above matched. A mounted app's
  // notFound handler is never called; the parent's is, which is the console.
  api.all("*", (c) =>
    c.json({ error: "not_found", message: `No endpoint ${c.req.method} ${c.req.path}.` }, 404),
  );

  return api;
}
