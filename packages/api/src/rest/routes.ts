import { Hono, type Context } from "hono";
import { z } from "zod";
import { MAX_SOURCES, NotFoundError, type Actor, type Page, type Paged, type Revision, type Row } from "@cairn/core";
import type { AppContext } from "../context.js";
import {
  tableJson,
  childSummaryJson,
  childrenPreview,
  describeError,
  deletePage,
  deletedPageSummary,
  editPage,
  linkJson,
  listChanges,
  listChildren,
  listDeletedPages,
  moveRecord,
  publishPage,
  createPublishTokenOp,
  listPublishTokensOp,
  revokePublishTokenOp,
  createAttachmentOp,
  confirmAttachmentUploadOp,
  getAttachmentOp,
  listAttachmentsOp,
  deleteAttachmentOp,
  toFieldDefs,
  undeletePage,
  vacuumPage,
  EDIT_MODES,
  pageSummary,
  renderDiff,
  revisionDetail,
  revisionSummary,
  rowJson,
  sourceChangesJson,
  verifiedTimes,
  searchPages,
  writeRow,
} from "../operations.js";
import { workspaceSummary } from "../mcp/summary.js";

/**
 * The REST API at /api/v1 (ADR-013).
 *
 * Same core, same attribution and same error codes as the MCP tools; only the
 * translation differs. Version tokens travel as ETag and If-Match. Auth is
 * applied by the app before these routes run.
 */

/** Who is calling: set by the app's auth check (ADR-013 rule 3, ADR-017). */
type CallerFor = (request: Request) => { actor: Actor; via: string; identity: string | null };

const MAX_LIMIT = 200;

/** Characters for /overview. Larger than the initialize budget, still bounded. */
const OVERVIEW_BUDGET = 4_000;

/** Characters for /overview?brief=true (ADR-053): about 200 tokens, for a session hook. */
const BRIEF_OVERVIEW_BUDGET = 800;

/** Pages read for one export page of results. Personal scale (PRD goal 2). */
const MAX_EXPORT_SCAN = 20_000;

/** Offset cursors for export, which walks a list it builds itself. */
function exportCursor(offset: number): string {
  return Buffer.from(`x:${offset}`).toString("base64url");
}

function exportOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^x:(\d+)$/.exec(Buffer.from(cursor, "base64url").toString());
  if (!match) throw new BadRequest("That cursor is not from this export.", [{ field: "cursor", message: "invalid" }]);
  return Number(match[1]);
}

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

// Where facts came from (ADR-027). Core checks each one's length and the
// total; this only keeps a request from sending thousands.
const SOURCES = z.array(z.string()).max(MAX_SOURCES).optional();

// A verification time, or null for never (ADR-028). Core checks it is a time.
const VERIFIED_AT = z.string().nullable().optional();

// The exact edit time, sent by sync so an edit keeps the time it was made on
// the other server (ADR-030). Core checks it is a time.
const EDITED_AT = z.string().optional();

