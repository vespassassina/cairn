import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ApiError, type CairnClient } from "./client.js";
import { orderTables, orderForImport, type ExportPage } from "./export-format.js";

/**
 * `cairn sync` (ADR-023): keep two Cairns the same.
 *
 * Every run reads every page, table and row from both servers and
 * compares each record with the hash both sides agreed on at the last sync.
 * A side that differs from it changed the record, and the change is copied
 * to the other side. When both changed, the newer edit wins, and the one it
 * replaces stays in that record's history on its side (ADR-008).
 *
 * `plan` is pure, so the rules are easy to test; `apply` does the writes
 * through the REST API, like any other client (ADR-013 rule 5).
 */

type Json = Record<string, unknown>;
const list = (value: unknown) => (Array.isArray(value) ? (value as Json[]) : []);

export type Kind = "page" | "table" | "row";
export type Side = "a" | "b";

export interface SyncRecord {
  /** `page:<id>`, `table:<id>` or `row:<table id>/<row id>`. */
  key: string;
  kind: Kind;
  id: string;
  tableId: string | null;
  /** A title or name, for reports. */
  label: string;
  /** What a person wrote. Versions, times and actors are left out. */
  content: Json;
  hash: string;
  updatedAt: string;
  version: string;
}

export type Snapshot = Map<string, SyncRecord>;

/** The hash both sides held at the last sync, by record key. */
export type Base = Record<string, string>;

export interface SyncAction {
  key: string;
  kind: Kind;
  op: "put" | "delete";
  to: Side;
  /** The record to copy, for a put. */
  source: SyncRecord | null;
  /** The record as it is on the side being written, if it exists there. */
  target: SyncRecord | null;
  /** True when both sides changed it since the last sync. */
  conflict: boolean;
}

export interface SyncPlan {
  actions: SyncAction[];
  /** Base entries for the records that are already the same on both sides. */
  base: Base;
}

export const other = (side: Side): Side => (side === "a" ? "b" : "a");

/** JSON with sorted keys, so two equal values compare equal whatever their order. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Json).sort(([x], [y]) => x.localeCompare(y)))
      : inner,
  );
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function record(
  kind: Kind,
  id: string,
  tableId: string | null,
  label: string,
  content: Json,
  updatedAt: string,
  version: string,
): Promise<SyncRecord> {
  const key = kind === "row" ? `row:${tableId}/${id}` : `${kind}:${id}`;
  return { key, kind, id, tableId, label, content, hash: await sha256(stable({ kind, content })), updatedAt, version };
}

/**
 * Sources are part of a record's content (ADR-027), but only when there are
 * some: a record without them hashes as it did before, so the first sync
 * after the upgrade, or against an older server, finds nothing changed.
 */
function withSources(sources: unknown): { sources?: string[] } {
  return Array.isArray(sources) && sources.length > 0 ? { sources: sources.map(String) } : {};
}

