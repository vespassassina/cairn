import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ApiError, type CairnClient } from "./client.js";
import { orderTables, orderForImport, type ExportPage } from "./export-format.js";
import { mergePage, mergeRow, type Prefer } from "./merge.js";

/**
 * `cairn sync` (ADR-023): keep two Cairns the same.
 *
 * Every run reads every page, table and row from both servers and
 * compares each record with the hash both sides agreed on at the last sync.
 * A side that differs from it changed the record, and the change is copied
 * to the other side, with the time it was edited there (ADR-030).
 *
 * When both changed a page or a row, `resolveMerges` finds the version they
 * last agreed on in its history and merges the two edits, as git does: parts
 * only one side changed keep that change, and parts both changed take the
 * newer edit. Without that version, and for tables, the newer edit wins. The
 * one replaced stays in that record's history on its side (ADR-008).
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
  /**
   * When it was edited, where it was edited (ADR-030): what orders two
   * edits. The update time, from a server older than edit times.
   */
  editedAt: string;
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
  /**
   * Set when the two edits were merged (ADR-030): the source is then the
   * merged record, written to each side that differs from it. `parts` counts
   * the parts both changed, which took the newer edit, from `newer`.
   */
  merge?: { parts: number; newer: Side };
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
  editedAt: string = updatedAt,
): Promise<SyncRecord> {
  const key = kind === "row" ? `row:${tableId}/${id}` : `${kind}:${id}`;
  return { key, kind, id, tableId, label, content, hash: await sha256(stable({ kind, content })), updatedAt, version, editedAt };
}

/**
 * Sources are part of a record's content (ADR-027), but only when there are
 * some: a record without them hashes as it did before, so the first sync
 * after the upgrade, or against an older server, finds nothing changed.
 */
function withSources(sources: unknown): { sources?: string[] } {
  return Array.isArray(sources) && sources.length > 0 ? { sources: sources.map(String) } : {};
}

/** A page's verification time (ADR-028), on the same terms: only when set. */
function withVerified(verifiedAt: unknown): { verified_at?: string } {
  return typeof verifiedAt === "string" && verifiedAt !== "" ? { verified_at: verifiedAt } : {};
}

/**
 * A page's content in the shape sync compares, from a page or a revision of one.
 *
 * Only these fields travel. `public` is deliberately not one of them: being
 * published belongs to a server, not to the content, so a sync can never
 * publish anything anywhere (ADR-032 decision 6).
 */
function pageContent(page: Json): Json {
  return {
    title: page["title"],
    parent_id: page["parent_id"] ?? null,
    tags: page["tags"] ?? [],
    body: page["body"],
    ...withSources(page["sources"]),
    ...withVerified(page["verified_at"]),
  };
}

function rowContent(row: Json): Json {
  return { values: row["values"], ...withSources(row["sources"]) };
}

/** The edit time a server sent, or its update time if it is older than edit times. */
const editedAt = (item: Json) => String(item["edited_at"] ?? item["updated_at"]);

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
      add(await record("page", String(page["id"]), null, String(page["title"]), pageContent(page), String(page["updated_at"]), String(page["version"]), editedAt(page)));
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
        add(await record("row", rid, cid, `${name} / ${rid}`, rowContent(row), String(row["updated_at"]), String(row["version"]), editedAt(row)));
      }
      rowCursor = (page.json?.["cursor"] as string | null) ?? null;
    } while (rowCursor !== null);
  }
  return snapshot;
}

/**
 * Which of two edits of one record is newer: the later edit time, and on a
 * tie the larger hash, so both directions of a sync pick the same one.
 */
export function newer(a: SyncRecord, b: SyncRecord): Side {
  const ta = Date.parse(a.editedAt);
  const tb = Date.parse(b.editedAt);
  if (ta !== tb) return ta > tb ? "a" : "b";
  return a.hash >= b.hash ? "a" : "b";
}

/** What to write where, by the rules in ADR-023 decision 1 and ADR-030. */
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
      else from = newer(ra, rb);
    }

    const source = from === "a" ? ra : rb;
    const target = from === "a" ? rb : ra;
    const kind = (source ?? target)!.kind;
    actions.push({ key, kind, op: source === null ? "delete" : "put", to: other(from), source, target, conflict });
  }
  return { actions, base: agreed };
}

/** How far back in a record's history to look for the version both sides last agreed on. */
export const MAX_BASE_SEARCH = 50;

