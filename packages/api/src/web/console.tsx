/** @jsxImportSource hono/jsx */
import type { Context, Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { raw } from "hono/html";
import type { Child, FC } from "hono/jsx";
import {
  diffLines,
  NotFoundError,
  parseRowNodeId,
  relationTarget,
  rowNodeId,
  ValidationError,
  VersionConflictError,
  type Table,
  type Edge,
  type FieldDef,
  type FieldError,
  type FieldValue,
  type Page,
  type PageSnapshot,
  type Paged,
  type Revision,
  type Row,
} from "@cairn/core";
import { OWNER, type AppContext } from "../context.js";
import { moveRecord } from "../operations.js";
import { ASSET_VERSION, CONSOLE_CSS, CONSOLE_JS, documentTitle, FAVICON_SVG, HEAD_TAGS, ICON_180_PNG, ICON_512_PNG, MANIFEST } from "./assets.js";
import { ActorPill, Banner, DiffView, Layout, When } from "./layout.js";
import { createMarkdownRenderer, pageHref, type LinkResolver } from "./markdown.js";
import { isSameOrigin, SESSION_COOKIE, sessionValue, timingSafeEqual } from "./session.js";
import type { OAuthServer } from "../oauth/server.js";
import type { Actor } from "@cairn/core";
import { NO_LOCAL_TRUST, trustedForConsole, type LocalTrust } from "../trust.js";

/**
 * The review console (ADR-009): recent changes, read-mode pages, a Markdown
 * editor, history with restore, tables, and search.
 *
 * Rendered on the server, plain forms, posts that redirect. Everything works
 * with JavaScript off except table sorting and the "/" shortcut.
 *
 * Scope is deliberately small. No rich editor, no board or calendar views, no
 * client-side application: those are Phase 2 or never (ADR-009 rule 1).
 */

export interface ConsoleOptions {
  context: AppContext;
  /** Null when only trusted local requests are accepted (ADR-010). */
  token: string | null;
  trust?: LocalTrust;
  /** Sign-in through the OAuth server's provider (ADR-017). */
  oauth?: OAuthServer | null;
  /**
   * The origin people use, such as https://cairn.example.com. Behind a proxy
   * that ends TLS, the server itself sees http, so form checks and cookies
   * must use this instead of the request's own URL.
   */
  publicOrigin?: string | null;
}

const renderMarkdown = createMarkdownRenderer();

/** Upper bound on pages loaded for the tree. Fine at personal scale. */
const MAX_TREE_PAGES = 5_000;

/**
 * Agent-written content is rendered here, so the policy is strict: no inline
 * script, no inline style, no external images, no framing, forms post only
 * back to the console.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
};

const PUBLIC_PATHS = [/^\/health$/, /^\/mcp/, /^\/api(\/|$)/, /^\/assets\//, /^\/favicon\.ico$/, /^\/login$/, /^\/oauth\//, /^\/\.well-known\//];

async function render(c: Context, element: Child, status: 200 | 400 | 404 | 409 = 200) {
  const body = await (element as Promise<string> | string);
  return c.html(`<!doctype html>${body}`, status);
}

function safeNext(next: string | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function text(form: Record<string, unknown>, key: string): string {
  const value = form[key];
  return typeof value === "string" ? value : "";
}

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter((tag) => tag !== "");
}

// Data helpers.

async function allPages(context: AppContext): Promise<Page[]> {
  const pages: Page[] = [];
  let cursor: string | null = null;
  do {
    const batch: Paged<Page> = await context.store.listPages(context.workspaceId, {
      limit: 500,
      cursor,
    });
    pages.push(...batch.items);
    cursor = batch.cursor;
  } while (cursor !== null && pages.length < MAX_TREE_PAGES);
  return pages;
}

const tableHref = (id: string) => `/t/${encodeURIComponent(id)}`;
const rowHref = (tableId: string, rowId: string) => `${tableHref(tableId)}/r/${encodeURIComponent(rowId)}`;

interface LinkedRow {
  table: Table;
  row: Row;
}

/**
 * Names and console addresses for everything a link can point at: pages,
 * tables, and the rows given (ADR-024). Pages win a clash of ids.
 */
function resolverFor(pages: Page[], tables: Table[] = [], rows: LinkedRow[] = []): LinkResolver {
  const titles = new Map<string, string>();
  const hrefs = new Map<string, string>();
  for (const page of pages) {
    titles.set(page.id, page.title);
    hrefs.set(page.id, pageHref(page.id));
  }
  for (const table of tables) {
    if (titles.has(table.id)) continue;
    titles.set(table.id, table.name);
    hrefs.set(table.id, tableHref(table.id));
  }
  for (const { table, row } of rows) {
    const id = rowNodeId(table.id, row.id);
    titles.set(id, `${table.name}: ${rowLabel(row.values, table, row.id)}`);
    hrefs.set(id, rowHref(table.id, row.id));
  }
  return { title: (id) => titles.get(id) ?? null, href: (id) => hrefs.get(id) ?? null };
}

/** The rows behind a set of link ends, for their names. Ids that are not rows are skipped. */
async function rowsFor(context: AppContext, ids: string[], tables: Table[]): Promise<LinkedRow[]> {
  const byId = new Map(tables.map((table) => [table.id, table]));
  const found: LinkedRow[] = [];
  for (const id of new Set(ids)) {
    const parsed = parseRowNodeId(id);
    const table = parsed ? byId.get(parsed.tableId) : undefined;
    if (!parsed || !table) continue;
    const row = await context.store.getRow(context.workspaceId, table.id, parsed.rowId);
    if (row) found.push({ table, row });
  }
  return found;
}

/** Every row of the tables a table's relation fields point at, for their names. */
async function targetRows(context: AppContext, table: Table, tables: Table[]): Promise<LinkedRow[]> {
  const targets = new Set(
    table.fields.filter((field) => field.type === "relation" && relationTarget(field) !== "pages").map(relationTarget),
  );
  const rows: LinkedRow[] = [];
  for (const target of targets) {
    const targetTable = tables.find((c) => c.id === target);
    if (!targetTable) continue;
    const page = await context.tables.queryRows(context.workspaceId, target, { limit: 500 });
    for (const row of page.items) rows.push({ table: targetTable, row });
  }
  return rows;
}

function ancestorsOf(pageId: string | null, byId: Map<string, Page>): Page[] {
  const chain: Page[] = [];
  const seen = new Set<string>();
  let current = pageId ? byId.get(pageId) : undefined;
  while (current?.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}

/**
 * The first paragraph of a page as plain text, for a collection's card:
 * links shown as their labels, Markdown marks dropped, cut at a word.
 */
function summaryOf(body: string, max = 180): string {
  const paragraph = body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p !== "" && !p.startsWith("#")) ?? "";
  const plain = paragraph
    .replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length <= max ? plain : `${plain.slice(0, plain.lastIndexOf(" ", max))}\u2026`;
}

/** A human label for a row: its first non-empty text field, or its id. */
function rowLabel(values: Record<string, FieldValue>, table: Table | null, id: string) {
  const textField = table?.fields.find(
    (field) => field.type === "text" && typeof values[field.name] === "string" && values[field.name],
  );
  return textField ? String(values[textField.name]) : id;
}

function rowIdOf(revision: Revision): string {
  return revision.recordId.slice((revision.tableId?.length ?? 0) + 1);
}

// Components.

const Tree: FC<{ pages: Page[]; tables?: Table[]; currentId?: string | undefined; rootId?: string | null }> = ({
  pages,
  tables = [],
  currentId,
  rootId = null,
}) => {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const children = new Map<string | null, Page[]>();
  for (const page of pages) {
    const parent = page.parentId && byId.has(page.parentId) ? page.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(page);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.title.localeCompare(b.title));
  // Tables sit in the tree under their page (ADR-024), after its child pages.
  const tablesUnder = new Map<string | null, Table[]>();
  for (const table of tables) {
    const parent = table.parentId && byId.has(table.parentId) ? table.parentId : null;
    tablesUnder.set(parent, [...(tablesUnder.get(parent) ?? []), table]);
  }
  for (const list of tablesUnder.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const current = currentId ? tables.find((table) => table.id === currentId) : undefined;
  const open = new Set(ancestorsOf(current?.parentId ?? currentId ?? null, byId).map((page) => page.id));
  if (current?.parentId) open.add(current.parentId);
  if (currentId) open.add(currentId);

  const tableItems = (parent: string | null): Child[] =>
    (tablesUnder.get(parent) ?? []).map((table) => (
      <li>
        <a href={tableHref(table.id)} aria-current={table.id === currentId ? "page" : undefined}>
          {table.name}
        </a>{" "}
        <span class="ak-small">table</span>
      </li>
    ));

  const branch = (parent: string | null): Child => (
    <ul>
      {(children.get(parent) ?? []).map((page) => {
        const link = (
          <a
            href={pageHref(page.id)}
            aria-current={page.id === currentId ? "page" : undefined}
          >
            {page.title}
          </a>
        );
        return children.has(page.id) || tablesUnder.has(page.id) ? (
          <li>
            <details open={open.has(page.id)}>
              <summary>{link}</summary>
              {branch(page.id)}
            </details>
          </li>
        ) : (
          <li>{link}</li>
        );
      })}
      {tableItems(parent)}
    </ul>
  );

  // Inside a collection, only its tree (ADR-026): the root heads it.
  const root = rootId ? byId.get(rootId) : undefined;
  return (
    <nav class="cairn-tree" aria-label={root ? `The ${root.title} collection` : "Pages"}>
      {root ? (
        <p class="ak-eyebrow">
          <a href={pageHref(root.id)} aria-current={root.id === currentId ? "page" : undefined}>
            {root.title}
          </a>
        </p>
      ) : (
        <p class="ak-eyebrow">Pages</p>
      )}
      {branch(root ? root.id : null)}
    </nav>
  );
};

const EdgeList: FC<{ edges: Edge[]; direction: "in" | "out"; titles: LinkResolver }> = ({
  edges,
  direction,
  titles,
}) => {
  const pagesOnly = edges.filter((edge) => edge.type !== "tag");
  if (pagesOnly.length === 0) return <p class="ak-small">None.</p>;
  return (
    <ul>
      {pagesOnly.map((edge) => {
        const id = direction === "in" ? edge.sourceId : edge.targetId;
        const title = titles.title(id);
        const how = edge.type === "relation" ? edge.label : edge.type === "link" ? null : edge.type;
        return (
          <li>
            {title === null ? (
              <span class="ak-soft">{id}</span>
            ) : (
              <a href={titles.href?.(id) ?? pageHref(id)}>{title}</a>
            )}{" "}
            {how ? <span class="ak-small">({how})</span> : null}
          </li>
        );
      })}
    </ul>
  );
};

const PageEditor: FC<{
  action: string;
  title: string;
  tags: string;
  body: string;
  note: string;
  version?: string | undefined;
  parentId?: string | null | undefined;
  pages?: Page[] | undefined;
  preview?: string | undefined;
  cancel: string;
}> = (props) => (
  <form method="post" action={props.action} class="cairn-editor" data-dirty-guard>
    {props.version ? <input type="hidden" name="version" value={props.version} /> : null}
    <label for="title">Title</label>
    <input class="ak-input" id="title" name="title" value={props.title} required />
    {props.pages ? (
      <>
        <label for="parent">Parent page</label>
        <select class="ak-select" id="parent" name="parent">
          <option value="">None (top level)</option>
          {props.pages
            .slice()
            .sort((a, b) => a.title.localeCompare(b.title))
            .map((page) => (
              <option value={page.id} selected={page.id === props.parentId}>
                {page.title}
              </option>
            ))}
        </select>
      </>
    ) : null}
    <label for="tags">Tags, comma separated</label>
    <input class="ak-input" id="tags" name="tags" value={props.tags} />
    <label for="body">Content (Markdown). Link a page with [[page-id]].</label>
    <textarea class="ak-textarea" id="body" name="body" spellcheck>
      {props.body}
    </textarea>
    <label for="note">What changed, and why (optional)</label>
    <input class="ak-input" id="note" name="note" value={props.note} maxlength={500} />
    <div class="cairn-actions">
      <button class="ak-btn ak-btn-primary" type="submit">
        Save
      </button>
      <button class="ak-btn" type="submit" formaction={`${props.action}?preview=1`}>
        Preview
      </button>
      <a class="ak-btn" href={props.cancel}>
        Cancel
      </a>
    </div>
    {props.preview !== undefined ? (
      <section class="ak-section">
        <p class="ak-eyebrow">Preview, not saved</p>
        <article class="ak-prose">{raw(props.preview)}</article>
      </section>
    ) : null}
  </form>
);

const RevisionTimeline: FC<{
  revisions: Revision[];
  hrefFor: (revision: Revision) => string;
  currentVersion: string | null;
}> = ({ revisions, hrefFor, currentVersion }) =>
  revisions.length === 0 ? (
    <p class="ak-small">
      No history recorded yet. Records written before history existed start their history at
      their next change.
    </p>
  ) : (
    <ol class="ak-timeline cairn-changes">
      {revisions.map((revision) => (
        <li class="ak-tl-item">
          <When at={revision.createdAt} />
          <span class="ak-t">
            <a href={hrefFor(revision)}>
              {revision.deleted
                ? "Deleted"
                : revision.parentVersion === null
                  ? "Created"
                  : "Edited"}
            </a>
          </span>{" "}
          {revision.version === currentVersion ? (
            <span class="ak-pill ak-pill-ok">current</span>
          ) : null}
          <p>
            <ActorPill actor={revision.actor} />
          </p>
          {revision.note ? <p class="cairn-note">{revision.note}</p> : null}
        </li>
      ))}
    </ol>
  );

/** Rows in a table, as text: "79", or "500+" past the scan limit. */
async function rowCount(context: AppContext, tableId: string): Promise<string> {
  const page = await context.tables.queryRows(context.workspaceId, tableId, { limit: 500 });
  return `${page.items.length}${page.cursor ? "+" : ""}`;
}

/**
 * The tables a page holds, shown in the page below its text, once
 * (ADR-024), and a form to put another table here: how a page becomes
 * a place for tables.
 */
const PageTables: FC<{ page: Page; tables: Table[]; counts: Map<string, string>; others: Table[] }> = ({
  page,
  tables,
  counts,
  others,
}) => (
  <section class="cairn-tables" aria-label="Tables in this page">
    {tables.map((table) => (
      <div class="cairn-table-card">
        <h2>
          <a href={tableHref(table.id)}>{table.name}</a>
        </h2>
        <p class="ak-small">
          {counts.get(table.id) ?? "0"} rows · {table.fields.map((field) => field.name).join(", ")}
        </p>
      </div>
    ))}
    {others.length > 0 ? (
      <details class="ak-disclosure">
        <summary>Put a table here</summary>
        <form method="post" action={`${pageHref(page.id)}/tables`} class="cairn-editor">
          <label for="adopt">Table</label>
          <select class="ak-select" id="adopt" name="table">
            {[...others]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((table) => (
                <option value={`${table.id}@${table.version}`}>{table.name}</option>
              ))}
          </select>
          <label for="adopt_note">Why (optional)</label>
          <input class="ak-input" id="adopt_note" name="note" type="text" />
          <div class="cairn-actions">
            <button class="ak-btn" type="submit">
              Put it under {page.title}
            </button>
            <span class="ak-small">Only its place changes; its rows stay as they are.</span>
          </div>
        </form>
      </details>
    ) : null}
  </section>
);

// Row form helpers.

function fieldInput(field: FieldDef, value: FieldValue | undefined, error?: string): Child {
  const id = `f_${field.name}`;
  const common = { id, name: field.name, "aria-invalid": error ? "true" : undefined };
  switch (field.type) {
    case "checkbox":
      return <input type="checkbox" {...common} value="true" checked={value === true} />;
    case "number":
      return (
        <input
          class="ak-input"
          type="text"
          inputmode="decimal"
          {...common}
          value={value === null || value === undefined ? "" : String(value)}
        />
      );
    case "date":
      return (
        <input
          class="ak-input"
          type="date"
          {...common}
          value={typeof value === "string" ? value.slice(0, 10) : ""}
        />
      );
    case "select":
      return (
        <select class="ak-select" {...common}>
          <option value="">(none)</option>
          {(field.options ?? []).map((option) => (
            <option value={option} selected={value === option}>
              {option}
            </option>
          ))}
        </select>
      );
    case "multi_select":
      return (
        <div class="cairn-checks" role="group" aria-labelledby={`${id}_label`}>
          {(field.options ?? []).map((option) => (
            <label>
              <input
                type="checkbox"
                name={field.name}
                value={option}
                checked={Array.isArray(value) && value.includes(option)}
              />{" "}
              {option}
            </label>
          ))}
        </div>
      );
    default:
      return (
        <input
          class="ak-input"
          type={field.type === "url" ? "url" : "text"}
          {...common}
          value={typeof value === "string" ? value : Array.isArray(value) ? value.join(", ") : ""}
          placeholder={
            field.type !== "relation"
              ? undefined
              : relationTarget(field) === "pages"
                ? field.multiple ? "page ids, separated by commas" : "page id"
                : field.multiple ? "row ids, separated by commas" : "row id"
          }
        />
      );
  }
}

function readRowValues(
  table: Table,
  form: Record<string, string | File | (string | File)[]>,
): Record<string, FieldValue> {
  const values: Record<string, FieldValue> = {};
  for (const field of table.fields) {
    const raw = form[field.name];
    const all = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).filter(
      (entry): entry is string => typeof entry === "string",
    );
    const first = all[0]?.trim() ?? "";

    if (field.type === "checkbox") {
      values[field.name] = all.includes("true");
    } else if (field.type === "multi_select") {
      if (all.length > 0) values[field.name] = all;
    } else if (field.type === "relation" && field.multiple) {
      const ids = first.split(/[\s,]+/).filter((id) => id !== "");
      if (ids.length > 0) values[field.name] = ids;
    } else if (first === "") {
      continue;
    } else if (field.type === "number") {
      const number = Number(first);
      // Pass the raw text on when it is not a number, so validation names the
      // field rather than the form silently dropping it.
      values[field.name] = Number.isFinite(number) ? number : first;
    } else {
      values[field.name] = first;
    }
  }
  return values;
}

const RowForm: FC<{
  table: Table;
  action: string;
  values: Record<string, FieldValue>;
  errors: FieldError[];
  version?: string | undefined;
  note: string;
  cancel: string;
}> = ({ table, action, values, errors, version, note, cancel }) => (
  <form method="post" action={action} class="cairn-editor" data-dirty-guard>
    {version ? <input type="hidden" name="version" value={version} /> : null}
    {errors.length > 0 ? (
      <Banner kind="bad">
        <strong>Not saved.</strong> Fix the fields marked below.
      </Banner>
    ) : null}
    <div class="cairn-fields">
      {table.fields.map((field) => {
        const error = errors.find((e) => e.field === field.name)?.message;
        return (
          <>
            <label for={`f_${field.name}`} id={`f_${field.name}_label`}>
              {field.name}
              {field.required ? " *" : ""}
            </label>
            <div>
              {fieldInput(field, values[field.name], error)}
              {error ? <p class="ak-small ak-neg">{error}</p> : null}
            </div>
          </>
        );
      })}
    </div>
    <label for="note">What changed, and why (optional)</label>
    <input class="ak-input" id="note" name="note" value={note} maxlength={500} />
    <div class="cairn-actions">
      <button class="ak-btn ak-btn-primary" type="submit">
        Save
      </button>
      <a class="ak-btn" href={cancel}>
        Cancel
      </a>
    </div>
  </form>
);

// Routes.

export function registerConsole(app: Hono, options: ConsoleOptions): void {
  const { context, token } = options;
  const trust = options.trust ?? NO_LOCAL_TRUST;
  const ws = context.workspaceId;
  const expectedSession = token === null ? Promise.resolve(null) : sessionValue(token);
  const oauth = options.oauth ?? null;
  const publicOrigin = options.publicOrigin ?? null;
  // Who is signed in, per request. A person signed in through the provider is
  // named in history; the dev token and local trust write as the owner.
  const signedInAs = new WeakMap<Request, Actor>();
  const actorFor = (c: Context): Actor => signedInAs.get(c.req.raw) ?? OWNER;
  const by = (c: Context, note: string) => ({ actor: actorFor(c), note: note.trim() || null });
  const originOk = (c: Context) =>
    publicOrigin ? c.req.header("origin") === publicOrigin : isSameOrigin(c.req.raw);
  const secureCookie = (c: Context) =>
    publicOrigin ? publicOrigin.startsWith("https:") : new URL(c.req.url).protocol === "https:";

  app.get("/assets/console.css", (c) =>
    c.body(CONSOLE_CSS, 200, {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    }),
  );
  app.get("/assets/console.js", (c) =>
    c.body(CONSOLE_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    }),
  );
  app.get("/assets/favicon.svg", (c) =>
    c.body(FAVICON_SVG, 200, {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=86400",
    }),
  );
  for (const [path, png] of [["/assets/icon-180.png", ICON_180_PNG], ["/assets/icon-512.png", ICON_512_PNG]] as const) {
    app.get(path, (c) =>
      c.body(png, 200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }),
    );
  }
  app.get("/assets/manifest.webmanifest", (c) =>
    c.body(MANIFEST, 200, { "content-type": "application/manifest+json", "cache-control": "public, max-age=86400" }),
  );
  // Browsers ask for /favicon.ico whatever the page says.
  app.get("/favicon.ico", (c) => c.redirect("/assets/favicon.svg", 301));

  // Security headers on every console response, and sign-in on every console
  // route. MCP and /health have their own rules and are left alone.
  app.use("*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (/^\/(mcp|health)/.test(path) || /^\/(api|oauth|\.well-known)(\/|$)/.test(path)) return next();

    if (!PUBLIC_PATHS.some((pattern) => pattern.test(path))) {
      const cookie = getCookie(c, SESSION_COOKIE) ?? "";
      const session = await expectedSession;
      const person = oauth && cookie.includes(".") ? await oauth.verifySession(cookie) : null;
      if (person) signedInAs.set(c.req.raw, { kind: "user", id: person.id, label: person.label });
      const signedIn = person !== null || (session !== null && timingSafeEqual(cookie, session));
      // Trusted local requests skip sign-in (ADR-010). The Origin check on
      // form posts below still applies to them.
      if (!signedIn && !trustedForConsole(c.req.raw, trust)) {
        if (c.req.method !== "GET") return c.text("sign in first", 401);
        return c.redirect(`/login?next=${encodeURIComponent(path + new URL(c.req.url).search)}`);
      }
      if (c.req.method === "POST" && !originOk(c)) {
        return c.text("form posts must come from the console itself", 403);
      }
    }
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
  });

  // Sign in.

  const LoginPage: FC<{ next: string; failed?: boolean }> = ({ next, failed }) => (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        {raw(HEAD_TAGS)}
        <title>{documentTitle("Sign in")}</title>
        <link rel="stylesheet" href={`/assets/console.css?v=${ASSET_VERSION}`} />
      </head>
      <body>
        <div class="ak-wrap cairn-login">
          <p class="ak-eyebrow">Cairn review console</p>
          <h1>Sign in</h1>
          {oauth ? (
            <p class="cairn-actions">
              <a class="ak-btn ak-btn-primary" href={`/oauth/login?next=${encodeURIComponent(next)}`}>
                Sign in with {oauth.providerName}
              </a>
            </p>
          ) : (
            <p class="ak-lede">
              Dev mode: use the CAIRN_TOKEN this server was started with. On localhost no sign-in
              is needed unless local trust is turned off.
            </p>
          )}
          {failed ? <Banner kind="bad">That token does not match.</Banner> : null}
          {token === null ? null : (
          <form method="post" action="/login" class="cairn-editor">
            <input type="hidden" name="next" value={next} />
            <label for="token">Token</label>
            <input
              class="ak-input"
              id="token"
              name="token"
              type="password"
              autocomplete="current-password"
              required
            />
            <div class="cairn-actions">
              <button class="ak-btn ak-btn-primary" type="submit">
                Sign in with the token
              </button>
            </div>
          </form>
          )}
        </div>
      </body>
    </html>
  );

  app.get("/login", (c) => {
    const next = safeNext(c.req.query("next"));
    if (trustedForConsole(c.req.raw, trust)) return c.redirect(next);
    return render(c, <LoginPage next={next} />);
  });

  app.post("/login", async (c) => {
    if (!originOk(c)) return c.text("form posts must come from the console itself", 403);
    const form = await c.req.parseBody();
    const next = safeNext(text(form, "next"));
    const session = await expectedSession;
    if (token === null || session === null || !timingSafeEqual(text(form, "token"), token)) {
      return render(c, <LoginPage next={next} failed />, 400);
    }
    setCookie(c, SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      secure: secureCookie(c),
      maxAge: 60 * 60 * 24 * 30,
    });
    return c.redirect(next, 303);
  });

  app.post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.redirect("/login", 303);
  });

  // Recent changes: the console's home, and the screen for reviewing agents.

  // Home: the collections (ADR-026). A collection is a page at the top of
  // the tree, and everything under it: a wiki, with its pages and tables.
  app.get("/", async (c) => {
    const pages = await allPages(context);
    const tables = await context.tables.list(ws);
    const byId = new Map(pages.map((page) => [page.id, page]));
    const rootOf = (id: string | null): string | null => {
      let at = id ? byId.get(id) : undefined;
      for (let depth = 0; at?.parentId && byId.has(at.parentId) && depth < 64; depth += 1) at = byId.get(at.parentId);
      return at?.id ?? null;
    };
    const roots = pages
      .filter((page) => !page.parentId || !byId.has(page.parentId))
      .sort((a, b) => a.title.localeCompare(b.title));
    const pageCount = new Map<string, number>();
    for (const page of pages) {
      const root = rootOf(page.id);
      if (root && root !== page.id) pageCount.set(root, (pageCount.get(root) ?? 0) + 1);
    }
    const tableCount = new Map<string, number>();
    const loose: Table[] = [];
    for (const table of tables) {
      const root = rootOf(table.parentId);
      if (root) tableCount.set(root, (tableCount.get(root) ?? 0) + 1);
      else loose.push(table);
    }
    const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
    return render(
      c,
      <Layout title="Cairn" section="collections">
        <header class="ak-pagehead">
          <div>
            <h1>Collections</h1>
            <p class="ak-lede">Each collection is a wiki: a front page, the pages under it, and its tables.</p>
          </div>
        </header>
        {roots.length === 0 ? (
          <div class="ak-empty">
            No collections yet. A collection is a page at the top, with everything under it.{" "}
            <a href="/new">Create one</a>, or ask Claude to.
          </div>
        ) : (
          <div class="cairn-collections">
            {roots.map((root) => (
              <a class="cairn-collection" href={pageHref(root.id)}>
                <h2>{root.title}</h2>
                {summaryOf(root.body) ? <p>{summaryOf(root.body)}</p> : null}
                <p class="ak-small">
                  {plural(pageCount.get(root.id) ?? 0, "page")} · {plural(tableCount.get(root.id) ?? 0, "table")}
                </p>
              </a>
            ))}
          </div>
        )}
        {loose.length > 0 ? (
          <section class="cairn-group">
            <h2>Tables in no collection</h2>
            <ul>
              {loose.map((table) => (
                <li>
                  <a href={tableHref(table.id)}>{table.name}</a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </Layout>,
    );
  });

  // Addresses from before collections were the home (ADR-026).
  app.get("/pages", (c) => c.redirect("/", 301));
  app.get("/c", (c) => c.redirect("/t", 301));
  app.get("/c/*", (c) => c.redirect(`/t/${c.req.path.slice(3)}${new URL(c.req.url).search}`, 301));

  app.get("/changes", async (c) => {
    const who = c.req.query("who");
    const actorKind = who === "agent" ? "agent" : who === "person" ? "user" : undefined;
    const cursor = c.req.query("cursor") ?? null;
    const recent = await context.store.listRecentRevisions(ws, {
      limit: 50,
      cursor,
      ...(actorKind ? { actorKind } : {}),
    });
    const tables = new Map(
      (await context.tables.list(ws)).map((table) => [table.id, table]),
    );

    const hrefFor = (revision: Revision) =>
      revision.kind === "page"
        ? `${pageHref(revision.recordId)}/v/${encodeURIComponent(revision.version)}`
        : `/t/${encodeURIComponent(revision.tableId ?? "")}/r/${encodeURIComponent(
            rowIdOf(revision),
          )}/v/${encodeURIComponent(revision.version)}`;

    const labelFor = (revision: Revision) => {
      if (revision.kind === "page") return (revision.snapshot as PageSnapshot).title;
      const table = tables.get(revision.tableId ?? "") ?? null;
      const values = (revision.snapshot as { values: Record<string, FieldValue> }).values;
      return `${table?.name ?? "Table"}: ${rowLabel(values, table, rowIdOf(revision))}`;
    };

    const chip = (value: string | undefined, label: string) => (
      <a
        class="ak-chip"
        href={value ? `/changes?who=${value}` : "/changes"}
        aria-pressed={(who ?? "") === (value ?? "") ? "true" : "false"}
      >
        {label}
      </a>
    );

    return render(
      c,
      <Layout title="Recent changes" section="recent">
        <header class="ak-pagehead">
          <div>
            <p class="ak-eyebrow">Review</p>
            <h1>Recent changes</h1>
            <p class="ak-lede">
              Every write, newest first. Open one to see what changed and restore an earlier
              version.
            </p>
          </div>
        </header>
        <div class="ak-toolbar">
          {chip(undefined, "Everyone")}
          {chip("agent", "Agents only")}
          {chip("person", "People only")}
        </div>
        {recent.items.length === 0 ? (
          <div class="ak-empty">No changes yet.</div>
        ) : (
          <ol class="ak-timeline cairn-changes">
            {recent.items.map((revision) => (
              <li class="ak-tl-item">
                <When at={revision.createdAt} />
                <span class="ak-t">
                  <a href={hrefFor(revision)}>{labelFor(revision)}</a>
                </span>{" "}
                <span class="ak-small">
                  {revision.deleted
                    ? "deleted"
                    : revision.parentVersion === null
                      ? "created"
                      : "edited"}
                  {revision.kind === "row" ? " row" : ""}
                </span>
                <p>
                  <ActorPill actor={revision.actor} />
                </p>
                {revision.note ? <p class="cairn-note">{revision.note}</p> : null}
              </li>
            ))}
          </ol>
        )}
        {recent.cursor ? (
          <p>
            <a
              class="ak-btn"
              href={`/changes?${new URLSearchParams({
                ...(who ? { who } : {}),
                cursor: recent.cursor,
              }).toString()}`}
            >
              Older changes
            </a>
          </p>
        ) : null}
      </Layout>,
    );
  });

  const loadPage = async (c: Context): Promise<Page | null> =>
    context.store.getPage(ws, c.req.param("id") ?? "");

  const notFound = (c: Context, what: string) =>
    render(
      c,
      <Layout title="Not found" section="none">
        <div class="ak-empty">
          {what} does not exist. <a href="/pages">Browse pages</a> or search.
        </div>
      </Layout>,
      404,
    );

  app.get("/p/:id", async (c) => {
    const page = await loadPage(c);
    if (!page) {
      const history = await context.pages.history(ws, c.req.param("id"), { limit: 1 });
      if (history[0]?.deleted) {
        return c.redirect(`${pageHref(c.req.param("id"))}/history`);
      }
      return notFound(c, `Page ${c.req.param("id")}`);
    }
    const pages = await allPages(context);
    const tables = await context.tables.list(ws);
    const byId = new Map(pages.map((p) => [p.id, p]));
    const { outbound, inbound } = await context.pages.neighbours(ws, page.id);
    const linkedRows = await rowsFor(context, [...outbound.map((e) => e.targetId), ...inbound.map((e) => e.sourceId)], tables);
    const titles = resolverFor(pages, tables, linkedRows);
    const children = pages.filter((p) => p.parentId === page.id);
    const tablesHere = tables.filter((table) => table.parentId === page.id);
    const tableCounts = new Map(
      await Promise.all(tablesHere.map(async (table) => [table.id, await rowCount(context, table.id)] as const)),
    );
    const flash = c.req.query("saved")
      ? "Saved."
      : c.req.query("restored")
        ? "Restored. The restore is itself a new version, so it can be undone from history."
        : c.req.query("created")
          ? "Created."
          : null;

    return render(
      c,
      <Layout title={page.title} section="collections">
        <div class="cairn-page">
          <Tree pages={pages} tables={tables} currentId={page.id} rootId={ancestorsOf(page.id, byId)[0]?.id ?? page.id} />
          <div>
            {flash ? <Banner kind="ok">{flash}</Banner> : null}
            <ol class="ak-breadcrumb">
              {ancestorsOf(page.id, byId).map((ancestor) => (
                <li>
                  <a href={pageHref(ancestor.id)}>{ancestor.title}</a>
                </li>
              ))}
              <li aria-current="page">{page.title}</li>
            </ol>
            <header class="ak-pagehead">
              <div>
                <h1>{page.title}</h1>
                <p class="ak-small">
                  Updated <When at={page.updatedAt} /> by <ActorPill actor={page.updatedBy} />
                </p>
              </div>
              <div class="ak-row">
                <a class="ak-btn ak-btn-primary" href={`${pageHref(page.id)}/edit`}>
                  Edit
                </a>
                <a class="ak-btn" href={`${pageHref(page.id)}/history`}>
                  History
                </a>
              </div>
            </header>
            <article class="ak-prose">
              {page.body.trim() === "" ? (
                <p class="ak-soft">This page is empty.</p>
              ) : (
                raw(renderMarkdown(page.body, titles))
              )}
            </article>
            <PageTables page={page} tables={tablesHere} counts={tableCounts} others={tables.filter((c) => c.parentId !== page.id)} />
          </div>
          <aside class="cairn-rail" aria-label="About this page">
            <h3>Linked from</h3>
            <EdgeList edges={inbound} direction="in" titles={titles} />
            <h3>Links to</h3>
            <EdgeList edges={outbound} direction="out" titles={titles} />
            {children.length > 0 ? (
              <>
                <h3>Child pages</h3>
                <ul>
                  {children.map((child) => (
                    <li>
                      <a href={pageHref(child.id)}>{child.title}</a>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <h3>Tags</h3>
            {page.tags.length === 0 ? (
              <p class="ak-small">None.</p>
            ) : (
              <p>
                {page.tags.map((tag) => (
                  <>
                    <span class="ak-chip">{tag}</span>{" "}
                  </>
                ))}
              </p>
            )}
            <h3>Page</h3>
            <p class="ak-small ak-mono">{page.id}</p>
            <p>
              <a class="ak-small" href={`/new?parent=${encodeURIComponent(page.id)}`}>
                New child page
              </a>
            </p>
          </aside>
        </div>
      </Layout>,
    );
  });

  app.get("/p/:id/edit", async (c) => {
    const page = await loadPage(c);
    if (!page) return notFound(c, `Page ${c.req.param("id")}`);
    return render(
      c,
      <Layout title={`Edit ${page.title}`} section="collections">
        <p class="ak-eyebrow">Editing</p>
        <h1>{page.title}</h1>
        <PageEditor
          action={`${pageHref(page.id)}/edit`}
          title={page.title}
          tags={page.tags.join(", ")}
          body={page.body}
          note=""
          version={page.version}
          cancel={pageHref(page.id)}
        />
      </Layout>,
    );
  });

  app.post("/p/:id/edit", async (c) => {
    const page = await loadPage(c);
    if (!page) return notFound(c, `Page ${c.req.param("id")}`);
    const form = await c.req.parseBody();
    const input = {
      title: text(form, "title").trim() || page.title,
      body: text(form, "body").replace(/\r\n/g, "\n"),
      parentId: page.parentId,
      tags: parseTags(text(form, "tags")),
    };
    const note = text(form, "note");
    const version = text(form, "version");

    const editor = (props: { version: string; preview?: string; banner?: Child }) =>
      render(
        c,
        <Layout title={`Edit ${page.title}`} section="collections">
          <p class="ak-eyebrow">Editing</p>
          <h1>{page.title}</h1>
          {props.banner}
          <PageEditor
            action={`${pageHref(page.id)}/edit`}
            title={input.title}
            tags={input.tags.join(", ")}
            body={input.body}
            note={note}
            version={props.version}
            preview={props.preview}
            cancel={pageHref(page.id)}
          />
        </Layout>,
        props.banner ? 409 : 200,
      );

    if (c.req.query("preview")) {
      const titles = resolverFor(await allPages(context));
      return editor({ version, preview: renderMarkdown(input.body, titles) });
    }

    try {
      await context.pages.update(ws, page.id, input, version, by(c, note));
      return c.redirect(`${pageHref(page.id)}?saved=1`, 303);
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      // Someone else saved first. Keep this edit, show what they changed, and
      // make the next save a deliberate overwrite of their version.
      const current = error.current as Page;
      return editor({
        version: current.version,
        banner: (
          <Banner kind="bad">
            <p>
              <strong>Not saved: this page changed while you were editing.</strong>{" "}
              <ActorPill actor={current.updatedBy} /> saved it <When at={current.updatedAt} />.
              Your text is still below. The difference from their version is shown here;
              saving again replaces their version with yours, and theirs stays in history.
            </p>
            <DiffView diff={diffLines(current.body, input.body)} />
          </Banner>
        ),
      });
    }
  });

  app.get("/p/:id/history", async (c) => {
    const id = c.req.param("id");
    const page = await context.store.getPage(ws, id);
    const history = await context.pages.history(ws, id, { limit: 100 });
    if (!page && history.length === 0) return notFound(c, `Page ${id}`);
    const title = page?.title ?? (history[0]?.snapshot as PageSnapshot | undefined)?.title ?? id;

    return render(
      c,
      <Layout title={`History of ${title}`} section="collections">
        <p class="ak-eyebrow">History</p>
        <h1>{page ? <a href={pageHref(id)}>{title}</a> : title}</h1>
        {page ? null : (
          <Banner>This page was deleted. Its history is kept, and any version can be read.</Banner>
        )}
        <RevisionTimeline
          revisions={history}
          currentVersion={page?.version ?? null}
          hrefFor={(revision) => `${pageHref(id)}/v/${encodeURIComponent(revision.version)}`}
        />
      </Layout>,
    );
  });

  app.get("/p/:id/v/:version", async (c) => {
    const id = c.req.param("id");
    let view;
    try {
      view = await context.pages.revision(ws, id, c.req.param("version"));
    } catch (error) {
      if (error instanceof NotFoundError) return notFound(c, "That version");
      throw error;
    }
    const page = await context.store.getPage(ws, id);
    const titles = resolverFor(await allPages(context));
    const isCurrent = page?.version === view.revision.version;

    return render(
      c,
      <Layout title={`${view.snapshot.title}, earlier version`} section="collections">
        <p class="ak-eyebrow">
          <a href={`${pageHref(id)}/history`}>History</a> · version{" "}
          <span class="ak-mono">{view.revision.version.slice(0, 8)}</span>
        </p>
        <header class="ak-pagehead">
          <div>
            <h1>{view.snapshot.title}</h1>
            <p class="ak-small">
              <When at={view.revision.createdAt} /> by <ActorPill actor={view.revision.actor} />
              {isCurrent ? (
                <>
                  {" "}
                  <span class="ak-pill ak-pill-ok">current</span>
                </>
              ) : null}
            </p>
            {view.revision.note ? <p class="cairn-note">{view.revision.note}</p> : null}
          </div>
          {page && !isCurrent && !view.revision.deleted ? (
            <form
              method="post"
              action={`${pageHref(id)}/restore/${encodeURIComponent(view.revision.version)}`}
            >
              <input type="hidden" name="expected" value={page.version} />
              <button class="ak-btn ak-btn-primary" type="submit">
                Restore this version
              </button>
            </form>
          ) : null}
        </header>
        <h2>What changed</h2>
        {view.diff ? (
          <>
            {view.titleChanged ? <p class="ak-small">The title changed too.</p> : null}
            {view.tagsChanged ? <p class="ak-small">The tags changed too.</p> : null}
            <DiffView diff={view.diff} />
          </>
        ) : (
          <p class="ak-small">This is the first recorded version.</p>
        )}
        <details class="ak-disclosure">
          <summary>The page as it was at this version</summary>
          <article class="ak-prose">{raw(renderMarkdown(view.snapshot.body, titles))}</article>
        </details>
      </Layout>,
    );
  });

  app.post("/p/:id/restore/:version", async (c) => {
    const id = c.req.param("id");
    const form = await c.req.parseBody();
    try {
      await context.pages.restore(ws, id, c.req.param("version"), text(form, "expected"), {
        actor: actorFor(c),
      });
      return c.redirect(`${pageHref(id)}?restored=1`, 303);
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      return render(
        c,
        <Layout title="Not restored" section="collections">
          <Banner kind="bad">
            <strong>Not restored: the page changed since you opened this version.</strong>{" "}
            <a href={`${pageHref(id)}/history`}>Look at its history again</a> before restoring.
          </Banner>
        </Layout>,
        409,
      );
    }
  });

  app.get("/new", async (c) => {
    const pages = await allPages(context);
    const parent = c.req.query("parent") ?? null;
    return render(
      c,
      <Layout title="New page" section="collections">
        <p class="ak-eyebrow">New page</p>
        <h1>New page</h1>
        <PageEditor
          action="/new"
          title=""
          tags=""
          body=""
          note=""
          parentId={parent}
          pages={pages}
          cancel={parent ? pageHref(parent) : "/pages"}
        />
      </Layout>,
    );
  });

  app.post("/new", async (c) => {
    const form = await c.req.parseBody();
    const input = {
      title: text(form, "title").trim(),
      body: text(form, "body").replace(/\r\n/g, "\n"),
      parentId: text(form, "parent") || null,
      tags: parseTags(text(form, "tags")),
    };
    const note = text(form, "note");
    if (c.req.query("preview") || input.title === "") {
      const pages = await allPages(context);
      return render(
        c,
        <Layout title="New page" section="collections">
          <p class="ak-eyebrow">New page</p>
          <h1>New page</h1>
          {input.title === "" && !c.req.query("preview") ? (
            <Banner kind="bad">A page needs a title.</Banner>
          ) : null}
          <PageEditor
            action="/new"
            title={input.title}
            tags={input.tags.join(", ")}
            body={input.body}
            note={note}
            parentId={input.parentId}
            pages={pages}
            preview={renderMarkdown(input.body, resolverFor(pages))}
            cancel="/pages"
          />
        </Layout>,
        input.title === "" ? 400 : 200,
      );
    }
    const page = await context.pages.create(ws, input, by(c, note));
    return c.redirect(`${pageHref(page.id)}?created=1`, 303);
  });

  // Search.

  app.get("/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const result = q ? await context.search.search(ws, { query: q, limit: 30 }) : null;
    const titles = resolverFor(await allPages(context));

    // Snippets mark matches with [ ]. Escape everything, then turn only
    // those markers into <mark>, so no page text is ever treated as markup.
    const highlight = (snippet: string) =>
      raw(
        snippet
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/\[([^\]]*)\]/g, "<mark>$1</mark>"),
      );

    return render(
      c,
      <Layout title={q ? `Search: ${q}` : "Search"} section="search" query={q}>
        <p class="ak-eyebrow">Search</p>
        <h1>{q ? `Results for “${q}”` : "Search"}</h1>
        {result ? (
          <p class="ak-small">
            {result.hits.length} matches, {result.mode} mode.
          </p>
        ) : null}
        {result && result.hits.length === 0 ? (
          <div class="ak-empty">Nothing matched. Try fewer words, or a synonym.</div>
        ) : null}
        {result?.hits.map((hit) => (
          <div class="cairn-hit">
            <a href={pageHref(hit.pageId)}>
              <strong>{titles.title(hit.pageId) ?? hit.pageId}</strong>
            </a>
            <p class="ak-small">{hit.headingPath.slice(1).join(" › ")}</p>
            <p>{highlight(hit.snippet)}</p>
          </div>
        ))}
      </Layout>,
    );
  });

  // Tables.

  app.get("/t", async (c) => {
    const tables = await context.tables.list(ws);
    const pages = await allPages(context);
    const byId = new Map(pages.map((page) => [page.id, page]));
    const counts = new Map(
      await Promise.all(tables.map(async (table) => [table.id, await rowCount(context, table.id)] as const)),
    );
    // Grouped by the page each table sits under (ADR-024): the roots,
    // by title, then the tables under no page.
    const groups = new Map<string | null, Table[]>();
    for (const table of tables) {
      const parent = table.parentId && byId.has(table.parentId) ? table.parentId : null;
      groups.set(parent, [...(groups.get(parent) ?? []), table]);
    }
    const roots = [...groups.keys()]
      .filter((id): id is string => id !== null)
      .sort((a, b) => byId.get(a)!.title.localeCompare(byId.get(b)!.title));
    const order: Array<string | null> = [...roots, ...(groups.has(null) ? [null] : [])];

    const tableOf = (list: Table[]) => (
      <div class="ak-tblwrap">
        <table class="ak-table">
          <thead>
            <tr>
              <th>Name</th>
              <th class="ak-num">Rows</th>
              <th>Fields</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {[...list]
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((table) => (
                <tr>
                  <td>
                    <a href={tableHref(table.id)}>{table.name}</a>
                  </td>
                  <td class="ak-num">{counts.get(table.id)}</td>
                  <td>{table.fields.map((field) => field.name).join(", ")}</td>
                  <td>
                    <When at={table.updatedAt} />
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    );

    return render(
      c,
      <Layout title="Tables" section="tables">
        <header class="ak-pagehead">
          <div>
            <p class="ak-eyebrow">Browse</p>
            <h1>Tables</h1>
            <p class="ak-lede">Grouped under the page each one sits in. A page shows its tables below its text.</p>
          </div>
        </header>
        {tables.length === 0 ? (
          <div class="ak-empty">No tables yet. Ask Claude to create one.</div>
        ) : (
          order.map((root) => (
            <section class="cairn-group">
              {root === null ? (
                <h2>Not in any collection</h2>
              ) : (
                <>
                  <ol class="ak-breadcrumb">
                    {ancestorsOf(root, byId).map((ancestor) => (
                      <li>
                        <a href={pageHref(ancestor.id)}>{ancestor.title}</a>
                      </li>
                    ))}
                  </ol>
                  <h2>
                    <a href={pageHref(root)}>{byId.get(root)!.title}</a>
                  </h2>
                </>
              )}
              {tableOf(groups.get(root)!)}
            </section>
          ))
        )}
      </Layout>,
    );
  });

  const loadTable = (c: Context) => context.store.getTable(ws, c.req.param("cid") ?? "");

  const cell = (field: FieldDef, value: FieldValue | undefined, links: LinkResolver): Child => {
    if (value === undefined || value === null || value === "") return <span class="ak-dash">–</span>;
    if (field.type === "checkbox") return value ? "yes" : "no";
    if (field.type === "relation") {
      const target = relationTarget(field);
      const ids = Array.isArray(value) ? value : [String(value)];
      return ids.map((id, i) => {
        const node = target === "pages" ? id : rowNodeId(target, id);
        const name = links.title(node);
        return (
          <>
            {i > 0 ? ", " : null}
            <a href={links.href?.(node) ?? pageHref(id)} class={name === null ? "cairn-missing" : undefined}>
              {name === null ? id : target === "pages" ? name : name.slice(name.indexOf(": ") + 2)}
            </a>
          </>
        );
      });
    }
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  };

  app.get("/t/:cid", async (c) => {
    const table = await loadTable(c);
    if (!table) return notFound(c, `Table ${c.req.param("cid")}`);
    const rows = await context.tables.queryRows(ws, table.id, { limit: 500 });
    const base = `/t/${encodeURIComponent(table.id)}`;
    const pages = await allPages(context);
    const tables = await context.tables.list(ws);
    const links = resolverFor(pages, tables, await targetRows(context, table, tables));
    const byId = new Map(pages.map((p) => [p.id, p]));
    const parent = table.parentId ? byId.get(table.parentId) : undefined;
    const backlinks = await context.tables.backlinks(ws, table.id);
    const moved = c.req.query("moved");
    return render(
      c,
      <Layout title={table.name} section="tables">
        {moved ? <Banner kind="ok">{parent ? `Moved under ${parent.title}.` : "Moved to the top."}</Banner> : null}
        <header class="ak-pagehead">
          <div>
            <ol class="ak-breadcrumb">
              {parent ? (
                [...ancestorsOf(parent.id, byId), parent].map((ancestor) => (
                  <li>
                    <a href={pageHref(ancestor.id)}>{ancestor.title}</a>
                  </li>
                ))
              ) : (
                <li>
                  <a href="/t">Tables</a>
                </li>
              )}
              <li aria-current="page">{table.name}</li>
            </ol>
            <h1>{table.name}</h1>
            <p class="ak-small">
              {rows.items.length}
              {rows.cursor ? "+" : ""} rows. Click a column to sort.
            </p>
          </div>
          <div class="ak-row">
            <input
              class="ak-input"
              type="search"
              id="rowfilter"
              placeholder="Filter rows"
              aria-label="Filter rows"
            />
            <a class="ak-btn ak-btn-primary" href={`${base}/new`}>
              New row
            </a>
          </div>
        </header>
        {rows.items.length === 0 ? (
          <div class="ak-empty">No rows yet.</div>
        ) : (
          <div class="ak-tblwrap">
            <table class="ak-table" data-ak-table data-filter="rowfilter">
              <thead>
                <tr>
                  {table.fields.map((field) => (
                    <th
                      data-sort={field.type === "number" ? "n" : "s"}
                      class={field.type === "number" ? "ak-num" : undefined}
                    >
                      {field.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.items.map((row) => (
                  <tr>
                    {table.fields.map((field, i) => (
                      <td
                        class={field.type === "number" ? "ak-num" : undefined}
                        data-v={
                          typeof row.values[field.name] === "number"
                            ? String(row.values[field.name])
                            : undefined
                        }
                      >
                        {i === 0 && field.type !== "relation" ? (
                          <a href={`${base}/r/${encodeURIComponent(row.id)}`}>
                            {cell(field, row.values[field.name], links) ?? row.id}
                          </a>
                        ) : (
                          cell(field, row.values[field.name], links)
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p class="ak-empty" data-ak-empty hidden>
              No rows match the filter.
            </p>
          </div>
        )}
        <div class="ak-split">
          <section>
            <h2>Linked from</h2>
            <EdgeList edges={backlinks} direction="in" titles={links} />
          </section>
          <section>
            <h2>Place in the tree</h2>
            <form method="post" action={`${base}/move`} class="cairn-editor">
              <input type="hidden" name="version" value={table.version} />
              <label for="parent">Under</label>
              <select class="ak-select" id="parent" name="parent">
                <option value="" selected={!table.parentId}>
                  The top, with no page
                </option>
                {[...pages]
                  .sort((a, b) => a.title.localeCompare(b.title))
                  .map((page) => (
                    <option value={page.id} selected={page.id === table.parentId}>
                      {page.title}
                    </option>
                  ))}
              </select>
              <label for="move_note">Why (optional)</label>
              <input class="ak-input" id="move_note" name="note" type="text" />
              <div class="cairn-actions">
                <button class="ak-btn" type="submit">
                  Move
                </button>
                <span class="ak-small">Only its place changes; its rows stay as they are.</span>
              </div>
            </form>
          </section>
        </div>
      </Layout>,
    );
  });

  app.post("/t/:cid/move", async (c) => {
    const table = await loadTable(c);
    if (!table) return notFound(c, `Table ${c.req.param("cid")}`);
    const form = await c.req.parseBody();
    const parent = text(form, "parent").trim();
    try {
      await moveRecord(context, table.id, parent === "" ? null : parent, text(form, "version"), by(c, text(form, "note")));
    } catch (error) {
      if (!(error instanceof VersionConflictError) && !(error instanceof ValidationError)) throw error;
      return render(
        c,
        <Layout title="Not moved" section="tables">
          <Banner kind="bad">
            <strong>Not moved.</strong>{" "}
            {error instanceof VersionConflictError
              ? "The table changed since you opened it."
              : error.errors.map((e) => e.message).join("; ")}{" "}
            <a href={tableHref(table.id)}>Back to {table.name}</a>
          </Banner>
        </Layout>,
        409,
      );
    }
    return c.redirect(`${tableHref(table.id)}?moved=1`, 303);
  });

  // From a page: put a table under it (ADR-024).
  app.post("/p/:id/tables", async (c) => {
    const page = await loadPage(c);
    if (!page) return notFound(c, `Page ${c.req.param("id")}`);
    const form = await c.req.parseBody();
    const [tableId = "", version = ""] = text(form, "table").split("@");
    try {
      await moveRecord(context, tableId, page.id, version, by(c, text(form, "note")));
    } catch (error) {
      if (!(error instanceof VersionConflictError) && !(error instanceof ValidationError) && !(error instanceof NotFoundError)) throw error;
      return render(
        c,
        <Layout title="Not moved" section="collections">
          <Banner kind="bad">
            <strong>Not moved.</strong>{" "}
            {error instanceof ValidationError ? error.errors.map((e) => e.message).join("; ") : "The table changed or is gone since you opened this page."}{" "}
            <a href={pageHref(page.id)}>Back to {page.title}</a>
          </Banner>
        </Layout>,
        409,
      );
    }
    return c.redirect(`${pageHref(page.id)}?saved=1`, 303);
  });

  const RowPage: FC<{
    table: Table;
    row: Row | null;
    values: Record<string, FieldValue>;
    errors: FieldError[];
    note: string;
    history: Revision[];
    flash?: string | null | undefined;
    notice?: Child;
    version?: string | undefined;
    links?: { outbound: Edge[]; inbound: Edge[]; resolver: LinkResolver } | undefined;
  }> = ({ table, row, values, errors, note, history, flash, notice, version, links }) => {
    const base = `/t/${encodeURIComponent(table.id)}`;
    const title = row ? rowLabel(row.values, table, row.id) : "New row";
    return (
      <Layout title={`${table.name}: ${title}`} section="tables">
        <p class="ak-eyebrow">
          <a href="/t">Tables</a> · <a href={base}>{table.name}</a>
        </p>
        <h1>{title}</h1>
        {flash ? <Banner kind="ok">{flash}</Banner> : null}
        {notice}
        {row ? (
          <p class="ak-small">
            Updated <When at={row.updatedAt} /> by <ActorPill actor={row.updatedBy} />
          </p>
        ) : null}
        <div class="ak-split">
          <RowForm
            table={table}
            action={row ? `${base}/r/${encodeURIComponent(row.id)}` : `${base}/new`}
            values={values}
            errors={errors}
            version={version ?? row?.version}
            note={note}
            cancel={base}
          />
          {row ? (
            <section>
              {links ? (
                <>
                  <h2>Links</h2>
                  <EdgeList edges={links.outbound} direction="out" titles={links.resolver} />
                  <h2>Linked from</h2>
                  <EdgeList edges={links.inbound} direction="in" titles={links.resolver} />
                </>
              ) : null}
              <h2>History</h2>
              <RevisionTimeline
                revisions={history}
                currentVersion={row.version}
                hrefFor={(revision) =>
                  `${base}/r/${encodeURIComponent(row.id)}/v/${encodeURIComponent(revision.version)}`
                }
              />
            </section>
          ) : null}
        </div>
      </Layout>
    );
  };

  app.get("/t/:cid/new", async (c) => {
    const table = await loadTable(c);
    if (!table) return notFound(c, `Table ${c.req.param("cid")}`);
    return render(
      c,
      <RowPage table={table} row={null} values={{}} errors={[]} note="" history={[]} />,
    );
  });

  app.post("/t/:cid/new", async (c) => {
    const table = await loadTable(c);
    if (!table) return notFound(c, `Table ${c.req.param("cid")}`);
    const form = await c.req.parseBody({ all: true });
    const values = readRowValues(table, form);
    const note = text(form, "note");
    try {
      const row = await context.tables.upsertRow(ws, table.id, { values }, by(c, note));
      return c.redirect(
        `/t/${encodeURIComponent(table.id)}/r/${encodeURIComponent(row.id)}?saved=1`,
        303,
      );
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return render(
        c,
        <RowPage
          table={table}
          row={null}
          values={values}
          errors={error.errors}
          note={note}
          history={[]}
        />,
        400,
      );
    }
  });

  app.get("/t/:cid/r/:rid", async (c) => {
    const table = await loadTable(c);
    if (!table) return notFound(c, `Table ${c.req.param("cid")}`);
    const row = await context.store.getRow(ws, table.id, c.req.param("rid"));
    if (!row) return notFound(c, `Row ${c.req.param("rid")}`);
    const history = await context.tables.rowHistory(ws, table.id, row.id, {
      limit: 50,
    });
    const flash = c.req.query("saved")
      ? "Saved."
      : c.req.query("restored")
        ? "Restored, as a new version."
        : null;
    const [outbound, inbound, tables] = await Promise.all([
      context.tables.rowLinks(ws, table.id, row.id),
      context.tables.rowBacklinks(ws, table.id, row.id),
      context.tables.list(ws),
    ]);
    const linked = await rowsFor(context, [...outbound.map((e) => e.targetId), ...inbound.map((e) => e.sourceId)], tables);
    const resolver = resolverFor(await allPages(context), tables, linked);
    return render(
      c,
      <RowPage
        table={table}
        row={row}
        values={row.values}
        errors={[]}
        note=""
        history={history}
        flash={flash}
        links={{ outbound, inbound, resolver }}
      />,
    );
  });

  app.post("/t/:cid/r/:rid", async (c) => {
    const table = await loadTable(c);
    if (!table) return notFound(c, `Table ${c.req.param("cid")}`);
    const row = await context.store.getRow(ws, table.id, c.req.param("rid"));
    if (!row) return notFound(c, `Row ${c.req.param("rid")}`);
    const form = await c.req.parseBody({ all: true });
    const values = readRowValues(table, form);
    const note = text(form, "note");
    const history = () => context.tables.rowHistory(ws, table.id, row.id, { limit: 50 });

    try {
      await context.tables.upsertRow(ws, table.id, { values }, by(c, note), {
        id: row.id,
        expectedVersion: text(form, "version"),
      });
      return c.redirect(
        `/t/${encodeURIComponent(table.id)}/r/${encodeURIComponent(row.id)}?saved=1`,
        303,
      );
    } catch (error) {
      if (error instanceof ValidationError) {
        return render(
          c,
          <RowPage
            table={table}
            row={row}
            values={values}
            errors={error.errors}
            note={note}
            history={await history()}
            version={text(form, "version")}
          />,
          400,
        );
      }
      if (error instanceof VersionConflictError) {
        const current = error.current as Row;
        return render(
          c,
          <RowPage
            table={table}
            row={current}
            values={values}
            errors={[]}
            note={note}
            history={await history()}
            version={current.version}
            notice={
              <Banner kind="bad">
                <strong>Not saved: this row changed while you were editing.</strong>{" "}
                <ActorPill actor={current.updatedBy} /> saved it <When at={current.updatedAt} />.
                Your values are still in the form; saving again replaces theirs, and theirs stay
                in history.
              </Banner>
            }
          />,
          409,
        );
      }
      throw error;
    }
  });

  app.get("/t/:cid/r/:rid/v/:version", async (c) => {
    const table = await loadTable(c);
    if (!table) return notFound(c, `Table ${c.req.param("cid")}`);
    const rowId = c.req.param("rid");
    let view;
    try {
      view = await context.tables.rowRevision(ws, table.id, rowId, c.req.param("version"));
    } catch (error) {
      if (error instanceof NotFoundError) return notFound(c, "That version");
      throw error;
    }
    const row = await context.store.getRow(ws, table.id, rowId);
    const base = `/t/${encodeURIComponent(table.id)}/r/${encodeURIComponent(rowId)}`;
    const isCurrent = row?.version === view.revision.version;
    return render(
      c,
      <Layout title={`${table.name}, earlier version`} section="tables">
        <p class="ak-eyebrow">
          <a href={`/t/${encodeURIComponent(table.id)}`}>{table.name}</a> ·{" "}
          <a href={base}>{rowLabel(view.snapshot.values, table, rowId)}</a> · version{" "}
          <span class="ak-mono">{view.revision.version.slice(0, 8)}</span>
        </p>
        <header class="ak-pagehead">
          <div>
            <h1>{rowLabel(view.snapshot.values, table, rowId)}</h1>
            <p class="ak-small">
              <When at={view.revision.createdAt} /> by <ActorPill actor={view.revision.actor} />
              {isCurrent ? (
                <>
                  {" "}
                  <span class="ak-pill ak-pill-ok">current</span>
                </>
              ) : null}
            </p>
            {view.revision.note ? <p class="cairn-note">{view.revision.note}</p> : null}
          </div>
          {row && !isCurrent && !view.revision.deleted ? (
            <form method="post" action={`${base}/restore/${encodeURIComponent(view.revision.version)}`}>
              <input type="hidden" name="expected" value={row.version} />
              <button class="ak-btn ak-btn-primary" type="submit">
                Restore this version
              </button>
            </form>
          ) : null}
        </header>
        <h2>What changed</h2>
        {view.diff ? (
          <DiffView diff={view.diff} />
        ) : (
          <p class="ak-small">This is the first recorded version.</p>
        )}
      </Layout>,
    );
  });

  app.post("/t/:cid/r/:rid/restore/:version", async (c) => {
    const cid = c.req.param("cid");
    const rid = c.req.param("rid");
    const form = await c.req.parseBody();
    try {
      await context.tables.restoreRow(
        ws,
        cid,
        rid,
        c.req.param("version"),
        text(form, "expected"),
        { actor: actorFor(c) },
      );
      return c.redirect(`/t/${encodeURIComponent(cid)}/r/${encodeURIComponent(rid)}?restored=1`, 303);
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      return render(
        c,
        <Layout title="Not restored" section="tables">
          <Banner kind="bad">
            <strong>Not restored: the row changed since you opened this version.</strong>
          </Banner>
        </Layout>,
        409,
      );
    }
  });

  // Any other address the console does not know gets a page, not bare text.
  // The API, MCP and OAuth routes answer their own misses before this.
  app.notFound((c) => notFound(c, "That address"));
}
