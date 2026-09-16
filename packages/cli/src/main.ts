import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
import { indexPages, renderIndex, renderPage, sitemapXml, sitePaths, trailOf } from "./site-format.js";
import { checkSources, collectSources, type FoundSource, type SourceCheck } from "./check-sources.js";
import { fetchPeerDescription, TRUSTED_TABLE_NAME } from "./trust.js";
import { discover, DISCOVERED_TABLE_NAME } from "./discover.js";
import { checkInstance, firstReachable, instancesPath, isLoopback, loadInstances, reachable, saveInstances, type Instance } from "./instances.js";
import { credentialsPath, login, logout, NoSignIn, peekCredentials, REFRESH_TIMEOUT_MS, RefreshFailed, storedToken } from "./login.js";
import { hookInstalled, installHook, settingsPath, uninstallHook } from "./hook.js";
import { statusLines, type StatusInput } from "./status.js";
import {
  describeInterval,
  LAUNCHD_LABEL,
  launchdPath,
  launchdPlist,
  PASSED_ENV,
  schtasksArgs,
  SYSTEMD_UNIT,
  systemdDir,
  systemdUnits,
  WINDOWS_TASK,
  type Job,
} from "./schedule.js";
import {
  apply,
  loadState,
  normaliseUrl,
  parseInterval,
  plan,
  readSide,
  resolveMerges,
  saveState,
  statePath,
  type Side,
  type SyncAction,
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

export const VERSION = "0.1.5";

export interface Io {
  fetch: Fetch;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Piped input, or null when there is none. */
  stdin: () => Promise<string | null>;
  /**
   * Asks the person a question and waits for one line. Null when there is
   * nobody to ask: no terminal, input being piped, a script, an agent. A
   * caller that gets null must carry on without the answer, never block.
   */
  ask?: (question: string) => Promise<string | null>;
  /** Opens a URL in the user's browser, for cairn login. */
  openBrowser?: (url: string) => Promise<void>;
  /** Runs a program and waits for it, with no shell, for cairn sync install. */
  exec?: (command: string, args: string[]) => Promise<{ code: number; output: string }>;
  /** Starts an instance's own start command in the background, for cairn start. */
  launch?: (command: string, log: string) => Promise<void>;
  /** How to run this CLI again, for a scheduled job. Throws when it cannot. */
  self?: () => Promise<string[]>;
  platform?: string;
  home?: string;
  uid?: number;
  sleep?: (ms: number) => Promise<void>;
}

const HELP = `cairn ${VERSION}: a wiki and tables your agents can write to, with every change reviewable.

Read
  cairn overview                          what Cairn holds: collections, tables, tags
  cairn search <words...>                 search by keyword, and by meaning for English text
  cairn read <page-id>                    a page as Markdown, with its version, and its children
  cairn ls [page-id]                      that page's immediate children, one per line; omit
                                          page-id for the top-level pages (also cairn collections)
  cairn links <page-id | table-id/row-id> what it links to and what links to it
  cairn history <page-id | table-id/row-id>            who changed it, when and why
  cairn revision <page-id | table-id/row-id> <version>  one old version, with a diff
  cairn peek <page-id> <version>          one old version in full, changing nothing
  cairn changes [--since T] [--agents|--people]   what changed, newest first

Write (every write is a revision the owner can review and undo)
  cairn create --title T [--parent ID] [--tag X]...     body from --text, --file or stdin
  cairn append <page-id> [--version V]                  add to the end; safe without a version
  cairn replace-section <page-id> --section H --version V
  cairn write <page-id> --version V                     replace the whole body
  cairn delete <page-id> --version V
  cairn move <page-or-table-id> --parent PAGE|root --version V   change its place in the tree
  cairn restore <page-id> <version> --version V   bring back an old version, as a new one
  cairn publish <page-id> --version V     serve it, and everything under it, to anyone
      with no sign-in, at <server>/w. Publishing a collection publishes its wiki
  cairn unpublish <page-id> --version V   take it back down
      Publishing is per server: it never travels with sync, export or import
  All writes take --note "why", shown to the owner, and --source S (repeatable):
  a URL or short citation for where the facts came from, added to the page's or row's sources.
  append, replace-section and write take --verified: you re-checked the page's facts and they
  still hold. To mark a page verified with no other change: cairn append <page-id> --verified --note "why"

Tables
  cairn tables                            names, ids, fields and where each sits
      relation fields link rows: field->table-id, [] when a list
  cairn create-table <name> --field "name:type[(opt,opt)][->target][[]][*]"...
      [--parent PAGE] [--description "..."] --note "why this table exists"
      types: text, number, date, select, multi_select, checkbox, url, relation
      (opt,opt) for select/multi_select; ->target for relation ([] when a list; * when required)
  cairn update-table <table-id> --title NAME --field "..."... --version V --note "why"
      replaces the whole field list; existing rows keep values a dropped field held,
      just no longer queryable. --version from cairn tables
  cairn rows <table-id> [--where "field op value"]... [--sort field[:desc]]
      ops: eq ne lt lte gt gte contains in exists
  cairn row <table-id> <row-id>
  cairn upsert <table-id> --set field=value... [--id ROW] [--version V]

Your data
  cairn export <folder> [--root PAGE] [--tables]        Markdown files and JSON, readable without Cairn
  cairn export <folder> --format site [--site-url URL]  a folder of HTML, openable by double-click or a
                                                        static host; --site-url also writes a sitemap.xml
  cairn import <folder> [--dry-run]                     read an export back in, keeping ids; safe to repeat
  cairn sync <url-a> <url-b> [--every 5m] [--dry-run]   keep two Cairns the same; edits made on both
                                                        merge as in git, and where both changed the same
                                                        part the newer wins, the other kept in history
  cairn check-sources [--root PAGE] [--timeout MS]      which sources (a URL, a DOI or a PubMed id) no
                                                        longer answer, with an archived copy where the
                                                        Wayback Machine has one. Reports only; changes nothing

Trusted Cairns: a local list of others this Cairn's owner trusts
  cairn trust <url> [--note "why"] [--timeout MS]      confirm <url> answers with a Cairn self-description
      (ADR-034) and add or update it in the "Trusted cairns" table. The table itself is ordinary:
      cairn tables, rows, row and upsert read and edit it like any other
  cairn discover [--from URL]... [--depth N] [--limit N] [--timeout MS]
      walk outward from every url in "Trusted cairns" (and any --from given), following the
      Cairns each one cites (ADR-034, ADR-041), up to --depth hops (default 2) and --limit
      Cairns visited (default 200). Newly found Cairns land in "Discovered cairns", a lead
      to review, never auto-trusted: run cairn trust on the ones worth it

Several Cairns: a laptop and a cloud copy, say, kept as one
  cairn instances                                 the ones registered, in the order commands try them
  cairn instances add <name> <url> [--first] [--start "command"]
  cairn instances remove <name>
  cairn start                                     start the first if it is down, then sync them all
  cairn sync [--every 4h] [--dry-run]             sync the first that answers with each of the others
  cairn sync install [--every 4h] [--dry-run]     run cairn start on a schedule, as a background job
                                                  offered when you register a second Cairn; 4h by default
  cairn sync uninstall
  With instances registered, every command goes to the first that answers; --instance NAME picks one.

Signing in (only for a server that uses OAuth; localhost needs none)
  cairn login                             sign in through your browser to the server CAIRN_URL
                                          or --instance names; tokens are kept for that server
  cairn whoami                            who the server thinks you are
  cairn logout                            revoke and forget this server's sign-in

Presence
  cairn status [--json]                   instance, sign-in, sync, embeddings, job and hook, all
                                          in one screen; every not-ok line carries its fix command
  cairn hook install [--yes]              a Claude Code SessionStart hook that runs
                                          cairn overview --brief, so a fresh session starts
                                          knowing what the workspace holds
  cairn hook status                       installed or not, and where
  cairn hook uninstall                    remove it

Options
  --json          print the raw API response
  -V, cairn version   print the CLI version
  --limit N, --cursor C
  -i, --instance NAME use this registered instance
  CAIRN_URL       server, default http://localhost:8787; takes precedence over instances
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
  source: { type: "string", multiple: true },
  verified: { type: "boolean" },
  note: { type: "string" },
  text: { type: "string" },
  file: { type: "string" },
  version: { type: "string" },
  section: { type: "string" },
  where: { type: "string", multiple: true },
  sort: { type: "string", multiple: true },
  set: { type: "string", multiple: true },
  field: { type: "string", multiple: true },
  description: { type: "string" },
  id: { type: "string" },
  since: { type: "string" },
  agents: { type: "boolean" },
  people: { type: "boolean" },
  root: { type: "string" },
  tables: { type: "boolean" },
  format: { type: "string" },
  "site-url": { type: "string" },
  // The names before ADR-026, kept so scripts that use them still work.
  collections: { type: "boolean" },
  force: { type: "boolean" },
  "dry-run": { type: "boolean" },
  every: { type: "string" },
  // Short form because it is typed on nearly every command aimed at a named
  // Cairn, the owner's direction of 2026-09-16.
  instance: { type: "string", short: "i" },
  first: { type: "boolean" },
  start: { type: "string" },
  timeout: { type: "string" },
  from: { type: "string", multiple: true },
  depth: { type: "string" },
  brief: { type: "boolean" },
  yes: { type: "boolean" },
} as const;

/** Commands that choose their own servers, so never probe for one. */
const OWN_SERVERS = new Set(["instances", "start", "sync", "hook", "status"]);

/** How long cairn start waits for an instance it started. */
const START_WAIT_MS = 90_000;

/**
 * The default for a scheduled sync. Every run wakes a Cairn on Azure, which
 * then stays up for its idle timeout of about 30 minutes, so the interval is
 * really a choice about how much of the day the cloud copy is awake. Four
 * hours is six wakes a day, three of those hours asleep out of every four.
 * It was an hour until 2026-09-16, which left it awake about half the time.
 */
const DEFAULT_EVERY_MS = 4 * 3_600_000;

/** How long check-sources waits for one address before calling it dead. */
const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

/** How many hops out cairn discover walks by default. */
const DEFAULT_DISCOVER_DEPTH = 2;

/** How many Cairns cairn discover visits in total by default. */
const DEFAULT_DISCOVER_LIMIT = 200;

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

const FIELD_SPEC =
  /^([^:]+):(text|number|date|select|multi_select|checkbox|url|relation)(\(([^)]*)\))?(->([^[*]+))?(\[\])?(\*)?$/;

/**
 * A field spec, in the same name:type->target[]* shape `cairn tables`
 * already prints, so an agent can round-trip what it reads.
 */
function parseField(raw: string): Record<string, unknown> {
  const match = FIELD_SPEC.exec(raw.trim());
  if (!match) {
    throw new UsageError(
      `cannot read --field "${raw}". Use name:type, such as --field "title:text*" or --field "status:select(open,closed)" or --field "owner:relation->pages[]"`,
    );
  }
  const [, name, type, , options, , target, multiple, required] = match;
  return {
    name,
    type,
    ...(options ? { options: options.split(",").map((o) => o.trim()).filter(Boolean) } : {}),
    ...(target ? { target } : {}),
    ...(multiple ? { multiple: true } : {}),
    ...(required ? { required: true } : {}),
  };
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
    const why = !action.conflict
      ? ""
      : action.merge === undefined
        ? " (changed on both; the newer edit wins)"
        : action.merge.parts === 0
          ? " (changed on both, in different parts; merged)"
          : ` (changed on both; merged, and ${plural(action.merge.parts, "part")} changed on both take the newer edit)`;
    lines.push(`  ${verb} ${urls[action.to]}: ${what.kind} ${what.label}${why}`);
  }
  return `${lines.join("\n")}\n`;
}

function describeCheckSources(found: FoundSource[], checks: Map<string, SourceCheck>): string {
  const linkable = found.filter((f): f is FoundSource & { href: string } => f.href !== null);
  const plain = found.length - linkable.length;
  const dead = [...checks.entries()].filter(([, check]) => !check.ok);
  const header = `checked ${plural(linkable.length, "linked source")}${plain > 0 ? `, ${plural(plain, "plain citation")} left unchecked` : ""}`;
  if (dead.length === 0) return `${header}: all answered\n`;
  const where = (on: FoundSource["on"]) => (on.kind === "page" ? `page "${on.title}" (${on.id})` : `row ${on.table}/${on.id}`);
  const lines = [`${header}, ${plural(dead.length, "dead source")}:`];
  for (const [href, check] of dead) {
    const why = check.error ? `cannot reach: ${check.error}` : `answered ${check.status}`;
    lines.push(`  ${href} — ${why}`);
    for (const source of linkable.filter((f) => f.href === href)) lines.push(`    on ${where(source.on)}`);
    lines.push(check.archived ? `    archived copy: ${check.archived}` : "    no archived copy found");
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
    lines.push(
      conflict.merged
        ? `  conflict: ${conflict.label} changed on both; merged, and ${plural(conflict.parts, "part")} changed on both kept the newer edit, from ${conflict.kept_from}. ${kept}`
        : `  conflict: ${conflict.label} changed on both; kept the newer edit, from ${conflict.kept_from}. ${kept}`,
    );
  }
  for (const merged of report.merged) lines.push(`  merged: ${merged.label} changed on both, in different parts; both edits kept`);
  for (const warning of report.warnings) lines.push(`  warning: ${warning}`);
  for (const skipped of report.skipped) lines.push(`  skipped: ${skipped}`);
  lines.push(`  ${plural(report.unchanged, "record")} already the same`);
  return `${lines.join("\n")}\n`;
}

function written(json: Json | null): string {
  return `ok ${String(json?.["id"])} version ${String(json?.["version"])}\n`;
}

/**
 * What to do when `cairn login` finds no sign-in. The usual case is a person
 * who meant their cloud Cairn and named none, so the CLI tried localhost.
 */
function noSignIn(error: NoSignIn, named: boolean): string {
  const { baseUrl, status } = error;
  const elsewhere =
    "To sign in to another Cairn, name it:\n" +
    "  CAIRN_URL=https://your-address cairn login\n" +
    "or register it once and sign in by its name:\n" +
    "  cairn instances add cloud https://your-address\n" +
    "  cairn login --instance cloud";
  if (status === null) {
    return named
      ? `could not reach ${baseUrl}. Check the address and that it is running; a Cairn on Azure can take about 30 seconds to start.`
      : `cairn login signs in to one Cairn. None was named, so it tried ${baseUrl}, which did not answer.\n${elsewhere}`;
  }
  if (isLoopback(baseUrl)) {
    return named
      ? `${baseUrl} needs no sign-in: a Cairn on this machine trusts it, so other commands work without one. If one asks for a token, set CAIRN_TOKEN to the one the server was started with.`
      : `cairn login signs in to one Cairn. None was named, so it tried ${baseUrl}, which is on this machine and needs no sign-in.\n${elsewhere}`;
  }
  return `${baseUrl} has no browser sign-in (HTTP ${status}). Check that the address is a Cairn's. A Cairn run with a service token rather than GitHub sign-in takes CAIRN_TOKEN instead of cairn login.`;
}