/** Every page, table and row on one server. */
export async function readSide(client: CairnClient): Promise<Snapshot> {
  const snapshot: Snapshot = new Map();
  const add = (entry: SyncRecord) => snapshot.set(entry.key, entry);

  let cursor: string | null = null;
  do {
    const { json } = await client.request(
      "GET",
      `/export/pages?limit=100${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
    );
    for (const page of list(json?.["pages"])) {
      const content = {
        title: page["title"],
        parent_id: page["parent_id"] ?? null,
        tags: page["tags"] ?? [],
        body: page["body"],
        ...withSources(page["sources"]),
      };
      add(await record("page", String(page["id"]), null, String(page["title"]), content, String(page["updated_at"]), String(page["version"])));
    }
    cursor = (json?.["cursor"] as string | null) ?? null;
  } while (cursor !== null);

  const { json } = await client.request("GET", "/tables");
  for (const table of list(json?.["tables"])) {
    const cid = String(table["id"]);
    const name = String(table["name"]);
    const content = { name, fields: table["fields"], parent_id: table["parent_id"] ?? null };
    add(await record("table", cid, null, name, content, String(table["updated_at"]), String(table["version"])));
    let rowCursor: string | null = null;
    do {
      const page = await client.request(
        "GET",
        `/tables/${encodeURIComponent(cid)}/rows?limit=200${rowCursor === null ? "" : `&cursor=${encodeURIComponent(rowCursor)}`}`,
      );
      for (const row of list(page.json?.["rows"])) {
        const rid = String(row["id"]);
        add(await record("row", rid, cid, `${name} / ${rid}`, { values: row["values"], ...withSources(row["sources"]) }, String(row["updated_at"]), String(row["version"])));
      }
      rowCursor = (page.json?.["cursor"] as string | null) ?? null;
    } while (rowCursor !== null);
  }
  return snapshot;
}

/** What to write where, by the rules in ADR-023 decision 1. */
export function plan(a: Snapshot, b: Snapshot, base: Base): SyncPlan {
  const actions: SyncAction[] = [];
  const agreed: Base = {};
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();

  for (const key of keys) {
    const ra = a.get(key) ?? null;
    const rb = b.get(key) ?? null;
    const ha = ra?.hash ?? null;
    const hb = rb?.hash ?? null;
    const last = base[key] ?? null;

    if (ha === hb) {
      if (ha !== null) agreed[key] = ha;
      continue;
    }

    let from: Side;
    let conflict = false;
    if (last !== null && ha === last) {
      from = "b";
    } else if (last !== null && hb === last) {
      from = "a";
    } else {
      // Both changed since the last sync, or there was none. An edit beats a
      // deletion; between two edits, the newer one wins.
      conflict = ra !== null && rb !== null ? true : last !== null;
      if (ra === null) from = "b";
      else if (rb === null) from = "a";
      else from = Date.parse(ra.updatedAt) >= Date.parse(rb.updatedAt) ? "a" : "b";
    }

    const source = from === "a" ? ra : rb;
    const target = from === "a" ? rb : ra;
    const kind = (source ?? target)!.kind;
    actions.push({ key, kind, op: source === null ? "delete" : "put", to: other(from), source, target, conflict });
  }
  return { actions, base: agreed };
}

export interface SyncReport {
  written: Record<Side, { pages: number; tables: number; rows: number; deleted: number }>;
  conflicts: Array<{ key: string; label: string; kept_from: string }>;
  warnings: string[];
  skipped: string[];
  unchanged: number;
}

// Pages first, so a table's parent is there before it moves under it (ADR-024).
const WRITE_ORDER: Kind[] = ["page", "table", "row"];

/**
 * Carries out a plan. Records that changed between the read and the write
 * are skipped and left for the next run. Returns the base to save: what both
 * sides now agree on.
 */
export async function apply(
  syncPlan: SyncPlan,
  sides: Record<Side, { url: string; client: CairnClient; snapshot: Snapshot }>,
  previous: Base,
): Promise<{ report: SyncReport; base: Base }> {
  const base: Base = { ...syncPlan.base };
  const report: SyncReport = {
    written: {
      a: { pages: 0, tables: 0, rows: 0, deleted: 0 },
      b: { pages: 0, tables: 0, rows: 0, deleted: 0 },
    },
    conflicts: [],
    warnings: [],
    skipped: [],
    unchanged: Object.keys(syncPlan.base).length,
  };

  const keepPrevious = (key: string) => {
    if (previous[key] !== undefined) base[key] = previous[key];
  };

  const write = async (action: SyncAction, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 409 || error.status === 412 || error.status === 428)) {
        report.skipped.push(`${action.key}: changed on ${sides[action.to].url} while syncing; the next run picks it up`);
        keepPrevious(action.key);
        return;
      }
      if (!(error instanceof ApiError && error.status === 404 && action.op === "delete")) throw error;
    }
    if (action.op === "put") {
      base[action.key] = action.source!.hash;
      const counts = report.written[action.to];
      if (action.kind === "page") counts.pages += 1;
      else if (action.kind === "table") counts.tables += 1;
      else counts.rows += 1;
      if (action.conflict) {
        report.conflicts.push({ key: action.key, label: action.source!.label, kept_from: sides[other(action.to)].url });
      }
    } else {
      delete base[action.key];
      report.written[action.to].deleted += 1;
    }
  };

  const note = (action: SyncAction) => {
    const from = sides[other(action.to)].url;
    if (action.op === "delete") return `Synced from ${from}, where it was deleted`;
    if (!action.conflict) return `Synced from ${from}`;
    return `Synced from ${from}. Sync conflict: this was the newer edit; the one it replaced is in this record's history`;
  };

  // Where each page will be once the run is done, to keep parents valid.
  const willExist = (side: Side, pageId: string) => {
    const key = `page:${pageId}`;
    const deleted = syncPlan.actions.some((x) => x.key === key && x.to === side && x.op === "delete");
    const created = syncPlan.actions.some((x) => x.key === key && x.to === side && x.op === "put");
    return created || (sides[side].snapshot.has(key) && !deleted);
  };

  const puts = syncPlan.actions.filter((action) => action.op === "put");
  for (const kind of WRITE_ORDER) {
    let batch = puts.filter((action) => action.kind === kind);
    if (kind === "page") {
      // Parents first, so a new child never points at a page not yet there.
      const byId = new Map(batch.map((action) => [`${action.to}:${action.source!.id}`, action]));
      const ordered: SyncAction[] = [];
      for (const side of ["a", "b"] as const) {
        const pages: ExportPage[] = batch
          .filter((action) => action.to === side)
          .map((action) => ({ id: action.source!.id, parent_id: (action.source!.content["parent_id"] as string | null) ?? null, title: "", tags: [], body: "" }));
        for (const page of orderForImport(pages)) ordered.push(byId.get(`${side}:${page.id}`)!);
      }
      batch = ordered;
    } else if (kind === "table") {
      // A relation's target table before the table that points at it.
      const byKey = new Map(batch.map((action) => [`${action.to}:${action.source!.id}`, action]));
      const ordered: SyncAction[] = [];
      for (const side of ["a", "b"] as const) {
        const items = batch
          .filter((action) => action.to === side)
          .map((action) => ({ id: action.source!.id, fields: (action.source!.content["fields"] as unknown[]) ?? [] }));
        for (const item of orderTables(items)) ordered.push(byKey.get(`${side}:${item.id}`)!);
      }
      batch = ordered;
    }

    for (const action of batch) {
      const { client } = sides[action.to];
      const source = action.source!;
      const ifMatch = action.target?.version ?? null;
      if (kind === "table") {
        let parent = (source.content["parent_id"] as string | null) ?? null;
        if (parent !== null && !willExist(action.to, parent)) {
          report.warnings.push(`${source.label} (${source.id}) moved to top level on ${sides[action.to].url}, because its parent ${parent} is not there`);
          parent = null;
        }
        await write(action, () =>
          client.request("PUT", `/tables/${encodeURIComponent(source.id)}`, { body: { ...source.content, parent_id: parent }, ifMatch }),
        );
      } else if (kind === "page") {
        let parent = (source.content["parent_id"] as string | null) ?? null;
        if (parent !== null && !willExist(action.to, parent)) {
          report.warnings.push(`${source.label} (${source.id}) moved to top level on ${sides[action.to].url}, because its parent ${parent} is not there`);
          parent = null;
        }
        await write(action, () =>
          client.request("PUT", `/pages/${encodeURIComponent(source.id)}`, {
            // Always send the list, empty too, so a removal reaches the other side.
            body: { sources: [], ...source.content, parent_id: parent, change_note: note(action) },
            ifMatch,
          }),
        );
      } else {
        await write(action, () =>
          client.request(
            "PUT",
            `/tables/${encodeURIComponent(source.tableId!)}/rows/${encodeURIComponent(source.id)}`,
            { body: { sources: [], ...source.content, change_note: note(action) }, ifMatch },
          ),
        );
      }
    }
  }

  // Deletions: rows, then pages, deepest first.
  const deletes = syncPlan.actions.filter((action) => action.op === "delete");
  for (const action of deletes.filter((x) => x.kind === "row")) {
    const target = action.target!;
    await write(action, () =>
      sides[action.to].client.request(
        "DELETE",
        `/tables/${encodeURIComponent(target.tableId!)}/rows/${encodeURIComponent(target.id)}`,
        { body: { change_note: note(action) }, ifMatch: target.version },
      ),
    );
  }
  const depth = (side: Side, pageId: string) => {
    let level = 0;
    let current = sides[side].snapshot.get(`page:${pageId}`);
    const seen = new Set<string>();
    while (current && current.content["parent_id"] && !seen.has(current.id) && level < 64) {
      seen.add(current.id);
      level += 1;
      current = sides[side].snapshot.get(`page:${String(current.content["parent_id"])}`);
    }
    return level;
  };
  const pageDeletes = deletes
    .filter((x) => x.kind === "page")
    .sort((x, y) => depth(y.to, y.target!.id) - depth(x.to, x.target!.id));
  for (const action of pageDeletes) {
    const target = action.target!;
    await write(action, () =>
      sides[action.to].client.request("DELETE", `/pages/${encodeURIComponent(target.id)}`, {
        body: { change_note: note(action) },
        ifMatch: target.version,
      }),
    );
  }
  for (const action of deletes.filter((x) => x.kind === "table")) {
    report.warnings.push(
      `table ${action.target!.label} (${action.target!.id}) is gone from ${sides[other(action.to)].url} but not from ${sides[action.to].url}; sync cannot delete tables`,
    );
    keepPrevious(action.key);
  }

  return { report, base };
}

// State: one file per pair of servers, next to the CLI's credentials.

export interface SyncState {
  servers: [string, string];
  last_sync: string | null;
  base: Base;
}

export const normaliseUrl = (url: string) => url.replace(/\/+$/, "");

export async function statePath(credentialsFile: string, a: string, b: string): Promise<string> {
  const pair = [normaliseUrl(a), normaliseUrl(b)].sort().join("\n");
  return join(dirname(credentialsFile), "sync", `${(await sha256(pair)).slice(0, 16)}.json`);
}

export async function loadState(path: string, a: string, b: string): Promise<SyncState> {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as SyncState;
    if (state && typeof state.base === "object" && state.base !== null) {
      // Saved before ADR-026, when a table was keyed `collection:<id>`.
      for (const key of Object.keys(state.base)) {
        if (!key.startsWith("collection:")) continue;
        state.base[`table:${key.slice("collection:".length)}`] = state.base[key]!;
        delete state.base[key];
      }
      return state;
    }
  } catch {
    // No state yet, or unreadable: every difference is treated as a conflict.
  }
  return { servers: [normaliseUrl(a), normaliseUrl(b)], last_sync: null, base: {} };
}

export async function saveState(path: string, state: SyncState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** "30s", "5m" or "2h", at least 30 seconds, as milliseconds. */
export function parseInterval(raw: string): number {
  const match = /^(\d+)(s|m|h)$/.exec(raw.trim());
  if (!match) throw new Error(`cannot read --every "${raw}". Use a number and s, m or h, such as 5m`);
  const ms = Number(match[1]) * { s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as "s" | "m" | "h"];
  if (ms < 30_000) throw new Error("--every must be at least 30s");
  return ms;
}