const schemas = {
  createPage: z.object({
    title: z.string().min(1),
    body: z.string().default(""),
    parent_id: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    sources: SOURCES,
    change_note: CHANGE_NOTE,
  }),
  editPage: z.object({
    mode: z.enum(EDIT_MODES).default("append"),
    content: z.string(),
    section: z.string().optional(),
    title: z.string().min(1).optional(),
    tags: z.array(z.string()).optional(),
    // Added to the page's sources.
    sources: SOURCES,
    // True: the page's facts were re-checked and still hold.
    verified: z.boolean().optional(),
    change_note: CHANGE_NOTE,
  }),
  deleteBody: z.object({ change_note: CHANGE_NOTE }).default({}),
  putPage: z.object({
    title: z.string().min(1),
    body: z.string().default(""),
    parent_id: z.string().nullable().optional(),
    tags: z.array(z.string()).default([]),
    // The whole list. Left out, the page keeps the sources it has.
    sources: SOURCES,
    // Left out, the page keeps its verification time; on a create, it counts
    // as checked if it has sources.
    verified_at: VERIFIED_AT,
    edited_at: EDITED_AT,
    change_note: CHANGE_NOTE,
  }),
  createTable: z.object({
    name: z.string().min(1),
    fields: z
      .array(
        z.object({
          name: z.string().min(1),
          type: z.enum(FIELD_TYPES),
          required: z.boolean().optional(),
          options: z.array(z.string()).optional(),
          target: z.string().min(1).optional(),
          multiple: z.boolean().optional(),
        }),
      )
      .min(1),
    // The page it sits under. On PUT, leave it out to keep it where it is.
    parent_id: z.string().min(1).nullable().optional(),
    // Left out on PUT: the table keeps the one it has.
    description: z.string().max(280).nullable().optional(),
    change_note: z.string().max(500),
  }),
  publish: z.object({
    id: z.string().min(1),
    // True publishes the page and everything under it; false takes it down.
    public: z.boolean(),
    version: z.string().min(1),
    change_note: CHANGE_NOTE,
  }),
  createPublishToken: z.object({
    page_id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    change_note: CHANGE_NOTE,
  }),
  createAttachment: z.object({
    page_id: z.string().min(1),
    filename: z.string().min(1),
    alt_text: z.string().nullable().optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i, "must be 64 hex characters"),
    content_type: z.string().min(1),
    bytes: z.number().int().positive(),
    change_note: CHANGE_NOTE,
  }),
  move: z.object({
    id: z.string().min(1),
    parent_id: z.string().min(1).nullable(),
    version: z.string().min(1),
    change_note: CHANGE_NOTE,
  }),
  row: z.object({
    values: z.record(z.string(), z.unknown()),
    // On PUT, the whole list; left out, the row keeps the sources it has.
    sources: SOURCES,
    // Added to the row's sources instead, as `cairn upsert --source` does.
    add_sources: SOURCES,
    edited_at: EDITED_AT,
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

/** A missing record named in a query string, worded like the domain's own. */
class NotFound extends NotFoundError {}

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

/**
 * A page or row as REST returns it: what every surface returns, plus the
 * edit time sync orders by (ADR-030). MCP leaves it out; agents read
 * `updated_at`.
 */
function restPage(page: Page): Record<string, unknown> {
  return { ...pageSummary(page), edited_at: page.editedAt, public: page.public };
}

function restRow(row: Row): Record<string, unknown> {
  return { ...rowJson(row), edited_at: row.editedAt };
}

/** The page as Markdown with a small header, the cheapest read for an agent. */
function pageMarkdown(page: Page): string {
  return [
    "---",
    `id: ${page.id}`,
    `title: ${JSON.stringify(page.title)}`,
    `version: ${page.version}`,
    `tags: ${JSON.stringify(page.tags)}`,
    ...(page.sources.length > 0 ? [`sources: ${JSON.stringify(page.sources)}`] : []),
    `verified: ${page.verifiedAt ?? "never"}`,
    `updated: ${page.updatedAt} by ${page.updatedBy.kind} ${JSON.stringify(page.updatedBy.label)}`,
    "---",
    "",
    page.body,
  ].join("\n");
}

export function restRoutes(context: AppContext, callerFor: CallerFor): Hono {
  const api = new Hono();
  const ws = context.workspaceId;
  const by = (c: Context, note: string | undefined) => ({
    actor: callerFor(c.req.raw).actor,
    note: note ?? null,
  });

  api.onError((error, c) => fail(c, error));

  // What the workspace holds: the summary MCP clients get at initialize
  // (ADR-012), with more room, since only a caller who asks pays for it.

  api.get("/overview", async (c) => {
    const brief = c.req.query("brief") === "true";
    return c.json({ text: await workspaceSummary(context, brief ? BRIEF_OVERVIEW_BUDGET : OVERVIEW_BUDGET) });
  });

  // Who the server thinks you are, so a CLI or a deploy script can check its
  // sign-in worked before it writes anything.
  api.get("/me", (c) => {
    const caller = callerFor(c.req.raw);
    return c.json({
      via: caller.via,
      identity: caller.identity,
      actor: { kind: caller.actor.kind, id: caller.actor.id, name: caller.actor.label },
      workspace: ws,
    });
  });

  // Search.

  api.get("/search", async (c) => {
    const query = c.req.query("q")?.trim();
    if (!query) throw new BadRequest("Pass the words to search for as q.", [{ field: "q", message: "required" }]);
    const result = await searchPages(context, {
      query,
      limit: limitParam(c, 10),
      cursor: c.req.query("cursor") ?? null,
    });
    const verified = await verifiedTimes(context, result.pages.map((page) => page.pageId));
    return c.json({
      mode: result.mode,
      // A page appears once, its best passage leading and up to two more
      // attached to it, rather than each passage filling its own slot
      // (ADR-057).
      pages: result.pages.map((page) => ({
        page_id: page.pageId,
        score: Number(page.score.toFixed(4)),
        passages: page.passages.map((passage) => ({
          heading_path: passage.headingPath,
          snippet: passage.snippet,
          score: Number(passage.score.toFixed(4)),
        })),
        more_passages: page.morePassages,
        verified_at: verified.get(page.pageId) ?? null,
      })),
      truncated: result.truncated,
      cursor: result.cursor,
      hint:
        result.pages.length === 0
          ? `Nothing matched "${query}". Try synonyms, a shorter query, or one distinctive word.`
          : undefined,
    });
  });

  // Pages.

  api.get("/pages", async (c) => {
    const parent = c.req.query("parent");
    // With a parent, this is list_children (ADR-058): title order, child
    // counts, a cursor over that order. Without one, the full unscoped list
    // that export and sync already rely on, unchanged.
    if (parent !== undefined) {
      const result = await listChildren(context, {
        parentId: parent === "root" ? null : parent,
        cursor: c.req.query("cursor") ?? null,
        limit: limitParam(c, 50),
      });
      return c.json({ pages: result.items.map(childSummaryJson), cursor: result.cursor });
    }
    const page: Paged<Page> = await context.store.listPages(ws, {
      limit: limitParam(c, 50),
      cursor: c.req.query("cursor") ?? null,
    });
    return c.json({ pages: page.items.map(restPage), cursor: page.cursor });
  });

  // Before /pages/:id, so "deleted" is never read as an id.
  api.get("/pages/deleted", async (c) => {
    const result = await listDeletedPages(context, {
      cursor: c.req.query("cursor") ?? null,
      limit: limitParam(c, 50),
    });
    return c.json({ pages: result.items.map(deletedPageSummary), cursor: result.cursor });
  });

  api.post("/pages", async (c) => {
    const input = await parseBody(c, schemas.createPage);
    const page = await context.pages.create(
      ws,
      {
        title: input.title,
        body: input.body,
        parentId: input.parent_id ?? null,
        tags: input.tags ?? [],
        sources: input.sources ?? [],
      },
      by(c, input.change_note),
    );
    c.header("ETag", etag(page.version));
    c.header("Location", `/api/v1/pages/${encodeURIComponent(page.id)}`);
    return c.json(restPage(page), 201);
  });

  api.get("/pages/:id", async (c) => {
    const page = await context.pages.get(ws, c.req.param("id"));
    c.header("ETag", etag(page.version));
    if (c.req.query("format") === "markdown") {
      return c.body(pageMarkdown(page), 200, { "content-type": "text/markdown; charset=utf-8" });
    }
    // Immediate children, capped (ADR-058), so an agent sees whether it can
    // walk further without a second call.
    const children = await childrenPreview(context, page.id);
    return c.json({
      ...restPage(page),
      body: page.body,
      children: children.items.map(childSummaryJson),
      more_children: children.more,
    });
  });

  // Create or replace a whole page at a given id: the import path, which
  // keeps ids so links survive (ADR-016). Without If-Match it only creates.
  api.put("/pages/:id", async (c) => {
    const version = ifMatch(c);
    const input = await parseBody(c, schemas.putPage);
    const page = await context.pages.update(
      ws,
      c.req.param("id"),
      {
        title: input.title,
        body: input.body,
        parentId: input.parent_id ?? null,
        tags: input.tags,
        ...(input.sources === undefined ? {} : { sources: input.sources }),
        ...(input.verified_at === undefined ? {} : { verifiedAt: input.verified_at }),
        ...(input.edited_at === undefined ? {} : { editedAt: input.edited_at }),
      },
      version,
      by(c, input.change_note),
    );
    c.header("ETag", etag(page.version));
    return c.json(restPage(page), version === null ? 201 : 200);
  });

  api.patch("/pages/:id", async (c) => {
    const version = requireIfMatch(c);
    const input = await parseBody(c, schemas.editPage);
    const page = await editPage(
      context,
      c.req.param("id"),
      version,
      {
        mode: input.mode,
        content: input.content,
        section: input.section,
        title: input.title,
        tags: input.tags,
        sources: input.sources,
        verified: input.verified,
      },
      by(c, input.change_note),
    );
    c.header("ETag", etag(page.version));
    return c.json(restPage(page));
  });

  api.delete("/pages/:id", async (c) => {
    const version = requireIfMatch(c);
    const input = await parseBody(c, schemas.deleteBody);
    await deletePage(context, c.req.param("id"), version, by(c, input.change_note));
    return c.body(null, 204);
  });

  // Bring a deleted page back at the same id, with the content it held
  // before it was deleted (ADR-059). No If-Match: there is no current
  // version to check the write against, since the page does not exist.
  api.post("/pages/:id/undelete", async (c) => {
    const input = await parseBody(c, schemas.deleteBody);
    const page = await undeletePage(context, c.req.param("id"), by(c, input.change_note));
    c.header("ETag", etag(page.version));
    return c.json(restPage(page), 201);
  });

  // Prune a page's older revisions and compact the database (ADR-059).
  // Irreversible, so it needs the version the caller last read, the same
  // guard every other write against this page uses.
  api.post("/pages/:id/vacuum", async (c) => {
    const version = requireIfMatch(c);
    const result = await vacuumPage(context, c.req.param("id"), version);
    return c.json({ id: c.req.param("id"), revisions_removed: result.removed });
  });

  const tableIds = async () => new Set((await context.tables.list(ws)).map((table) => table.id));

  api.get("/pages/:id/backlinks", async (c) => {
    const edges = await context.pages.backlinks(ws, c.req.param("id"));
    const ids = await tableIds();
    return c.json({ backlinks: edges.map((edge) => linkJson(edge, "source", ids)) });
  });

  api.get("/pages/:id/neighbours", async (c) => {
    const { outbound, inbound } = await context.pages.neighbours(ws, c.req.param("id"));
    const ids = await tableIds();
    return c.json({
      outbound: outbound.map((e) => linkJson(e, "target", ids)),
      inbound: inbound.map((e) => linkJson(e, "source", ids)),
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
      parent_id: view.snapshot.parentId,
      tags: view.snapshot.tags,
      sources: view.snapshot.sources,
      verified_at: view.snapshot.verifiedAt,
      body: view.snapshot.body,
      title_changed: view.titleChanged || undefined,
      tags_changed: view.tagsChanged || undefined,
      ...sourceChangesJson(view),
      verified: view.verified || undefined,
      diff: renderDiff(view.diff),
    });
  });

  // Restore a page to an earlier revision: an ordinary update whose content
  // comes from that revision's snapshot, so it is itself just another
  // revision and can be undone the same way (ADR-008 consequence 3, ADR-045).
  api.post("/pages/:id/revisions/:version/restore", async (c) => {
    const expected = requireIfMatch(c);
    const input = await parseBody(c, schemas.deleteBody);
    const page = await context.pages.restore(
      ws,
      c.req.param("id"),
      c.req.param("version"),
      expected,
      by(c, input.change_note),
    );
    c.header("ETag", etag(page.version));
    return c.json(restPage(page));
  });

  // Tables and rows, at /tables and also at /collections, the name before
  // ADR-026, so a client from before the rename keeps working.
  const tables = new Hono();
  tables.onError((error, c) => fail(c, error));

  tables.get("/", async (c) => {
    const list = await context.tables.list(ws);
    const key = c.req.path.replace(/\/$/, "").endsWith("/collections") ? "collections" : "tables";
    return c.json({ [key]: list.map(tableJson) });
  });

  tables.post("/", async (c) => {
    const input = await parseBody(c, schemas.createTable);
    const table = await context.tables.create(
      ws,
      {
        name: input.name,
        fields: toFieldDefs(input.fields),
        parentId: input.parent_id ?? null,
        description: input.description ?? null,
      },
      by(c, input.change_note),
    );
    c.header("Location", `/api/v1/tables/${encodeURIComponent(table.id)}`);
    return c.json(tableJson(table), 201);
  });

  // Create a table at a given id, or change its schema with If-Match.
  tables.put("/:cid", async (c) => {
    const version = ifMatch(c);
    const input = await parseBody(c, schemas.createTable);
    const table = await context.tables.update(
      ws,
      c.req.param("cid"),
      {
        name: input.name,
        fields: toFieldDefs(input.fields),
        ...(input.parent_id === undefined ? {} : { parentId: input.parent_id }),
        ...(input.description === undefined ? {} : { description: input.description }),
      },
      version,
      by(c, input.change_note),
    );
    c.header("ETag", etag(table.version));
    return c.json(tableJson(table), version === null ? 201 : 200);
  });

  tables.get("/:cid", async (c) => {
    const table = await context.tables.get(ws, c.req.param("cid"));
    c.header("ETag", etag(table.version));
    return c.json(tableJson(table));
  });

  tables.get("/:cid/rows", async (c) => {
    const result = await context.tables.queryRows(ws, c.req.param("cid"), {
      limit: limitParam(c, 50),
      cursor: c.req.query("cursor") ?? null,
    });
    return c.json({ rows: result.items.map(restRow), cursor: result.cursor });
  });

  tables.post("/:cid/query", async (c) => {
    const input = await parseBody(c, schemas.query);
    const result = await context.tables.queryRows(ws, c.req.param("cid"), {
      where: input.where as never,
      sort: input.sort as never,
      limit: input.limit ?? 50,
      cursor: input.cursor ?? null,
    });
    return c.json({ rows: result.items.map(restRow), cursor: result.cursor });
  });

  tables.post("/:cid/rows", async (c) => {
    const input = await parseBody(c, schemas.row);
    const row = await context.tables.upsertRow(
      ws,
      c.req.param("cid"),
      { values: input.values as never, sources: input.sources ?? [] },
      by(c, input.change_note),
    );
    c.header("ETag", etag(row.version));
    c.header(
      "Location",
      `/api/v1/tables/${encodeURIComponent(c.req.param("cid"))}/rows/${encodeURIComponent(row.id)}`,
    );
    return c.json(restRow(row), 201);
  });

  tables.get("/:cid/rows/:rid", async (c) => {
    const row = await context.tables.getRow(ws, c.req.param("cid"), c.req.param("rid"));
    c.header("ETag", etag(row.version));
    return c.json(restRow(row));
  });

  // With If-Match, an update. Without it, a create at this id, which is a
  // version conflict if the row already exists.
  tables.put("/:cid/rows/:rid", async (c) => {
    const version = ifMatch(c);
    const input = await parseBody(c, schemas.row);
    if (input.sources !== undefined && input.add_sources !== undefined) {
      throw new BadRequest("Send sources to replace the list, or add_sources to add to it, not both.", [
        { field: "add_sources", message: "not with sources" },
      ]);
    }
    if (input.edited_at !== undefined && input.add_sources !== undefined) {
      throw new BadRequest("edited_at goes with a whole row, sent with sources, not with add_sources.", [
        { field: "edited_at", message: "not with add_sources" },
      ]);
    }
    const target = { id: c.req.param("rid"), ...(version === null ? {} : { expectedVersion: version }) };
    const row =
      input.add_sources !== undefined
        ? await writeRow(context, c.req.param("cid"), input.values, input.add_sources, by(c, input.change_note), target)
        : await context.tables.upsertRow(
            ws,
            c.req.param("cid"),
            {
              values: input.values as never,
              ...(input.sources === undefined ? {} : { sources: input.sources }),
              ...(input.edited_at === undefined ? {} : { editedAt: input.edited_at }),
            },
            by(c, input.change_note),
            { id: c.req.param("rid"), expectedVersion: version },
          );
    c.header("ETag", etag(row.version));
    return c.json(restRow(row), version === null ? 201 : 200);
  });

  tables.delete("/:cid/rows/:rid", async (c) => {
    const version = requireIfMatch(c);
    const input = await parseBody(c, schemas.deleteBody);
    await context.tables.deleteRow(
      ws,
      c.req.param("cid"),
      c.req.param("rid"),
      version,
      by(c, input.change_note),
    );
    return c.body(null, 204);
  });

  // Move a page or a table (ADR-024).
  // Publishing is deliberately its own route, not a field on an ordinary
  // write, so nothing publishes a page by accident (ADR-032).
  api.post("/publish", async (c) => {
    const input = await parseBody(c, schemas.publish);
    return c.json(await publishPage(context, input.id, input.public, input.version, by(c, input.change_note)));
  });

  // Publish tokens (ADR-066): gate a published subtree behind a named,
  // revocable token. Console and CLI only, never MCP, same as /publish.

  api.post("/publish-tokens", async (c) => {
    const input = await parseBody(c, schemas.createPublishToken);
    return c.json(
      await createPublishTokenOp(context, input.page_id, input.name, input.description, by(c, input.change_note)),
      201,
    );
  });

  api.get("/publish-tokens", async (c) => {
    const pageId = c.req.query("page");
    if (!pageId) throw new BadRequest("Pass the page to list tokens for as page.", [{ field: "page", message: "required" }]);
    return c.json({ tokens: await listPublishTokensOp(context, pageId) });
  });

  api.post("/publish-tokens/:id/revoke", async (c) => {
    const input = await parseBody(c, schemas.deleteBody);
    return c.json(await revokePublishTokenOp(context, c.req.param("id"), by(c, input.change_note)));
  });

  // Attachments (ADR-064): binary files, uploaded direct to blob storage.
  // Bytes never pass through this server; these routes only issue and check
  // signed URLs and the row that tracks them.

  api.post("/attachments", async (c) => {
    const input = await parseBody(c, schemas.createAttachment);
    const row = await createAttachmentOp(
      context,
      { pageId: input.page_id, filename: input.filename, altText: input.alt_text, sha256: input.sha256, contentType: input.content_type, bytes: input.bytes },
      by(c, input.change_note),
    );
    return c.json(row, 201);
  });

  api.post("/attachments/:id/confirm", async (c) => {
    const input = await parseBody(c, schemas.deleteBody);
    return c.json(await confirmAttachmentUploadOp(context, c.req.param("id"), by(c, input.change_note)));
  });

  api.get("/attachments/:id", async (c) => {
    return c.json(await getAttachmentOp(context, c.req.param("id")));
  });

  api.get("/attachments", async (c) => {
    const pageId = c.req.query("page");
    if (!pageId) throw new BadRequest("Pass the page to list attachments for as page.", [{ field: "page", message: "required" }]);
    return c.json({ attachments: await listAttachmentsOp(context, pageId) });
  });

  api.delete("/attachments/:id", async (c) => {
    const version = requireIfMatch(c);
    const input = await parseBody(c, schemas.deleteBody);
    await deleteAttachmentOp(context, c.req.param("id"), version, by(c, input.change_note));
    return c.body(null, 204);
  });

  api.post("/move", async (c) => {
    const input = await parseBody(c, schemas.move);
    return c.json(await moveRecord(context, input.id, input.parent_id, input.version, by(c, input.change_note)));
  });

  // Links (ADR-024): a row's relation values, and what links to it.
  tables.get("/:cid/rows/:rid/links", async (c) => {
    const cid = c.req.param("cid");
    const rid = c.req.param("rid");
    await context.tables.getRow(ws, cid, rid);
    const [outbound, inbound, ids] = await Promise.all([
      context.tables.rowLinks(ws, cid, rid),
      context.tables.rowBacklinks(ws, cid, rid),
      tableIds(),
    ]);
    return c.json({
      outbound: outbound.map((e) => linkJson(e, "target", ids)),
      inbound: inbound.map((e) => linkJson(e, "source", ids)),
    });
  });

  tables.get("/:cid/backlinks", async (c) => {
    await context.tables.get(ws, c.req.param("cid"));
    const edges = await context.tables.backlinks(ws, c.req.param("cid"));
    const ids = await tableIds();
    return c.json({ backlinks: edges.map((edge) => linkJson(edge, "source", ids)) });
  });

  tables.get("/:cid/rows/:rid/history", async (c) => {
    const revisions = await context.tables.rowHistory(ws, c.req.param("cid"), c.req.param("rid"), {
      limit: limitParam(c, 20),
    });
    return c.json({ revisions: revisions.map(revisionSummary) });
  });

  tables.get("/:cid/rows/:rid/revisions/:version", async (c) => {
    const view = await context.tables.rowRevision(
      ws,
      c.req.param("cid"),
      c.req.param("rid"),
      c.req.param("version"),
    );
    return c.json({
      ...revisionSummary(view.revision),
      values: view.snapshot.values,
      sources: view.snapshot.sources,
      ...sourceChangesJson(view),
      diff: renderDiff(view.diff),
    });
  });

  api.route("/tables", tables);
  api.route("/collections", tables);

  // Export (ADR-016): whole pages, parents before children, so an import can
  // write them in the order given. `root` limits it to one page and
  // everything under it.

  api.get("/export/pages", async (c) => {
    const root = c.req.query("root");
    const limit = limitParam(c, 100);
    const offset = exportOffset(c.req.query("cursor"));

    const all: Page[] = [];
    let cursor: string | null = null;
    do {
      const batch: Paged<Page> = await context.store.listPages(ws, { limit: 500, cursor });
      all.push(...batch.items);
      cursor = batch.cursor;
    } while (cursor !== null && all.length < MAX_EXPORT_SCAN);

    const children = new Map<string | null, Page[]>();
    const ids = new Set(all.map((page) => page.id));
    for (const page of all) {
      // A page whose parent is gone is treated as top-level, not lost.
      const parent = page.parentId !== null && ids.has(page.parentId) ? page.parentId : null;
      children.set(parent, [...(children.get(parent) ?? []), page]);
    }
    for (const list of children.values()) list.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

    const ordered: Page[] = [];
    const visit = (page: Page, depth: number) => {
      if (depth > 64) return; // A cycle in bad data must not hang the export.
      ordered.push(page);
      for (const child of children.get(page.id) ?? []) visit(child, depth + 1);
    };
    if (root !== undefined) {
      const start = all.find((page) => page.id === root);
      if (!start) throw new NotFound("page", root);
      visit(start, 0);
    } else {
      for (const top of children.get(null) ?? []) visit(top, 0);
    }

    const slice = ordered.slice(offset, offset + limit);
    const next = offset + limit < ordered.length ? exportCursor(offset + limit) : null;
    return c.json({
      root: root ?? null,
      total: ordered.length,
      pages: slice.map((page) => ({ ...restPage(page), body: page.body, created_at: page.createdAt })),
      cursor: next,
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

    const result = await listChanges(context, {
      ...(since === undefined ? {} : { since }),
      ...(actor === undefined ? {} : { actorKind: actor }),
      cursor: c.req.query("cursor") ?? null,
      limit,
    });

    return c.json({
      changes: result.changes.map(revisionDetail),
      newest: result.newest,
      cursor: result.cursor,
    });
  });

  // Last, so it only catches what nothing above matched. A mounted app's
  // notFound handler is never called; the parent's is, which is the console.
  api.all("*", (c) =>
    c.json({ error: "not_found", message: `No endpoint ${c.req.method} ${c.req.path}.` }, 404),
  );

  return api;
}