const recordPath = (item: SyncRecord) =>
  item.kind === "page"
    ? `/pages/${encodeURIComponent(item.id)}`
    : `/tables/${encodeURIComponent(item.tableId!)}/rows/${encodeURIComponent(item.id)}`;

/**
 * The content a record had when its hash was `hash`, from its history on
 * one server, or null when that version is not there: pruned, or older than
 * {@link MAX_BASE_SEARCH} writes.
 */
async function findBase(client: CairnClient, item: SyncRecord, hash: string): Promise<Json | null> {
  const path = recordPath(item);
  let revisions: Json[];
  try {
    revisions = list((await client.request("GET", `${path}/history?limit=${MAX_BASE_SEARCH}`)).json?.["revisions"]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
  // The newest is the record as it is now, which changed since the base.
  for (const revision of revisions.slice(1)) {
    if (revision["deleted"]) continue;
    const { json } = await client.request("GET", `${path}/revisions/${encodeURIComponent(String(revision["version"]))}`);
    if (!json) continue;
    const content = item.kind === "page" ? pageContent(json) : rowContent(json);
    if ((await record(item.kind, item.id, item.tableId, item.label, content, "", "")).hash === hash) return content;
  }
  return null;
}

/**
 * Turns each conflict between two edits of a page or row into a merge
 * (ADR-030): the version both sides last agreed on is found in the record's
 * history on either side, and the merged record is written to each side
 * that differs from it. A conflict that cannot be merged (no base found, a
 * table, a deletion, a body too large) stays as it is: the newer edit wins.
 * Reads only, so a dry run can say what would be merged.
 */
export async function resolveMerges(syncPlan: SyncPlan, clients: Record<Side, CairnClient>, base: Base): Promise<SyncPlan> {
  const actions: SyncAction[] = [];
  for (const action of syncPlan.actions) {
    const last = base[action.key];
    if (!action.conflict || action.op !== "put" || action.kind === "table" || action.target === null || last === undefined) {
      actions.push(action);
      continue;
    }
    const from = other(action.to);
    const ra = from === "a" ? action.source! : action.target;
    const rb = from === "a" ? action.target : action.source!;
    const common = (await findBase(clients.a, ra, last)) ?? (await findBase(clients.b, rb, last));
    const prefer: Prefer = from;
    const merged = common === null ? null : ra.kind === "page" ? mergePage(common, ra.content, rb.content, prefer) : mergeRow(common, ra.content, rb.content, prefer);
    if (merged === null) {
      actions.push(action);
      continue;
    }
    // After both edits it merges, so it orders after each of them.
    const time = new Date(Math.max(Date.parse(ra.editedAt), Date.parse(rb.editedAt)) + 1).toISOString();
    const label = ra.kind === "page" ? String(merged.value["title"]) : ra.label;
    const result = await record(ra.kind, ra.id, ra.tableId, label, merged.value, time, "", time);
    for (const [side, current] of [["a", ra], ["b", rb]] as const) {
      if (current.hash === result.hash) continue;
      actions.push({ ...action, to: side, source: result, target: current, merge: { parts: merged.conflicts, newer: from } });
    }
  }
  return { actions, base: syncPlan.base };
}

/**
 * Confirms every planned deletion before it is applied (ADR-060). `plan`
 * only sees who currently holds which hash: a key present with the last-
 * agreed hash on one side and simply absent from the other's snapshot looks
 * the same whether that other side genuinely deleted it or has lost the
 * record some other way (a bug, a bad replica, a page a snapshot failed to
 * enumerate). Propagating the second case as a delete destroys the only
 * surviving copy, which is exactly what turned an earlier, unrelated data
 * loss on the Cairn server into a second, sync-caused one (see
 * `docs/LESSONS.md`, "A sync-caused, repeatable data loss" and the original
 * "Eleven pages vanished" entry it corrects).
 *
 * A page's own history survives its deletion (ADR-059): a real delete always
 * leaves at least one revision behind, `history` starting from it even
 * though the page itself is gone. So the side that appears to have deleted
 * a page is asked for that page's history; a non-empty answer confirms a
 * real deletion, safe to propagate. An empty answer means there is no
 * evidence a deletion ever happened there, so the action is turned into a
 * `put` that recreates the page on the side missing it, and a warning says
 * so, rather than silently deleting the side that still has it.
 *
 * Rows have no history endpoint to check this against (ADR-005: search and
 * history are page concerns), so a missing row is still taken as deleted;
 * ADR-060 accepts that narrower risk rather than leaving pages unprotected
 * until rows grow the same history support.
 */
export async function verifyDeletes(
  syncPlan: SyncPlan,
  clients: Record<Side, CairnClient>,
): Promise<{ plan: SyncPlan; warnings: string[] }> {
  const actions: SyncAction[] = [];
  const warnings: string[] = [];
  for (const action of syncPlan.actions) {
    if (action.op !== "delete" || action.kind !== "page" || action.target === null) {
      actions.push(action);
      continue;
    }
    const from = other(action.to);
    let hasHistory = false;
    try {
      const { json } = await clients[from].request("GET", `/pages/${encodeURIComponent(action.target.id)}/history?limit=1`);
      hasHistory = list(json?.["revisions"]).length > 0;
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    if (hasHistory) {
      actions.push(action);
      continue;
    }
    warnings.push(
      `${action.target.label} (${action.target.id}) is not deleted: it has no history at all on ${clients[from].baseUrl}, so its absence there is not proof it was deleted. Recreating it there from ${clients[action.to].baseUrl} instead of deleting the copy that still exists.`,
    );
    actions.push({ ...action, op: "put", to: from, source: action.target, target: null, conflict: false });
  }
  return { plan: { actions, base: syncPlan.base }, warnings };
}

export interface SyncReport {
  written: Record<Side, { pages: number; tables: number; rows: number; deleted: number }>;
  /**
   * Records both sides changed. `merged`: the edits were merged, and `parts`
   * counts the parts both changed, which kept the newer edit.
   */
  conflicts: Array<{ key: string; label: string; kept_from: string; merged: boolean; parts: number }>;
  /** Records both sides changed in different parts, merged with nothing lost. */
  merged: Array<{ key: string; label: string }>;
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
    merged: [],
    warnings: [],
    skipped: [],
    unchanged: Object.keys(syncPlan.base).length,
  };

  const reported = new Set<string>();
  // A key whose write was skipped keeps the base from before this run, even
  // when a merge wrote it to the other side: the next run merges again.
  const failed = new Set<string>();
  const keepPrevious = (key: string) => {
    failed.add(key);
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
      if (action.conflict && !reported.has(action.key)) {
        reported.add(action.key);
        const { label } = action.source!;
        if (action.merge === undefined) {
          report.conflicts.push({ key: action.key, label, kept_from: sides[other(action.to)].url, merged: false, parts: 0 });
        } else if (action.merge.parts === 0) {
          report.merged.push({ key: action.key, label });
        } else {
          report.conflicts.push({ key: action.key, label, kept_from: sides[action.merge.newer].url, merged: true, parts: action.merge.parts });
        }
      }
    } else {
      delete base[action.key];
      report.written[action.to].deleted += 1;
    }
  };

  const note = (action: SyncAction) => {
    const from = sides[other(action.to)].url;
    if (action.op === "delete") return `Synced from ${from}, where it was deleted`;
    if (action.merge !== undefined) {
      const { parts, newer: side } = action.merge;
      if (parts === 0) return `Merged in sync with ${from}: both changed it since the last sync, in different parts`;
      const kept = side === action.to ? "this server's edit" : `the edit from ${from}`;
      return `Merged in sync with ${from}. Sync conflict: ${parts === 1 ? "1 part" : `${parts} parts`} changed on both kept the newer edit, ${kept}; the version this replaced is in this record's history`;
    }
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
          client.request("PUT", `/tables/${encodeURIComponent(source.id)}`, {
            body: { ...source.content, parent_id: parent, change_note: note(action) },
            ifMatch,
          }),
        );
      } else if (kind === "page") {
        let parent = (source.content["parent_id"] as string | null) ?? null;
        if (parent !== null && !willExist(action.to, parent)) {
          report.warnings.push(`${source.label} (${source.id}) moved to top level on ${sides[action.to].url}, because its parent ${parent} is not there`);
          parent = null;
        }
        await write(action, () =>
          client.request("PUT", `/pages/${encodeURIComponent(source.id)}`, {
            // Always send the list and the time, empty too, so a removal
            // reaches the other side.
            body: { sources: [], verified_at: null, ...source.content, parent_id: parent, edited_at: source.editedAt, change_note: note(action) },
            ifMatch,
          }),
        );
      } else {
        await write(action, () =>
          client.request(
            "PUT",
            `/tables/${encodeURIComponent(source.tableId!)}/rows/${encodeURIComponent(source.id)}`,
            { body: { sources: [], ...source.content, edited_at: source.editedAt, change_note: note(action) }, ifMatch },
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

  for (const key of failed) {
    if (previous[key] !== undefined) base[key] = previous[key];
    else delete base[key];
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
