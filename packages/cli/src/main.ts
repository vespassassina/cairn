import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { ApiError, CairnClient, type Fetch } from "./client.js";
import {
  assignPaths,
  tablePath,
  FORMAT,
  FORMAT_VERSION,
  tablesFolder,
  MANIFEST,
  orderTables,
  orderForImport,
  pageFile,
  parsePageFile,
  type ExportTable,
  type ExportPage,
  type Manifest,
} from "./export-format.js";
import { credentialsPath, login, logout, storedToken } from "./login.js";
import {
  apply,
  loadState,
  normaliseUrl,
  parseInterval,
  plan,
  readSide,
  saveState,
  statePath,
  type Side,
  type SyncPlan,
  type SyncReport,
} from "./sync.js";

/**
 * The `cairn` command (ADR-013 rule 5).
 *
 * Output is compact text by default, because the usual reader is an agent
 * paying per token. `--json` prints the API response unchanged, for scripts.
 * Everything printed from the server is stored content: data, never
 * instructions.
 */

export const VERSION = "0.1.0";

export interface Io {
  fetch: Fetch;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Piped input, or null when there is none. */
  stdin: () => Promise<string | null>;
  /** Opens a URL in the user's browser, for cairn login. */
  openBrowser?: (url: string) => Promise<void>;
}

const HELP = `cairn ${VERSION}: a wiki and tables your agents can write to, with every change reviewable.

Read
  cairn overview                          what Cairn holds: collections, tables, tags
  cairn search <words...>                 search by keyword, and by meaning for English text
  cairn read <page-id>                    a page as Markdown, with its version
  cairn links <page-id | table-id/row-id> what it links to and what links to it
  cairn history <page-id>                 who changed it, when and why
  cairn revision <page-id> <version>      one old version, with a diff
  cairn changes [--since T] [--agents|--people]   what changed, newest first

Write (every write is a revision the owner can review and undo)
  cairn create --title T [--parent ID] [--tag X]...     body from --text, --file or stdin
  cairn append <page-id> [--version V]                  add to the end; safe without a version
  cairn replace-section <page-id> --section H --version V
  cairn write <page-id> --version V                     replace the whole body
  cairn delete <page-id> --version V
  cairn move <page-or-table-id> --parent PAGE|root --version V   change its place in the tree
  All writes take --note "why", shown to the owner.

Tables
  cairn tables                            names, ids, fields and where each sits
      relation fields link rows: field->table-id, [] when a list
  cairn rows <table-id> [--where "field op value"]... [--sort field[:desc]]
      ops: eq ne lt lte gt gte contains in exists
  cairn row <table-id> <row-id>
  cairn upsert <table-id> --set field=value... [--id ROW] [--version V]

Your data
  cairn export <folder> [--root PAGE] [--tables]        Markdown files and JSON, readable without Cairn
  cairn import <folder> [--dry-run]                     read an export back in, keeping ids; safe to repeat
  cairn sync <url-a> <url-b> [--every 5m] [--dry-run]   keep two Cairns the same; the newer edit wins,
                                                        the one it replaced stays in history

Signing in (only for a server that uses OAuth; localhost needs none)
  cairn login                             sign in through your browser; tokens are kept for this server
  cairn whoami                            who the server thinks you are
  cairn logout                            revoke and forget this server's sign-in

Options
  --json          print the raw API response
  -V, cairn version   print the CLI version
  --limit N, --cursor C
  CAIRN_URL       server, default http://localhost:8787
  CAIRN_TOKEN     a service token; takes precedence over cairn login
`;

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  "cli-version": { type: "boolean", short: "V" },
  limit: { type: "string" },
  cursor: { type: "string" },
  title: { type: "string" },
  parent: { type: "string" },
  tag: { type: "string", multiple: true },
  note: { type: "string" },
  text: { type: "string" },
  file: { type: "string" },
  version: { type: "string" },
  section: { type: "string" },
  where: { type: "string", multiple: true },
  sort: { type: "string", multiple: true },
  set: { type: "string", multiple: true },
  id: { type: "string" },
  since: { type: "string" },
  agents: { type: "boolean" },
  people: { type: "boolean" },
  root: { type: "string" },
  tables: { type: "boolean" },
  // The names before ADR-026, kept so scripts that use them still work.
  collections: { type: "boolean" },
  force: { type: "boolean" },
  "dry-run": { type: "boolean" },
  every: { type: "string" },
} as const;