/**
 * What to tell the person when a stored sign-in exists but could not be
 * refreshed (ADR-054). Only `invalid_grant` means the sign-in is actually
 * gone; the other two are told the credentials were kept.
 */
function refreshFailedMessage(error: RefreshFailed, registered: Instance[]): string {
  const { baseUrl, reason } = error;
  const match = registered.find((x) => x.url === baseUrl);
  const signInAgain = match ? `cairn login --instance ${match.name}` : `CAIRN_URL=${baseUrl} cairn login`;
  if (reason.kind === "invalid_grant") {
    return `the sign-in to ${baseUrl} is no longer valid. Sign in again: ${signInAgain}`;
  }
  if (reason.kind === "http") {
    return `${baseUrl} refused to refresh the sign-in (HTTP ${reason.status}): ${reason.message}. The stored sign-in was kept; try again, or ${signInAgain} if it keeps happening.`;
  }
  return `could not reach ${baseUrl} to refresh the sign-in (waited ${REFRESH_TIMEOUT_MS / 1000}s): ${reason.message}. The stored sign-in was kept; try again, or run cairn status.`;
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
  const credentials = credentialsPath(io.env);
  const registry = instancesPath(credentials);
  const registered = await loadInstances(registry);
  const names = () => registered.map((instance) => instance.name).join(", ") || "none";
  const named = (name: string): Instance => {
    const found = registered.find((instance) => instance.name === name);
    if (!found) throw new UsageError(`no instance called "${name}". Registered: ${names()}`);
    return found;
  };

  // Which server: --instance, then CAIRN_URL, then the first registered
  // instance that answers (ADR-029), then localhost.
  let baseUrl = io.env["CAIRN_URL"] ?? "http://localhost:8787";
  try {
    if (flags.instance !== undefined) {
      baseUrl = named(flags.instance).url;
    } else if (io.env["CAIRN_URL"] === undefined && registered.length > 0 && !OWN_SERVERS.has(command)) {
      if (command === "login" || command === "logout") {
        throw new UsageError(`which instance? cairn ${command} --instance <name>, one of: ${names()}`);
      }
      const { instance, skipped } = await firstReachable(registered, io.fetch);
      if (!instance) {
        // A session hook has nowhere to report an error: say so in one line
        // instead of failing the session it is starting.
        if (command === "overview" && flags.brief) {
          io.stdout("Cairn is not answering. Start it: cairn start\n");
          return 0;
        }
        io.stderr(`error: none of your instances answered: ${registered.map((x) => `${x.name} (${x.url})`).join(", ")}\n`);
        return 1;
      }
      if (skipped.length > 0) {
        io.stderr(`using ${instance.name} (${instance.url}): ${skipped.map((x) => x.name).join(", ")} did not answer\n`);
      }
      baseUrl = instance.url;
    }
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`${error.message}\nRun cairn --help.\n`);
    return 2;
  }
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
      const chosen = flags.instance !== undefined || io.env["CAIRN_URL"] !== undefined;
      io.stderr(`error: ${error instanceof NoSignIn ? noSignIn(error, chosen) : error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  if (command === "logout") {
    const had = await logout(baseUrl, loginIo);
    io.stdout(had ? `signed out of ${baseUrl}\n` : `not signed in to ${baseUrl}\n`);
    return 0;
  }

  // A stored sign-in that could not be refreshed still leaves the person
  // with a working command most of the time (many don't need auth, and the
  // server may just answer 401 on this one); say why and carry on rather
  // than failing every command over a refresh hiccup (ADR-054).
  const tokenFor = async (url: string): Promise<string | undefined> => {
    try {
      return (await storedToken(url, loginIo)) ?? undefined;
    } catch (error) {
      if (error instanceof RefreshFailed) {
        io.stderr(`${refreshFailedMessage(error, registered)}\n`);
        return undefined;
      }
      throw error;
    }
  };

  // A service token wins; otherwise a stored sign-in, refreshed if needed.
  const token = io.env["CAIRN_TOKEN"] ?? (await tokenFor(baseUrl));
  const client = new CairnClient({
    baseUrl,
    token,
    userAgent: `cairn-cli/${VERSION}${agent ? ` (${agent})` : ""}`,
    fetch: io.fetch,
  });
  const out = (json: Json | null, text: () => string) =>
    io.stdout(flags.json ? `${JSON.stringify(json, null, 2)}\n` : text());
  const note = flags.note;
  // A write with no note still succeeds (MCP already requires one, and a CLI
  // hard failure here would break scripts), but the history is worse for it,
  // so say so on stderr rather than let it pass unremarked (fault 3, console-
  // and-search-polish).
  const warnIfNoNote = () => {
    if (!note) io.stderr('no change note given. Add --note "why", so the history says why this changed.\n');
  };

  const reason = (error: unknown) =>
    error instanceof ApiError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);

  const clientFor = async (url: string) =>
    new CairnClient({
      baseUrl: url,
      token: await tokenFor(url),
      userAgent: `cairn-cli/${VERSION} sync${agent ? ` (${agent})` : ""}`,
      fetch: io.fetch,
    });

  /** One sync between two servers (ADR-023). Null on a dry run. */
  const syncPair = async (urls: Record<Side, string>, dry: boolean): Promise<SyncReport | null> => {
    const [clientA, clientB] = await Promise.all([clientFor(urls.a), clientFor(urls.b)]);
    const [snapshotA, snapshotB] = await Promise.all([readSide(clientA), readSide(clientB)]);
    const path = await statePath(credentials, urls.a, urls.b);
    const state = await loadState(path, urls.a, urls.b);
    const syncPlan = await resolveMerges(plan(snapshotA, snapshotB, state.base), { a: clientA, b: clientB }, state.base);
    if (dry) {
      const merged = (x: SyncAction) => (x.merge === undefined ? {} : { merged: true, parts: x.merge.parts });
      out({ dry_run: true, actions: syncPlan.actions.map((x) => ({ key: x.key, op: x.op, to: urls[x.to], conflict: x.conflict, ...merged(x) })) }, () =>
        describeSyncPlan(syncPlan, urls),
      );
      return null;
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
    return report;
  };

  /**
   * Every registered instance, through a hub (ADR-029): the first that
   * answers syncs with each of the others in turn. When the hub took changes
   * from one of them, the ones before it are synced again, so a change made
   * anywhere reaches everywhere in one run. False when a sync failed.
   */
  const syncAll = async (dry: boolean): Promise<boolean> => {
    const answers = await Promise.all(registered.map((instance) => reachable(instance.url, io.fetch)));
    const up = registered.filter((_, index) => answers[index]);
    for (const [index, instance] of registered.entries()) {
      if (!answers[index]) io.stderr(`skipped ${instance.name} (${instance.url}): not answering\n`);
    }
    const [hub, ...others] = up;
    if (!hub || others.length === 0) {
      io.stderr(`${up.length === 0 ? "no instance" : `only ${hub!.name}`} answered, so there is nothing to sync\n`);
      return true;
    }
    let ok = true;
    let lastInto = -1;
    const one = async (index: number) => {
      const remote = others[index]!;
      try {
        const report = await syncPair({ a: hub.url, b: remote.url }, dry);
        const into = report?.written.a;
        if (into && into.pages + into.tables + into.rows + into.deleted > 0) lastInto = index;
      } catch (error) {
        ok = false;
        io.stderr(`error: syncing ${hub.name} with ${remote.name} failed: ${reason(error)}\n`);
      }
    };
    for (let index = 0; index < others.length; index++) await one(index);
    const again = lastInto;
    for (let index = 0; index < again; index++) await one(index);
    return ok;
  };

  const exec = async (program: string, programArgs: string[]) => {
    if (!io.exec) throw new Error("this build of cairn cannot run programs");
    return io.exec(program, programArgs);
  };
  const platform = io.platform ?? process.platform;
  const home = io.home ?? homedir();
  const domain = `gui/${io.uid ?? process.getuid?.() ?? 0}`;

  const jobInstalled = async (): Promise<boolean> => {
    if (platform === "win32") return (await exec("schtasks", ["/Query", "/TN", WINDOWS_TASK]).catch(() => ({ code: 1 }))).code === 0;
    const path = platform === "darwin" ? launchdPath(home) : join(systemdDir(home, io.env), `${SYSTEMD_UNIT}.timer`);
    return readFile(path).then(
      () => true,
      () => false,
    );
  };

  const installJob = async (instances: Instance[] = registered): Promise<number> => {
    if (instances.length < 2) {
      throw new UsageError("register two or more instances first: cairn instances add <name> <url>");
    }
    let everyMs = DEFAULT_EVERY_MS;
    if (flags.every !== undefined) {
      try {
        everyMs = parseInterval(flags.every);
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error));
      }
    }
    if (!io.self) throw new Error("this build of cairn cannot install a job");
    let program: string[];
    try {
      program = await io.self();
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    // Where to find the same instances and sign-ins; never a token.
    const env: Record<string, string> = {};
    for (const key of PASSED_ENV) if (io.env[key]) env[key] = io.env[key]!;
    const log = join(dirname(credentials), "logs", "sync.log");
    const job: Job = { program, everyMs, env, log };
    const dry = flags["dry-run"] === true;
    const every = describeInterval(everyMs);

    if (platform === "darwin") {
      const path = launchdPath(home);
      const text = launchdPlist(job);
      if (dry) {
        io.stdout(`dry run, nothing installed. It would write ${path}:\n\n${text}`);
        return 0;
      }
      await mkdir(dirname(path), { recursive: true });
      await mkdir(dirname(log), { recursive: true });
      await writeFile(path, text, "utf8");
      await exec("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
      const loaded = await exec("launchctl", ["bootstrap", domain, path]);
      if (loaded.code !== 0) throw new Error(`launchctl could not load ${path}: ${loaded.output.trim()}`);
      io.stdout(`installed: cairn start at login and every ${every}, as ${LAUNCHD_LABEL}. Output in ${log}\nRemove it with: cairn sync uninstall\n`);
      return 0;
    }
    if (platform === "win32") {
      const taskArgs = schtasksArgs(job);
      if (dry) {
        io.stdout(`dry run, nothing installed. It would run:\n  schtasks ${taskArgs.join(" ")}\n`);
        return 0;
      }
      if (Object.keys(env).length > 0) {
        io.stderr(`note: a scheduled task cannot carry ${Object.keys(env).join(" or ")}; the job uses the default config folder\n`);
      }
      const created = await exec("schtasks", taskArgs);
      if (created.code !== 0) throw new Error(`schtasks could not create the task: ${created.output.trim()}`);
      io.stdout(`installed: cairn start every ${every}, as the scheduled task "${WINDOWS_TASK}"\nRemove it with: cairn sync uninstall\n`);
      return 0;
    }
    const dir = systemdDir(home, io.env);
    const units = systemdUnits(job);
    if (dry) {
      io.stdout(
        `dry run, nothing installed. It would write ${join(dir, `${SYSTEMD_UNIT}.service`)}:\n\n${units.service}\n` +
          `and ${join(dir, `${SYSTEMD_UNIT}.timer`)}:\n\n${units.timer}`,
      );
      return 0;
    }
    await mkdir(dir, { recursive: true });
    await mkdir(dirname(log), { recursive: true });
    await writeFile(join(dir, `${SYSTEMD_UNIT}.service`), units.service, "utf8");
    await writeFile(join(dir, `${SYSTEMD_UNIT}.timer`), units.timer, "utf8");
    await exec("systemctl", ["--user", "daemon-reload"]);
    const enabled = await exec("systemctl", ["--user", "enable", "--now", `${SYSTEMD_UNIT}.timer`]);
    if (enabled.code !== 0) throw new Error(`systemctl could not start the timer: ${enabled.output.trim()}`);
    io.stdout(`installed: cairn start a minute after boot and every ${every}, as ${SYSTEMD_UNIT}.timer. Output in ${log}\nRemove it with: cairn sync uninstall\n`);
    return 0;
  };

  const uninstallJob = async (): Promise<number> => {
    if (platform === "darwin") {
      await exec("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
      await rm(launchdPath(home), { force: true });
    } else if (platform === "win32") {
      await exec("schtasks", ["/Delete", "/F", "/TN", WINDOWS_TASK]);
    } else {
      const dir = systemdDir(home, io.env);
      await exec("systemctl", ["--user", "disable", "--now", `${SYSTEMD_UNIT}.timer`]);
      await rm(join(dir, `${SYSTEMD_UNIT}.timer`), { force: true });
      await rm(join(dir, `${SYSTEMD_UNIT}.service`), { force: true });
      await exec("systemctl", ["--user", "daemon-reload"]);
    }
    io.stdout("removed the scheduled sync. Instances, sign-ins and sync state are kept\n");
    return 0;
  };

  /**
   * Offered the moment a second Cairn is registered, which is the moment a
   * pair comes into being and the only moment the person is certainly
   * thinking about it. `cairn sync install` had existed for a while and went
   * unrun, so two registered Cairns drifted apart and the pairing was a
   * promise nothing kept.
   *
   * It stays an offer. Installing writes a launchd agent, a systemd timer or
   * a scheduled task, which is the person's machine rather than Cairn's, and
   * a background job that appears because a wiki command decided it should is
   * not something to do to somebody. With nobody there to ask, it says how.
   */
  const offerScheduledSync = async (instances: Instance[]): Promise<void> => {
    const every = describeInterval(DEFAULT_EVERY_MS);
    const how = `cairn sync install --every ${every}`;
    if (await jobInstalled()) return;
    const answer = io.ask ? await io.ask(`Keep your ${instances.length} Cairns in sync every ${every}, with no terminal open? [y/N] `) : null;
    if (answer === null) {
      io.stderr(`they do not sync themselves yet. To make them: ${how}\n`);
      return;
    }
    if (!/^y(es)?$/i.test(answer.trim())) {
      io.stdout(`not installed. When you want it: ${how}\n`);
      return;
    }
    try {
      await installJob(instances);
    } catch (error) {
      // The instances are registered either way, and saying otherwise would
      // be worse than the failure: it is one command to retry.
      io.stderr(`error: the instances are registered, but the scheduled sync could not be installed: ${reason(error)}\nRun it yourself when you have: ${how}\n`);
    }
  };

  /** Every page under `root` (or all of them), parents first, as `export` reads them. */
  const fetchPages = async (root: string | undefined): Promise<ExportPage[]> => {
    const pages: ExportPage[] = [];
    let cursor: string | null = null;
    do {
      const { json } = await client.request("GET", `/export/pages${query({ root, cursor: cursor ?? undefined, limit: "100" })}`);
      pages.push(...(list(json?.["pages"]) as unknown as ExportPage[]));
      cursor = (json?.["cursor"] as string | null) ?? null;
    } while (cursor !== null);
    if (root && pages[0]) pages[0] = { ...pages[0], parent_id: null };
    return pages;
  };

  /** Every table's rows, with their sources, as `export --tables` reads them. */
  const fetchTables = async (): Promise<Array<{ id: string; rows: Array<{ id: string; sources?: string[] }> }>> => {
    const { json } = await client.request("GET", "/tables");
    const tables: Array<{ id: string; rows: Array<{ id: string; sources?: string[] }> }> = [];
    for (const table of list(json?.["tables"])) {
      const rows: Array<{ id: string; sources?: string[] }> = [];
      let rowCursor: string | null = null;
      do {
        const page = await client.request("GET", `/tables/${encodeURIComponent(String(table["id"]))}/rows${query({ limit: "200", cursor: rowCursor ?? undefined })}`);
        for (const row of list(page.json?.["rows"])) {
          const sources = list(row["sources"] as unknown).map(String);
          rows.push({ id: String(row["id"]), ...(sources.length > 0 ? { sources } : {}) });
        }
        rowCursor = (page.json?.["cursor"] as string | null) ?? null;
      } while (rowCursor !== null);
      tables.push({ id: String(table["id"]), rows });
    }
    return tables;
  };

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
        const brief = flags.brief === true;
        // A session hook calls this with nowhere to report an error, so an
        // unreachable Cairn is not a failure: one line, and how to fix it.
        if (brief && !(await reachable(baseUrl, io.fetch))) {
          io.stdout(`Cairn (${baseUrl}) is not answering. Start it: cairn start\n`);
          return 0;
        }
        const { json } = await client.request("GET", `/overview${query({ brief: brief ? "true" : undefined })}`);
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
        const { json } = await client.request("GET", `/pages/${encodeURIComponent(id)}`);
        out(json, () => {
          const p = json as Json;
          const updatedBy = p["updated_by"] as Json | undefined;
          const front = [
            "---",
            `id: ${String(p["id"])}`,
            `title: ${JSON.stringify(p["title"])}`,
            `version: ${String(p["version"])}`,
            `tags: ${JSON.stringify(p["tags"])}`,
            ...(list(p["sources"]).length > 0 ? [`sources: ${JSON.stringify(p["sources"])}`] : []),
            `verified: ${p["verified_at"] ?? "never"}`,
            `updated: ${String(p["updated_at"])} by ${String(updatedBy?.["kind"])} ${JSON.stringify(updatedBy?.["name"])}`,
            "---",
            "",
            String(p["body"] ?? ""),
          ].join("\n");
          const children = list(p["children"]);
          const more = Number(p["more_children"] ?? 0);
          const childLine = (c: Json) => `  ${String(c["id"])}  ${String(c["title"])}${c["has_children"] ? " >" : ""}`;
          const childrenBlock =
            children.length > 0
              ? `\n\nchildren:\n${children.map(childLine).join("\n")}${
                  more > 0 ? `\n  … and ${more} more: cairn ls ${id}` : ""
                }`
              : more > 0
                ? `\n\nchildren: ${more}, see cairn ls ${id}`
                : "";
          return `${front}${childrenBlock}\n`;
        });
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
            edge["cairn_url"] !== undefined
              ? String(edge["cairn_url"])
              : edge["row_id"] !== undefined
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
        const id = need(args[0], "page id, or table-id/row-id");
        const slash = id.indexOf("/");
        const path =
          slash > 0
            ? `/tables/${encodeURIComponent(id.slice(0, slash))}/rows/${encodeURIComponent(id.slice(slash + 1))}/history`
            : `/pages/${encodeURIComponent(id)}/history`;
        const { json } = await client.request("GET", `${path}${query({ limit: flags.limit })}`);
        out(json, () =>
          `${list(json?.["revisions"])
            .map((r) => `${String(r["version"])}  ${String(r["at"])}  ${by(r["by"])}${r["note"] ? `  "${String(r["note"])}"` : ""}`)
            .join("\n")}\n`,
        );
        return 0;
      }

      case "revision": {
        const id = need(args[0], "page id, or table-id/row-id");
        const version = need(args[1], "version");
        const slash = id.indexOf("/");
        const path =
          slash > 0
            ? `/tables/${encodeURIComponent(id.slice(0, slash))}/rows/${encodeURIComponent(id.slice(slash + 1))}/revisions/${encodeURIComponent(version)}`
            : `/pages/${encodeURIComponent(id)}/revisions/${encodeURIComponent(version)}`;
        const { json } = await client.request("GET", path);
        out(json, () =>
          `${String(json?.["version"])}  ${String(json?.["at"])}  ${by(json?.["by"])}\n` +
          list(json?.["sources_added"] as unknown).map((source) => `+ source: ${String(source)}\n`).join("") +
          list(json?.["sources_removed"] as unknown).map((source) => `- source: ${String(source)}\n`).join("") +
          (json?.["verified"] ? "verified: the page's facts were re-checked\n" : "") +
          `${json?.["diff"] ? String(json["diff"]) : "(first version, nothing to compare)"}\n`,
        );
        return 0;
      }

      case "peek": {
        const id = need(args[0], "page id");
        const version = need(args[1], "version, from cairn history");
        const { json } = await client.request(
          "GET",
          `/pages/${encodeURIComponent(id)}/revisions/${encodeURIComponent(version)}`,
        );
        out(json, () =>
          `# ${String(json?.["title"])}\n` +
          `${String(json?.["version"])}  ${String(json?.["at"])}  ${by(json?.["by"])}${json?.["note"] ? `  "${String(json["note"])}"` : ""}\n\n` +
          `${String(json?.["body"])}\n\n` +
          `This is version ${String(json?.["version"])}, not necessarily the current one. It changed nothing.\n` +
          `To bring it back: cairn restore ${id} ${String(json?.["version"])} --version <current version, from cairn read>\n`,
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
        warnIfNoNote();
        const { json } = await client.request("POST", "/pages", {
          body: {
            title: need(flags.title, "--title"),
            body,
            ...(flags.parent ? { parent_id: flags.parent } : {}),
            ...(flags.tag ? { tags: flags.tag } : {}),
            ...(flags.source ? { sources: flags.source } : {}),
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
        // An append that only adds sources or marks the page verified needs no text.
        const bare = command === "append" && Boolean(flags.verified || flags.source);
        const text = (await content(flags, io, !bare)) ?? "";
        const mode = command === "append" ? "append" : command === "write" ? "replace_body" : "replace_section";
        const body = {
          mode,
          content: text,
          ...(mode === "replace_section" ? { section: need(flags.section, "--section") } : {}),
          ...(flags.source ? { sources: flags.source } : {}),
          ...(flags.verified ? { verified: true } : {}),
          ...(note ? { change_note: note } : {}),
        };
        const path = `/pages/${encodeURIComponent(id)}`;
        warnIfNoNote();

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
        warnIfNoNote();
        await client.request("DELETE", `/pages/${encodeURIComponent(id)}`, {
          ifMatch: need(flags.version, "--version"),
          body: note ? { change_note: note } : {},
        });
        out({ deleted: id }, () => `ok deleted ${id}\n`);
        return 0;
      }

      case "publish":
      case "unpublish": {
        const id = need(args[0], "the page to publish");
        const version = need(flags.version, "--version V, from cairn read");
        const wanted = command === "publish";
        warnIfNoNote();
        const { json } = await client.request("POST", "/publish", {
          body: { id, public: wanted, version, ...(note ? { change_note: note } : {}) },
        });
        out(json, () =>
          wanted
            ? `ok ${id} and everything under it are public, at ${client.baseUrl}/w/${encodeURIComponent(id)}, version ${String(json?.["version"])}\n` +
              "   only on this Cairn: publishing does not travel with sync.\n"
            : `ok ${id} and everything under it are private again, version ${String(json?.["version"])}\n`,
        );
        return 0;
      }

      case "move": {
        const id = need(args[0], "the page or table to move");
        const parent = need(flags.parent, "--parent PAGE, or --parent root for the top");
        const version = need(flags.version, "--version V, from cairn read or cairn tables --json");
        warnIfNoNote();
        const { json } = await client.request("POST", "/move", {
          body: { id, parent_id: parent === "root" ? null : parent, version, ...(note ? { change_note: note } : {}) },
        });
        out(json, () => `ok ${String(json?.["kind"])} ${id} now ${json?.["parent_id"] ? `under ${String(json["parent_id"])}` : "at the top"}, version ${String(json?.["version"])}\n`);
        return 0;
      }

      case "restore": {
        const id = need(args[0], "page id");
        const version = need(args[1], "the version to restore, from cairn history or cairn peek");
        const expected = need(flags.version, "--version V, the page's current version, from cairn read");
        warnIfNoNote();
        const { json } = await client.request(
          "POST",
          `/pages/${encodeURIComponent(id)}/revisions/${encodeURIComponent(version)}/restore`,
          { ifMatch: expected, body: note ? { change_note: note } : {} },
        );
        out(json, () => `ok ${id} restored to version ${version}, as a new version ${String(json?.["version"])}\n`);
        return 0;
      }

      case "tables": {
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

      case "create-table": {
        const name = need(args[0], "table name");
        const fields = (flags.field ?? []).map(parseField);
        if (fields.length === 0) {
          throw new UsageError('missing --field, such as --field "title:text*"');
        }
        const { json } = await client.request("POST", "/tables", {
          body: {
            name,
            fields,
            ...(flags.parent ? { parent_id: flags.parent } : {}),
            ...(flags.description ? { description: flags.description } : {}),
            change_note: need(note, "--note, saying why this table exists"),
          },
        });
        out(json, () => written(json));
        return 0;
      }

      case "update-table": {
        const cid = need(args[0], "table id");
        const name = need(flags.title, "--title, the table's new name");
        const fields = (flags.field ?? []).map(parseField);
        if (fields.length === 0) {
          throw new UsageError('missing --field, such as --field "title:text*". A schema update replaces the whole field list');
        }
        const { json } = await client.request("PUT", `/tables/${encodeURIComponent(cid)}`, {
          body: {
            name,
            fields,
            ...(flags.parent !== undefined ? { parent_id: flags.parent } : {}),
            ...(flags.description !== undefined ? { description: flags.description } : {}),
            change_note: need(note, "--note, saying why this table changed"),
          },
          ifMatch: need(flags.version, "--version, from cairn tables"),
        });
        out(json, () => written(json));
        return 0;
      }

      // The top-level pages, the collections everything else sits under
      // (ADR-058). A thin call to the same listing `cairn ls` uses.
      case "collections":
      case "ls": {
        const parent = args[0] ?? "root";
        const { json } = await client.request(
          "GET",
          `/pages${query({ parent, limit: flags.limit, cursor: flags.cursor })}`,
        );
        out(json, () => {
          const lines = list(json?.["pages"]).map(
            (p) => `${String(p["id"])}  ${String(p["title"])}${p["has_children"] ? "  >" : ""}`,
          );
          const more = json?.["cursor"] ? `\nmore: --cursor ${String(json["cursor"])}` : "";
          return `${lines.join("\n") || "no children"}${more}\n`;
        });
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
        out(json, () => {
          const sources = list(json?.["sources"] as unknown).map((source) => `  source: ${String(source)}`);
          return `${String(json?.["id"])}  v${String(json?.["version"])}  ${JSON.stringify(json?.["values"])}\n${sources.map((line) => `${line}\n`).join("")}`;
        });
        return 0;
      }

      case "upsert": {
        const cid = need(args[0], "table id");
        const values = parseSet(need(flags.set, "--set field=value"));
        warnIfNoNote();
        const withNote = note ? { change_note: note } : {};
        const rows = `/tables/${encodeURIComponent(cid)}/rows`;
        // On an update, --source adds to the row's sources, as it does for pages.
        const { json } = flags.id
          ? await client.request("PUT", `${rows}/${encodeURIComponent(flags.id)}`, {
              body: { values, ...(flags.source ? { add_sources: flags.source } : {}), ...withNote },
              ifMatch: flags.version ?? null,
            })
          : await client.request("POST", rows, { body: { values, ...(flags.source ? { sources: flags.source } : {}), ...withNote } });
        out(json, () => written(json));
        return 0;
      }

      case "export": {
        const target = need(args[0], "a folder to export into");
        const format = flags.format ?? "cairn";
        if (format !== "cairn" && format !== "site") {
          throw new UsageError(`--format must be "cairn" or "site", not "${format}"`);
        }
        const existing = await readdir(target).catch(() => null);
        if (existing && existing.length > 0 && !flags.force) {
          throw new UsageError(`${target} is not empty. Pick a new folder, or pass --force to write into it`);
        }

        const pages = await fetchPages(flags.root);

        if (format === "site") {
          const pathOf = sitePaths(pages);
          const { childrenOf, roots } = indexPages(pages);
          const byId = new Map(pages.map((page) => [page.id, page]));
          await mkdir(target, { recursive: true });
          for (const page of pages) {
            const path = pathOf.get(page.id)!;
            const file = join(target, path);
            await mkdir(dirname(file), { recursive: true });
            const trail = trailOf(page, byId);
            await writeFile(file, renderPage({ page, path, pathOf, childrenOf, trail }), "utf8");
          }
          await writeFile(join(target, "index.html"), renderIndex(roots, pathOf), "utf8");
          if (flags["site-url"]) {
            await writeFile(join(target, "sitemap.xml"), sitemapXml(pages, pathOf, flags["site-url"]), "utf8");
          }
          out({ format: "site", pages: pages.length, target } as unknown as Json, () =>
            `exported ${pages.length} pages as a static site to ${target}\n`,
          );
          return 0;
        }

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
                const sources = list(row["sources"] as unknown).map(String);
                rows.push({
                  id: String(row["id"]),
                  values: row["values"] as Record<string, unknown>,
                  ...(sources.length > 0 ? { sources } : {}),
                });
              }
              rowCursor = (page.json?.["cursor"] as string | null) ?? null;
            } while (rowCursor !== null);
            tables.push({
              id: String(table["id"]),
              name: String(table["name"]),
              // A root export leaves out pages above the root, so a parent there is dropped.
              parent_id: typeof table["parent_id"] === "string" && (!flags.root || pages.some((p) => p.id === table["parent_id"])) ? table["parent_id"] : null,
              description: (table["description"] as string | null | undefined) ?? null,
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
          source: baseUrl,
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

      case "check-sources": {
        const timeoutMs = flags.timeout ? Number(flags.timeout) : DEFAULT_CHECK_TIMEOUT_MS;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          throw new UsageError(`--timeout must be a positive number of milliseconds, not "${flags.timeout}"`);
        }
        const [pages, tables] = await Promise.all([fetchPages(flags.root), fetchTables()]);
        const found = collectSources(pages, tables);
        const checks = await checkSources(found, io.fetch, timeoutMs);
        const dead = [...checks.entries()]
          .filter(([, check]) => !check.ok)
          .map(([href, check]) => ({
            ...check,
            found_on: found.filter((f) => f.href === href).map((f) => f.on),
          }));
        out({ checked: checks.size, dead } as unknown as Json, () => describeCheckSources(found, checks));
        return 0;
      }

      case "trust": {
        const url = need(args[0], "the address of the Cairn to trust, such as https://example.com");
        const timeoutMs = flags.timeout ? Number(flags.timeout) : DEFAULT_CHECK_TIMEOUT_MS;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          throw new UsageError(`--timeout must be a positive number of milliseconds, not "${flags.timeout}"`);
        }
        const peer = await fetchPeerDescription(url, io.fetch, timeoutMs).catch((error: unknown) => {
          throw new UsageError(error instanceof Error ? error.message : String(error));
        });

        const tablesList = await client.request("GET", "/tables");
        const existingTable = list(tablesList.json?.["tables"]).find((t) => t["name"] === TRUSTED_TABLE_NAME);
        const tableId = existingTable
          ? String(existingTable["id"])
          : String(
              (
                await client.request("POST", "/tables", {
                  body: {
                    name: TRUSTED_TABLE_NAME,
                    fields: [
                      { name: "url", type: "url", required: true },
                      { name: "name", type: "text" },
                      { name: "note", type: "text" },
                      { name: "added_at", type: "date" },
                    ],
                    change_note: "Created by cairn trust, on first use",
                  },
                })
              ).json?.["id"],
            );

        const { json: rowsJson } = await client.request("POST", `/tables/${encodeURIComponent(tableId)}/query`, {
          body: { where: [{ field: "url", op: "eq", value: url }], limit: 1 },
        });
        const existingRow = list(rowsJson?.["rows"])[0];

        const name = peer.name ?? url;
        const rowsPath = `/tables/${encodeURIComponent(tableId)}/rows`;
        const { json } = existingRow
          ? await client.request("PUT", `${rowsPath}/${encodeURIComponent(String(existingRow["id"]))}`, {
              body: { values: { url, name, ...(flags.note ? { note: flags.note } : {}) } },
              ifMatch: String(existingRow["version"]),
            })
          : await client.request("POST", rowsPath, {
              body: { values: { url, name, ...(flags.note ? { note: flags.note } : {}), added_at: new Date().toISOString() } },
            });
        out(json, () => `trusted ${name} (${url})${peer.description ? `: ${peer.description}` : ""}${existingRow ? ", updated" : ""}\n`);
        return 0;
      }

      case "discover": {
        const timeoutMs = flags.timeout ? Number(flags.timeout) : DEFAULT_CHECK_TIMEOUT_MS;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          throw new UsageError(`--timeout must be a positive number of milliseconds, not "${flags.timeout}"`);
        }
        const depth = flags.depth ? Number(flags.depth) : DEFAULT_DISCOVER_DEPTH;
        if (!Number.isInteger(depth) || depth <= 0) {
          throw new UsageError(`--depth must be a positive whole number of hops, not "${flags.depth}"`);
        }
        const limit = flags.limit ? Number(flags.limit) : DEFAULT_DISCOVER_LIMIT;
        if (!Number.isInteger(limit) || limit <= 0) {
          throw new UsageError(`--limit must be a positive whole number, not "${flags.limit}"`);
        }

        const tablesList = await client.request("GET", "/tables");
        const trustedTable = list(tablesList.json?.["tables"]).find((t) => t["name"] === TRUSTED_TABLE_NAME);
        const trustedUrls = trustedTable
          ? list((await client.request("POST", `/tables/${encodeURIComponent(String(trustedTable["id"]))}/query`, { body: { limit: 200 } })).json?.["rows"])
              .map((row) => String((row["values"] as Record<string, unknown> | undefined)?.["url"] ?? ""))
              .filter((url) => url !== "")
          : [];
        const trustedOrigins = new Set(trustedUrls.map((url) => new URL(url).origin));

        const from = [...trustedUrls, ...(flags.from ?? [])];
        if (from.length === 0) {
          throw new UsageError("no starting point. Trust a Cairn first (cairn trust <url>), or pass --from <url>");
        }

        const result = await discover({ from, fetchFn: io.fetch, timeoutMs, depth, limit, trustedOrigins });

        let discoveredTableId: string | null = null;
        if (result.found.length > 0) {
          const existingTable = list(tablesList.json?.["tables"]).find((t) => t["name"] === DISCOVERED_TABLE_NAME);
          discoveredTableId = existingTable
            ? String(existingTable["id"])
            : String(
                (
                  await client.request("POST", "/tables", {
                    body: {
                      name: DISCOVERED_TABLE_NAME,
                      fields: [
                        { name: "url", type: "url", required: true },
                        { name: "name", type: "text" },
                        { name: "discovered_via", type: "url" },
                        { name: "depth", type: "number" },
                        { name: "added_at", type: "date" },
                      ],
                      change_note: "Created by cairn discover, on first use",
                    },
                  })
                ).json?.["id"],
              );

          for (const cairn of result.found) {
            const rowsPath = `/tables/${encodeURIComponent(discoveredTableId)}/rows`;
            const { json: rowsJson } = await client.request("POST", `/tables/${encodeURIComponent(discoveredTableId)}/query`, {
              body: { where: [{ field: "url", op: "eq", value: cairn.url }], limit: 1 },
            });
            const existingRow = list(rowsJson?.["rows"])[0];
            const values = { url: cairn.url, name: cairn.name ?? cairn.url, discovered_via: cairn.discoveredVia, depth: cairn.depth };
            if (existingRow) {
              await client.request("PUT", `${rowsPath}/${encodeURIComponent(String(existingRow["id"]))}`, { body: { values }, ifMatch: String(existingRow["version"]) });
            } else {
              await client.request("POST", rowsPath, { body: { values: { ...values, added_at: new Date().toISOString() } } });
            }
          }
        }

        const json = {
          visited: result.visitedCount,
          found: result.found,
          unreachable: result.unreachable,
        };
        out(json, () => {
          const lines = [`visited ${result.visitedCount} Cairn${result.visitedCount === 1 ? "" : "s"}, found ${result.found.length} new`];
          for (const cairn of result.found) lines.push(`  ${cairn.name ?? cairn.url} (${cairn.url}), via ${cairn.discoveredVia}, depth ${cairn.depth}`);
          if (result.unreachable.length > 0) lines.push(`${result.unreachable.length} unreachable: ${result.unreachable.map((u) => u.url).join(", ")}`);
          return `${lines.join("\n")}\n`;
        });
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
          const desired = {
            title: page.title,
            body: page.body,
            parent_id: parent,
            tags: page.tags,
            sources: page.sources ?? [],
            verified_at: page.verified_at ?? null,
          };
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
            stable(now["tags"]) === stable(desired.tags) &&
            stable(now["sources"] ?? []) === stable(desired.sources) &&
            (now["verified_at"] ?? null) === desired.verified_at;
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
          const schema = {
            name: table.name,
            fields: table.fields,
            parent_id: parentId,
            description: table.description ?? null,
            change_note: change,
          };
          const current = await maybe(client, path);
          // change_note isn't part of the table's own state, and differs on every run.
          const { change_note: _changeNote, ...comparable } = schema;
          if (current === null) {
            tableTally.created += 1;
            if (!dry) await client.request("PUT", path, { body: schema });
          } else if (
            stable({
              name: current.json?.["name"],
              fields: current.json?.["fields"],
              parent_id: current.json?.["parent_id"] ?? null,
              description: current.json?.["description"] ?? null,
            }) === stable(comparable)
          ) {
            tableTally.unchanged += 1;
          } else {
            tableTally.updated += 1;
            if (!dry) await client.request("PUT", path, { body: schema, ifMatch: current.etag });
          }

          for (const row of table.rows) {
            const rowPath = `${path}/rows/${encodeURIComponent(row.id)}`;
            // In a dry run a new table has no rows to compare against.
            const existing = current === null ? null : await maybe(client, rowPath);
            const desiredRow = { values: row.values, sources: row.sources ?? [] };
            if (existing === null) {
              rowTally.created += 1;
              if (!dry) await client.request("PUT", rowPath, { body: { ...desiredRow, change_note: change } });
            } else if (
              stable(existing.json?.["values"]) === stable(row.values) &&
              stable(existing.json?.["sources"] ?? []) === stable(desiredRow.sources)
            ) {
              rowTally.unchanged += 1;
            } else {
              rowTally.updated += 1;
              if (!dry) {
                await client.request("PUT", rowPath, {
                  body: { ...desiredRow, change_note: change },
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

      case "instances": {
        const [action, name, url] = args;
        if (action === undefined) {
          const hub = registered[0];
          const lines: string[] = [];
          for (const [index, instance] of registered.entries()) {
            let last = "";
            if (hub && index > 0) {
              const state = await loadState(await statePath(credentials, hub.url, instance.url), hub.url, instance.url);
              last = state.last_sync ? `, last synced with ${hub.name} at ${state.last_sync}` : `, not yet synced with ${hub.name}`;
            }
            const start = instance.start ? `\n     cairn start runs: ${instance.start}` : "";
            lines.push(`${index + 1}. ${instance.name}  ${instance.url}${last}${start}`);
          }
          out({ instances: registered }, () =>
            registered.length === 0
              ? "no instances registered. Add one: cairn instances add laptop http://localhost:8787\n"
              : `${lines.join("\n")}\n`,
          );
          return 0;
        }
        if (action === "add") {
          let normalised: string;
          try {
            normalised = checkInstance(need(name, "a name"), need(url, "an address"), registered);
          } catch (error) {
            throw error instanceof UsageError ? error : new UsageError(error instanceof Error ? error.message : String(error));
          }
          const entry: Instance = { name: name!, url: normalised, ...(flags.start ? { start: flags.start } : {}) };
          const next = flags.first ? [entry, ...registered] : [...registered, entry];
          await saveInstances(registry, next);
          const signIn = isLoopback(normalised) ? "" : ` If it uses sign-in: cairn login --instance ${entry.name}`;
          io.stdout(`added ${entry.name} (${normalised}), number ${next.indexOf(entry) + 1} of ${next.length}.${signIn}\n`);
          if (next.length >= 2) await offerScheduledSync(next);
          return 0;
        }
        if (action === "remove") {
          const gone = named(need(name, "a name"));
          await saveInstances(registry, registered.filter((instance) => instance !== gone));
          io.stdout(`removed ${gone.name} (${gone.url}). Its sign-in and sync state are kept\n`);
          return 0;
        }
        throw new UsageError(`cannot do "cairn instances ${action}". Use add or remove`);
      }

      case "start": {
        const first = registered[0];
        if (!first) {
          throw new UsageError('cairn start needs registered instances: cairn instances add laptop http://localhost:8787 --start "pnpm dev"');
        }
        if (await reachable(first.url, io.fetch)) {
          io.stderr(`${first.name} is running\n`);
        } else if (!first.start) {
          io.stderr(
            `${first.name} (${first.url}) is not answering, and cairn has no command to start it. ` +
              `Start it yourself, or register it with one: cairn instances remove ${first.name}, then cairn instances add ${first.name} ${first.url} --first --start "command"\n`,
          );
        } else {
          if (!io.launch) throw new Error("this build of cairn cannot start programs");
          const log = join(dirname(credentials), "logs", `${first.name}.log`);
          io.stderr(`starting ${first.name}: ${first.start}\n  its output goes to ${log}\n`);
          await io.launch(first.start, log);
          const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
          let up = false;
          for (let waited = 0; waited < START_WAIT_MS && !up; waited += 1_000) {
            await sleep(1_000);
            up = await reachable(first.url, io.fetch);
          }
          if (!up) {
            io.stderr(`error: ${first.name} did not answer within ${START_WAIT_MS / 1000} seconds. See ${log}\n`);
            return 1;
          }
          io.stderr(`${first.name} is up\n`);
        }
        if (registered.length < 2) {
          io.stdout("one instance registered, so nothing to sync\n");
          return 0;
        }
        const ok = await syncAll(false);
        if (!(await jobInstalled())) io.stderr(`to keep them in sync from now on: cairn sync install --every ${describeInterval(DEFAULT_EVERY_MS)}\n`);
        return ok ? 0 : 1;
      }

      case "sync": {
        if (args[0] === "install") return await installJob();
        if (args[0] === "uninstall") return await uninstallJob();

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

        let round: () => Promise<boolean>;
        if (args.length === 0) {
          if (registered.length < 2) {
            throw new UsageError("cairn sync needs two addresses, or two or more registered instances (cairn instances add)");
          }
          round = () => syncAll(dry);
        } else {
          // A registered name works as well as an address.
          const address = (value: string) => registered.find((instance) => instance.name === value)?.url ?? normaliseUrl(value);
          const urls: Record<Side, string> = {
            a: address(need(args[0], "the first server's address")),
            b: address(need(args[1], "the second server's address")),
          };
          if (urls.a === urls.b) throw new UsageError("cairn sync needs two different servers");
          round = async () => {
            await syncPair(urls, dry);
            return true;
          };
        }

        if (every === null) return (await round()) ? 0 : 1;
        for (;;) {
          try {
            await round();
          } catch (error) {
            io.stderr(`${new Date().toISOString()} sync failed: ${reason(error)}. Trying again in ${flags.every}\n`);
          }
          await new Promise((resolve) => setTimeout(resolve, every));
        }
      }

      case "hook": {
        const [action] = args;
        const path = settingsPath(home);
        if (action === "install") {
          const result = await installHook(path, { ...(io.ask ? { ask: io.ask } : {}), stderr: io.stderr }, flags.yes === true);
          if (result.outcome === "installed") {
            io.stdout(`${result.existed ? "added to" : "created"} ${path}. A fresh Claude Code session now starts with cairn overview --brief\n`);
            return 0;
          }
          if (result.outcome === "already-installed") {
            io.stdout(`already installed in ${path}\n`);
            return 0;
          }
          io.stderr(result.outcome === "declined" ? "not installed\n" : "no answer; not installed. Pass --yes to install without asking\n");
          return 1;
        }
        if (action === "uninstall") {
          const removed = await uninstallHook(path).catch((error: unknown) => {
            throw new UsageError(error instanceof Error ? error.message : String(error));
          });
          io.stdout(removed ? `removed the session hook from ${path}\n` : `no cairn session hook in ${path}\n`);
          return 0;
        }
        if (action === "status" || action === undefined) {
          const installed = await hookInstalled(path);
          out({ installed, path, command: "cairn overview --brief" }, () =>
            installed ? `installed in ${path}, running: cairn overview --brief\n` : `not installed. Add it: cairn hook install\n`,
          );
          return 0;
        }
        throw new UsageError(`cannot do "cairn hook ${action}". Use install, uninstall or status`);
      }

      case "status": {
        const instance = flags.instance !== undefined ? named(flags.instance) : (registered.find((x) => x.url === baseUrl) ?? null);
        const isReachable = await reachable(baseUrl, io.fetch);
        let version: string | null = null;
        let embeddingsPending: number | null = null;
        if (isReachable) {
          try {
            const response = await io.fetch(new Request(`${baseUrl.replace(/\/+$/, "")}/health`));
            const body = (await response.json()) as { server?: { version?: string }; semantic_search?: { pending?: number } };
            version = body.server?.version ?? null;
            embeddingsPending = typeof body.semantic_search?.pending === "number" ? body.semantic_search.pending : null;
          } catch {
            // Answered to the reachability probe but not to this: leave both unknown.
          }
        }

        const needsSignIn = !isLoopback(baseUrl);
        const peeked = needsSignIn ? await peekCredentials(baseUrl, io.env) : null;

        const others = registered.filter((x) => x.url !== baseUrl);
        let lastSync: StatusInput["lastSync"] = null;
        for (const other of others) {
          const state = await loadState(await statePath(credentials, baseUrl, other.url), baseUrl, other.url);
          if (state.last_sync && (!lastSync || state.last_sync > lastSync.at)) lastSync = { at: state.last_sync, withName: other.name };
        }

        const installed = await jobInstalled();
        let stale = false;
        if (installed && platform !== "win32") {
          const jobFile = platform === "darwin" ? launchdPath(home) : join(systemdDir(home, io.env), `${SYSTEMD_UNIT}.service`);
          const text = await readFile(jobFile, "utf8").catch(() => "");
          stale = /<string>sync<\/string>|"sync"/.test(text) && !/<string>start<\/string>|"start"/.test(text);
        }

        const input: StatusInput = {
          instanceName: instance?.name ?? null,
          baseUrl,
          reachable: isReachable,
          version,
          signedIn: peeked !== null,
          expiresAt: peeked?.expiresAt ?? null,
          needsSignIn,
          lastSync,
          pairCount: others.length,
          embeddingsPending,
          jobInstalled: installed,
          jobStale: stale,
          hookInstalled: await hookInstalled(settingsPath(home)),
          now: Date.now(),
        };
        const lines = statusLines(input);
        const anyBad = lines.some((line) => !line.ok);
        out(
          { status: lines },
          () => `${lines.map((line) => `${line.ok ? "ok" : "!!"}  ${line.text}`).join("\n")}\n`,
        );
        return anyBad ? 1 : 0;
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
        // The server's own message is written for REST (ETag, If-Match), which
        // means nothing at a terminal. Keep only its first sentence, which
        // names what happened, and say the CLI's own next step ourselves.
        let message = error.message;
        if (error.code === "version_conflict") {
          message = error.message.split(". ")[0] ?? error.message;
          detail = `.\ncurrent version: ${String(error.body?.["current_version"])}. Read the page again, merge, and retry with that version.`;
        } else if (error.code === "unauthorized") {
          detail = io.env["CAIRN_TOKEN"]
            ? "\n  CAIRN_TOKEN was not accepted by this server."
            : "\n  Run: cairn login   (or set CAIRN_TOKEN to a service token)";
        } else if (error.code === "validation_failed" || error.code === "bad_request") {
          detail = list(error.body?.["fields"])
            .map((f) => `\n  ${String(f["field"])}: ${String(f["message"])}`)
            .join("");
        }
        io.stderr(`error: ${error.code}: ${message}${detail}\n`);
      }
      return 1;
    }
    throw error;
  }
}