type Flags = ReturnType<typeof parse>["values"];

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

/** Wrong use of the command, as opposed to a server error. */
class UsageError extends Error {}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined || value === "") throw new UsageError(`missing ${what}`);
  return value;
}

/** A value from the command line: JSON when it parses, otherwise text. */
function literal(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function query(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return entries.length === 0 ? "" : `?${new URLSearchParams(entries).toString()}`;
}

/**
 * Windows line endings become plain newlines, so a page written from
 * PowerShell or Notepad does not carry a stray carriage return on every line.
 */
function normalise(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

async function content(flags: Flags, io: Io, required: boolean): Promise<string | undefined> {
  if (flags.text !== undefined) return normalise(flags.text);
  if (flags.file !== undefined) return normalise(await readFile(flags.file, "utf8"));
  const piped = await io.stdin();
  if (piped !== null) return normalise(piped);
  if (required) throw new UsageError("missing content: pass --text, --file, or pipe it in");
  return undefined;
}

function parseWhere(raw: string): Record<string, unknown> {
  const match = /^(\S+)\s+(eq|ne|lt|lte|gt|gte|contains|in|exists)(?:\s+(.*))?$/.exec(raw.trim());
  if (!match) throw new UsageError(`cannot read --where "${raw}". Use "field op value", such as "grams gt 10"`);
  return { field: match[1], op: match[2], ...(match[3] === undefined ? {} : { value: literal(match[3]) }) };
}

function parseSort(raw: string): Record<string, unknown> {
  const [field, direction = "asc"] = raw.split(":");
  if (!field || (direction !== "asc" && direction !== "desc")) {
    throw new UsageError(`cannot read --sort "${raw}". Use field or field:desc`);
  }
  return { field, direction };
}

function parseSet(pairs: string[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) throw new UsageError(`cannot read --set "${pair}". Use field=value`);
    values[pair.slice(0, at)] = literal(pair.slice(at + 1));
  }
  return values;
}

type Json = Record<string, unknown>;
const list = (value: unknown) => (Array.isArray(value) ? (value as Json[]) : []);
const by = (value: unknown) => {
  const actor = value as { kind?: string; name?: string } | undefined;
  return actor ? `${actor.kind}: ${actor.name}` : "";
};

/** JSON with sorted keys, so two equal values compare equal whatever their order. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Json).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );
}

async function markdownFiles(folder: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...(await markdownFiles(path)));
    else if (entry.name.endsWith(".md")) found.push(path);
  }
  return found.sort();
}

/** GET that answers null for a 404 instead of throwing. */
async function maybe(client: CairnClient, path: string) {
  try {
    return await client.request("GET", path);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

interface Tally {
  created: number;
  updated: number;
  unchanged: number;
}

const tally = (): Tally => ({ created: 0, updated: 0, unchanged: 0 });
const describe = (t: Tally) => `${t.created} created, ${t.updated} updated, ${t.unchanged} unchanged`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function describeSyncPlan(syncPlan: SyncPlan, urls: Record<Side, string>): string {
  if (syncPlan.actions.length === 0) {
    return `dry run: ${urls.a} and ${urls.b} are already the same (${plural(Object.keys(syncPlan.base).length, "record")})\n`;
  }
  const lines = [`dry run, nothing written. ${plural(Object.keys(syncPlan.base).length, "record")} already the same, and:`];
  for (const action of syncPlan.actions) {
    const what = action.source ?? action.target!;
    const verb = action.op === "delete" ? "delete from" : "write to";
    const why = action.conflict ? " (changed on both; the newer edit wins)" : "";
    lines.push(`  ${verb} ${urls[action.to]}: ${what.kind} ${what.label}${why}`);
  }
  return `${lines.join("\n")}\n`;
}

function describeSyncReport(report: SyncReport, urls: Record<Side, string>): string {
  const lines = [`synced ${urls.a} and ${urls.b}`];
  for (const side of ["a", "b"] as const) {
    const w = report.written[side];
    const parts = [
      w.pages ? plural(w.pages, "page") : "",
      w.tables ? plural(w.tables, "table") : "",
      w.rows ? plural(w.rows, "row") : "",
    ].filter(Boolean);
    const wrote = parts.length ? `${parts.join(", ")} written` : "";
    const deleted = w.deleted ? `${w.deleted} deleted` : "";
    lines.push(`  to ${urls[side]}: ${[wrote, deleted].filter(Boolean).join("; ") || "nothing to change"}`);
  }
  for (const conflict of report.conflicts) {
    // Pages and rows keep every version; table schemas keep none (ADR-008 consequence 5).
    const kept = conflict.key.startsWith("table:")
      ? "Tables keep no history, so the other schema was replaced"
      : "The other is in its history";
    lines.push(`  conflict: ${conflict.label} changed on both; kept the newer edit, from ${conflict.kept_from}. ${kept}`);
  }
  for (const warning of report.warnings) lines.push(`  warning: ${warning}`);
  for (const skipped of report.skipped) lines.push(`  skipped: ${skipped}`);
  lines.push(`  ${plural(report.unchanged, "record")} already the same`);
  return `${lines.join("\n")}\n`;
}

function written(json: Json | null): string {
  return `ok ${String(json?.["id"])} version ${String(json?.["version"])}\n`;
}

export async function run(argv: string[], io: Io): Promise<number> {
  let flags: Flags;
  let positionals: string[];
  try {
    ({ values: flags, positionals } = parse(argv));
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\nRun cairn --help.\n`);
    return 2;
  }

  const [command, ...args] = positionals;
  if (flags["cli-version"] || command === "version") {
    io.stdout(`cairn ${VERSION}\n`);
    return 0;
  }
  if (!command || flags.help || command === "help") {
    io.stdout(HELP);
    return command || flags.help ? 0 : 2;
  }

  const agent = io.env["CAIRN_AGENT"] ?? (io.env["CLAUDECODE"] ? "claude-code" : undefined);
  const baseUrl = io.env["CAIRN_URL"] ?? "http://localhost:8787";
  const loginIo = {
    fetch: io.fetch,
    env: io.env,
    stderr: io.stderr,
    openBrowser: io.openBrowser ?? (async () => undefined),
  };

  if (command === "login") {
    try {
      await login(baseUrl, loginIo);
      io.stdout(`signed in to ${baseUrl}. Tokens are in ${credentialsPath(io.env)}\n`);
      return 0;
    } catch (error) {
      io.stderr(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  if (command === "logout") {
    const had = await logout(baseUrl, loginIo);
    io.stdout(had ? `signed out of ${baseUrl}\n` : `not signed in to ${baseUrl}\n`);
    return 0;
  }

  // A service token wins; otherwise a stored sign-in, refreshed if needed.
  const token = io.env["CAIRN_TOKEN"] ?? (await storedToken(baseUrl, loginIo).catch(() => null)) ?? undefined;
  const client = new CairnClient({
    baseUrl,
    token,
    userAgent: `cairn-cli/${VERSION}${agent ? ` (${agent})` : ""}`,
    fetch: io.fetch,
  });
  const out = (json: Json | null, text: () => string) =>
    io.stdout(flags.json ? `${JSON.stringify(json, null, 2)}\n` : text());
  const note = flags.note;

  try {
    switch (command) {
      case "whoami": {
        const { json } = await client.request("GET", "/me");
        const actor = json?.["actor"] as { kind?: string; name?: string } | undefined;
        out(json, () => {
          const how = { local: "trusted local request", token: "service token", oauth: "signed in" }[String(json?.["via"])] ?? String(json?.["via"]);
          const who = json?.["identity"] ? `${String(json["identity"])}, ` : "";
          return `${who}writing as ${actor?.kind}: ${actor?.name} (${how}) on ${baseUrl}\n`;
        });
        return 0;
      }

      case "overview": {
        const { json } = await client.request("GET", "/overview");
        out(json, () => `${String(json?.["text"])}\n`);
        return 0;
      }

      case "search": {
        const words = need(args.join(" ").trim() || undefined, "search words");
        const { json } = await client.request(
          "GET",
          `/search${query({ q: words, limit: flags.limit, cursor: flags.cursor })}`,
        );
        out(json, () => {
          const hits = list(json?.["hits"]);
          if (hits.length === 0) return "no matches. Try a synonym, or one distinctive word.\n";
          const lines = hits.map(
            (hit) =>
              `${String(hit["page_id"])}  ${(hit["heading_path"] as string[]).join(" > ")}\n    ${String(hit["snippet"])}`,
          );
          const more = json?.["cursor"] ? `\nmore: --cursor ${String(json["cursor"])}` : "";
          return `${lines.join("\n")}${more}\n`;
        });
        return 0;
      }

      case "read": {
        const id = need(args[0], "page id");
        const response = await client.request(
          "GET",
          `/pages/${encodeURIComponent(id)}${flags.json ? "" : "?format=markdown"}`,
        );
        out(response.json, () => `${response.text}\n`);
        return 0;
      }

      case "links": {
        const id = need(args[0], "page id, or table-id/row-id");
        const slash = id.indexOf("/");
        const path =
          slash > 0
            ? `/tables/${encodeURIComponent(id.slice(0, slash))}/rows/${encodeURIComponent(id.slice(slash + 1))}/links`
            : `/pages/${encodeURIComponent(id)}/neighbours`;
        const { json } = await client.request("GET", path);
        out(json, () => {
          const end = (edge: Json) =>
            edge["row_id"] !== undefined
              ? `${String(edge["table_id"])}/${String(edge["row_id"])}`
              : String(edge["page_id"] ?? edge["table_id"]);
          const how = (edge: Json) => (edge["type"] === "relation" ? `relation ${String(edge["label"])}` : String(edge["type"]));
          const line = (edge: Json) => `  ${end(edge)}  ${how(edge)}`;
          const outbound = list(json?.["outbound"]).map(line);
          const inbound = list(json?.["inbound"]).map(line);
          return `links out:\n${outbound.join("\n") || "  none"}\nlinks in:\n${inbound.join("\n") || "  none"}\n`;
        });
        return 0;
      }

      case "history": {
        const id = need(args[0], "page id");
        const { json } = await client.request(
          "GET",
          `/pages/${encodeURIComponent(id)}/history${query({ limit: flags.limit })}`,
        );
        out(json, () =>
          `${list(json?.["revisions"])
            .map((r) => `${String(r["version"])}  ${String(r["at"])}  ${by(r["by"])}${r["note"] ? `  "${String(r["note"])}"` : ""}`)
            .join("\n")}\n`,
        );
        return 0;
      }

      case "revision": {
        const id = need(args[0], "page id");
        const version = need(args[1], "version");
        const { json } = await client.request(
          "GET",
          `/pages/${encodeURIComponent(id)}/revisions/${encodeURIComponent(version)}`,
        );
        out(json, () =>
          `${String(json?.["version"])}  ${String(json?.["at"])}  ${by(json?.["by"])}\n` +
          `${json?.["diff"] ? String(json["diff"]) : "(first version, nothing to compare)"}\n`,
        );
        return 0;
      }

      case "changes": {
        if (flags.agents && flags.people) throw new UsageError("pick one of --agents and --people");
        const actor = flags.agents ? "agent" : flags.people ? "user" : undefined;
        const { json } = await client.request(
          "GET",
          `/changes${query({ since: flags.since, actor, limit: flags.limit, cursor: flags.cursor })}`,
        );
        out(json, () => {
          const lines = list(json?.["changes"]).map((change) => {
            const what =
              change["kind"] === "page"
                ? `page ${String(change["page_id"])} "${String(change["title"])}"`
                : `row ${String(change["table_id"])}/${String(change["row_id"])}`;
            const deleted = change["deleted"] ? " (deleted)" : "";
            const why = change["note"] ? `  "${String(change["note"])}"` : "";
            return `${String(change["at"])}  ${what}${deleted}  by ${by(change["by"])}${why}`;
          });
          const next = json?.["newest"] ? `\nnext time: --since ${String(json["newest"])}` : "";
          const more = json?.["cursor"] ? `\nmore: --cursor ${String(json["cursor"])}` : "";
          return `${lines.join("\n") || "no changes"}${more}${next}\n`;
        });
        return 0;
      }

      case "create": {
        const body = (await content(flags, io, false)) ?? "";
        const { json } = await client.request("POST", "/pages", {
          body: {
            title: need(flags.title, "--title"),
            body,
            ...(flags.parent ? { parent_id: flags.parent } : {}),
            ...(flags.tag ? { tags: flags.tag } : {}),
            ...(note ? { change_note: note } : {}),
          },
        });
        out(json, () => written(json));
        return 0;
      }

      case "append":
      case "replace-section":
      case "write": {
        const id = need(args[0], "page id");
        const text = (await content(flags, io, true))!;
        const mode = command === "append" ? "append" : command === "write" ? "replace_body" : "replace_section";
        const body = {
          mode,
          content: text,
          ...(mode === "replace_section" ? { section: need(flags.section, "--section") } : {}),
          ...(note ? { change_note: note } : {}),
        };
        const path = `/pages/${encodeURIComponent(id)}`;

        let version = flags.version;
        if (version === undefined) {
          // Only append may skip the version: it adds to the end and never
          // overwrites anyone's text, so reading the current version here is safe.
          if (mode !== "append") throw new UsageError(`${command} needs --version from cairn read`);
          version = (await client.request("GET", path)).etag ?? undefined;
        }
        try {
          const { json } = await client.request("PATCH", path, { body, ifMatch: version ?? null });
          out(json, () => written(json));
        } catch (error) {
          if (!(mode === "append" && flags.version === undefined && error instanceof ApiError && error.code === "version_conflict")) {
            throw error;
          }
          // Someone wrote in between. Appending is still safe on the new version.
          const retry = String(error.body?.["current_version"]);
          const { json } = await client.request("PATCH", path, { body, ifMatch: retry });
          out(json, () => written(json));
        }
        return 0;
      }

      case "delete": {
        const id = need(args[0], "page id");
        await client.request("DELETE", `/pages/${encodeURIComponent(id)}`, {
          ifMatch: need(flags.version, "--version"),
          body: note ? { change_note: note } : {},
        });
        out({ deleted: id }, () => `ok deleted ${id}\n`);
        return 0;
      }

      case "move": {
        const id = need(args[0], "the page or table to move");
        const parent = need(flags.parent, "--parent PAGE, or --parent root for the top");
        const version = need(flags.version, "--version V, from cairn read or cairn tables --json");
        const { json } = await client.request("POST", "/move", {
          body: { id, parent_id: parent === "root" ? null : parent, version, ...(note ? { change_note: note } : {}) },
        });
        out(json, () => `ok ${String(json?.["kind"])} ${id} now ${json?.["parent_id"] ? `under ${String(json["parent_id"])}` : "at the top"}, version ${String(json?.["version"])}\n`);
        return 0;
      }

      case "tables":
      case "collections": {
        const { json } = await client.request("GET", "/tables");
        out(json, () =>
          `${list(json?.["tables"])
            .map((c) => {
              const fields = list(c["fields"])
                .map((f) => `${String(f["name"])}:${String(f["type"])}${f["target"] && f["target"] !== "pages" ? `->${String(f["target"])}` : ""}${f["multiple"] ? "[]" : ""}${f["required"] ? "*" : ""}`)
                .join(", ");
              return `${String(c["id"])}  ${String(c["name"])}  (${fields})${c["parent_id"] ? `  under ${String(c["parent_id"])}` : ""}`;
            })
            .join("\n") || "no tables"}\n`,
        );
        return 0;
      }

      case "rows": {
        const cid = need(args[0], "table id");
        const { json } = await client.request("POST", `/tables/${encodeURIComponent(cid)}/query`, {
          body: {
            ...(flags.where ? { where: flags.where.map(parseWhere) } : {}),
            ...(flags.sort ? { sort: flags.sort.map(parseSort) } : {}),
            ...(flags.limit ? { limit: Number(flags.limit) } : {}),
            ...(flags.cursor ? { cursor: flags.cursor } : {}),
          },
        });
        out(json, () => {
          const rows = list(json?.["rows"]).map(
            (row) => `${String(row["id"])}  v${String(row["version"])}  ${JSON.stringify(row["values"])}`,
          );
          const more = json?.["cursor"] ? `\nmore: --cursor ${String(json["cursor"])}` : "";
          return `${rows.join("\n") || "no rows"}${more}\n`;
        });
        return 0;
      }

      case "row": {
        const cid = need(args[0], "table id");
        const rid = need(args[1], "row id");
        const { json } = await client.request(
          "GET",
          `/tables/${encodeURIComponent(cid)}/rows/${encodeURIComponent(rid)}`,
        );
        out(json, () => `${String(json?.["id"])}  v${String(json?.["version"])}  ${JSON.stringify(json?.["values"])}\n`);
        return 0;
      }

      case "upsert": {
        const cid = need(args[0], "table id");
        const body = {
          values: parseSet(need(flags.set, "--set field=value")),
          ...(note ? { change_note: note } : {}),
        };
        const rows = `/tables/${encodeURIComponent(cid)}/rows`;
        const { json } = flags.id
          ? await client.request("PUT", `${rows}/${encodeURIComponent(flags.id)}`, {
              body,
              ifMatch: flags.version ?? null,
            })
          : await client.request("POST", rows, { body });
        out(json, () => written(json));
        return 0;
      }

      case "export": {
        const target = need(args[0], "a folder to export into");
        const existing = await readdir(target).catch(() => null);
        if (existing && existing.length > 0 && !flags.force) {
          throw new UsageError(`${target} is not empty. Pick a new folder, or pass --force to write into it`);
        }

        const pages: ExportPage[] = [];
        let cursor: string | null = null;
        do {
          const { json } = await client.request(
            "GET",
            `/export/pages${query({ root: flags.root, cursor: cursor ?? undefined, limit: "100" })}`,
          );
          pages.push(...(list(json?.["pages"]) as unknown as ExportPage[]));
          cursor = (json?.["cursor"] as string | null) ?? null;
        } while (cursor !== null);

        // The root's parent is outside this export, so it becomes top level.
        if (flags.root && pages[0]) pages[0] = { ...pages[0], parent_id: null };

        const paths = assignPaths(pages);
        for (const page of pages) {
          const file = join(target, paths.get(page.id)!);
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, pageFile(page), "utf8");
        }

        const tables: ExportTable[] = [];
        if (!flags.root || flags.tables || flags.collections) {
          const { json } = await client.request("GET", "/tables");
          for (const table of list(json?.["tables"])) {
            const rows: ExportTable["rows"] = [];
            let rowCursor: string | null = null;
            do {
              const page = await client.request(
                "GET",
                `/tables/${encodeURIComponent(String(table["id"]))}/rows${query({ limit: "200", cursor: rowCursor ?? undefined })}`,
              );
              for (const row of list(page.json?.["rows"])) {
                rows.push({ id: String(row["id"]), values: row["values"] as Record<string, unknown> });
              }
              rowCursor = (page.json?.["cursor"] as string | null) ?? null;
            } while (rowCursor !== null);
            tables.push({
              id: String(table["id"]),
              name: String(table["name"]),
              // A root export leaves out pages above the root, so a parent there is dropped.
              parent_id: typeof table["parent_id"] === "string" && (!flags.root || pages.some((p) => p.id === table["parent_id"])) ? table["parent_id"] : null,
              fields: table["fields"] as unknown[],
              rows,
            });
          }
          const taken = new Set<string>();
          for (const table of tables) {
            const file = join(target, tablePath(table, taken));
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, `${JSON.stringify(table, null, 2)}\n`, "utf8");
          }
        }

        const manifest: Manifest = {
          format: FORMAT,
          version: FORMAT_VERSION,
          exported_at: new Date().toISOString(),
          source: io.env["CAIRN_URL"] ?? "http://localhost:8787",
          root: flags.root ?? null,
          counts: {
            pages: pages.length,
            tables: tables.length,
            rows: tables.reduce((sum, c) => sum + c.rows.length, 0),
          },
        };
        await mkdir(target, { recursive: true });
        await writeFile(join(target, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        out(manifest as unknown as Json, () =>
          `exported ${manifest.counts.pages} pages, ${manifest.counts.tables} tables and ${manifest.counts.rows} rows to ${target}\n`,
        );
        return 0;
      }

      case "import": {
        const folder = need(args[0], "an export folder");
        const manifestText = await readFile(join(folder, MANIFEST), "utf8").catch(() => null);
        if (manifestText === null) {
          throw new UsageError(`${folder} has no ${MANIFEST}. cairn import reads folders written by cairn export`);
        }
        const manifest = JSON.parse(manifestText) as Partial<Manifest>;
        if (manifest.format !== FORMAT || typeof manifest.version !== "number") {
          throw new UsageError(`${join(folder, MANIFEST)} is not a Cairn export manifest`);
        }
        if (manifest.version > FORMAT_VERSION) {
          throw new UsageError(`this export is format version ${manifest.version}; this cairn reads up to ${FORMAT_VERSION}. Update cairn`);
        }

        const pages: ExportPage[] = [];
        const seen = new Map<string, string>();
        for (const file of await markdownFiles(join(folder, "pages"))) {
          const name = relative(folder, file).split(sep).join("/");
          const page = parsePageFile(await readFile(file, "utf8"), name);
          if (seen.has(page.id)) throw new UsageError(`page ${page.id} is in both ${seen.get(page.id)} and ${name}`);
          seen.set(page.id, name);
          pages.push(page);
        }

        const dry = flags["dry-run"] === true;
        const change = note ?? `Imported from the export of ${manifest.exported_at ?? "an unknown date"}`;
        const pageTally = tally();
        const reparented: string[] = [];
        const inExport = new Set(pages.map((page) => page.id));
        const parentExists = new Map<string, boolean>();

        for (const page of orderForImport(pages)) {
          let parent = page.parent_id;
          if (parent !== null && !inExport.has(parent)) {
            if (!parentExists.has(parent)) {
              parentExists.set(parent, (await maybe(client, `/pages/${encodeURIComponent(parent)}`)) !== null);
            }
            if (!parentExists.get(parent)) {
              reparented.push(page.id);
              parent = null;
            }
          }
          const desired = { title: page.title, body: page.body, parent_id: parent, tags: page.tags };
          const path = `/pages/${encodeURIComponent(page.id)}`;
          const current = await maybe(client, path);
          if (current === null) {
            pageTally.created += 1;
            if (!dry) await client.request("PUT", path, { body: { ...desired, change_note: change } });
            continue;
          }
          const now = current.json ?? {};
          const same =
            now["title"] === desired.title &&
            now["body"] === desired.body &&
            (now["parent_id"] ?? null) === desired.parent_id &&
            stable(now["tags"]) === stable(desired.tags);
          if (same) {
            pageTally.unchanged += 1;
            continue;
          }
          pageTally.updated += 1;
          if (!dry) {
            await client.request("PUT", path, { body: { ...desired, change_note: change }, ifMatch: current.etag });
          }
        }

        const tableTally = tally();
        const rowTally = tally();
        const folderOfTables = tablesFolder(manifest.version);
        const tableFiles = (await readdir(join(folder, folderOfTables)).catch(() => []))
          .filter((name) => name.endsWith(".json"))
          .sort();
        const exported: ExportTable[] = [];
        for (const name of tableFiles) {
          exported.push(JSON.parse(await readFile(join(folder, folderOfTables, name), "utf8")) as ExportTable);
        }
        for (const table of orderTables(exported)) {
          const path = `/tables/${encodeURIComponent(table.id)}`;
          // A parent that is neither in the export nor on this server: the top, as for pages.
          let parentId = table.parent_id ?? null;
          if (parentId !== null && !inExport.has(parentId)) {
            if (!parentExists.has(parentId)) {
              parentExists.set(parentId, (await maybe(client, `/pages/${encodeURIComponent(parentId)}`)) !== null);
            }
            if (!parentExists.get(parentId)) parentId = null;
          }
          const schema = { name: table.name, fields: table.fields, parent_id: parentId };
          const current = await maybe(client, path);
          if (current === null) {
            tableTally.created += 1;
            if (!dry) await client.request("PUT", path, { body: schema });
          } else if (stable({ name: current.json?.["name"], fields: current.json?.["fields"], parent_id: current.json?.["parent_id"] ?? null }) === stable(schema)) {
            tableTally.unchanged += 1;
          } else {
            tableTally.updated += 1;
            if (!dry) await client.request("PUT", path, { body: schema, ifMatch: current.etag });
          }

          for (const row of table.rows) {
            const rowPath = `${path}/rows/${encodeURIComponent(row.id)}`;
            // In a dry run a new table has no rows to compare against.
            const existing = current === null ? null : await maybe(client, rowPath);
            if (existing === null) {
              rowTally.created += 1;
              if (!dry) await client.request("PUT", rowPath, { body: { values: row.values, change_note: change } });
            } else if (stable(existing.json?.["values"]) === stable(row.values)) {
              rowTally.unchanged += 1;
            } else {
              rowTally.updated += 1;
              if (!dry) {
                await client.request("PUT", rowPath, {
                  body: { values: row.values, change_note: change },
                  ifMatch: existing.etag,
                });
              }
            }
          }
        }

        const report = {
          dry_run: dry,
          pages: pageTally,
          tables: tableTally,
          rows: rowTally,
          moved_to_top_level: reparented,
        };
        out(report as unknown as Json, () =>
          [
            dry ? "dry run, nothing written:" : "imported:",
            `  pages        ${describe(pageTally)}`,
            `  tables       ${describe(tableTally)}`,
            `  rows         ${describe(rowTally)}`,
            reparented.length > 0
              ? `  ${reparented.length} page(s) moved to top level, because their parent is neither in the export nor on this server`
              : "",
          ]
            .filter((line) => line !== "")
            .join("\n") + "\n",
        );
        return 0;
      }

      case "sync": {
        const urls: Record<Side, string> = {
          a: normaliseUrl(need(args[0], "the first server's address")),
          b: normaliseUrl(need(args[1], "the second server's address")),
        };
        if (urls.a === urls.b) throw new UsageError("cairn sync needs two different servers");
        let every: number | null = null;
        if (flags.every !== undefined) {
          try {
            every = parseInterval(flags.every);
          } catch (error) {
            throw new UsageError(error instanceof Error ? error.message : String(error));
          }
        }
        const dry = flags["dry-run"] === true;
        if (dry && every !== null) throw new UsageError("--dry-run runs once; leave out --every");

        const clientFor = async (url: string) =>
          new CairnClient({
            baseUrl: url,
            token: (await storedToken(url, loginIo).catch(() => null)) ?? undefined,
            userAgent: `cairn-cli/${VERSION} sync${agent ? ` (${agent})` : ""}`,
            fetch: io.fetch,
          });

        const once = async () => {
          const [clientA, clientB] = await Promise.all([clientFor(urls.a), clientFor(urls.b)]);
          const [snapshotA, snapshotB] = await Promise.all([readSide(clientA), readSide(clientB)]);
          const path = await statePath(credentialsPath(io.env), urls.a, urls.b);
          const state = await loadState(path, urls.a, urls.b);
          const syncPlan = plan(snapshotA, snapshotB, state.base);
          if (dry) {
            out({ dry_run: true, actions: syncPlan.actions.map((x) => ({ key: x.key, op: x.op, to: urls[x.to], conflict: x.conflict })) }, () =>
              describeSyncPlan(syncPlan, urls),
            );
            return;
          }
          const { report, base } = await apply(
            syncPlan,
            {
              a: { url: urls.a, client: clientA, snapshot: snapshotA },
              b: { url: urls.b, client: clientB, snapshot: snapshotB },
            },
            state.base,
          );
          await saveState(path, { servers: [urls.a, urls.b], last_sync: new Date().toISOString(), base });
          out(report as unknown as Json, () => describeSyncReport(report, urls));
        };

        if (every === null) {
          await once();
          return 0;
        }
        for (;;) {
          try {
            await once();
          } catch (error) {
            const reason = error instanceof ApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
            io.stderr(`${new Date().toISOString()} sync failed: ${reason}. Trying again in ${flags.every}\n`);
          }
          await new Promise((resolve) => setTimeout(resolve, every));
        }
      }

      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\nRun cairn --help.\n`);
      return 2;
    }
    if (error instanceof ApiError) {
      if (flags.json && error.body) {
        io.stdout(`${JSON.stringify(error.body, null, 2)}\n`);
      } else {
        let detail = "";
        if (error.code === "version_conflict") {
          detail = `\ncurrent version: ${String(error.body?.["current_version"])}. Read the page again, merge, and retry with that version.`;
        } else if (error.code === "unauthorized") {
          detail = io.env["CAIRN_TOKEN"]
            ? "\n  CAIRN_TOKEN was not accepted by this server."
            : "\n  Run: cairn login   (or set CAIRN_TOKEN to a service token)";
        } else if (error.code === "validation_failed" || error.code === "bad_request") {
          detail = list(error.body?.["fields"])
            .map((f) => `\n  ${String(f["field"])}: ${String(f["message"])}`)
            .join("");
        }
        io.stderr(`error: ${error.code}: ${error.message}${detail}\n`);
      }
      return 1;
    }
    throw error;
  }
}
