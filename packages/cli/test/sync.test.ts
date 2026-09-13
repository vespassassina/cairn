import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeContext, createApp, createContext, OWNER, type AppContext } from "@cairn/api";
import { run, type Io } from "../src/main.js";
import { parseInterval, plan, record, type Snapshot, type SyncRecord } from "../src/sync.js";

/**
 * cairn sync (ADR-023): two real Cairns, driven through the command, must end
 * up the same, with the newer edit winning a conflict and the other kept in
 * history.
 */

const A_URL = "http://localhost:4001";
const B_URL = "http://localhost:4002";
const BY = { actor: OWNER, note: null };

let a: AppContext;
let b: AppContext;
let apps: Map<string, ReturnType<typeof createApp>>;
let config: string;
let stdout: string;
let stderr: string;

function io(): Io {
  return {
    fetch: async (request) => apps.get(new URL(request.url).origin)!.fetch(request),
    env: { XDG_CONFIG_HOME: config, APPDATA: config },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: async () => null,
  };
}

async function cairn(...argv: string[]): Promise<number> {
  stdout = "";
  stderr = "";
  return run(argv, io());
}

const sync = (...extra: string[]) => cairn("sync", A_URL, B_URL, ...extra);

async function seed(context: AppContext) {
  const ws = context.workspaceId;
  const healing = await context.pages.create(ws, { title: "Recovery & healing", body: "Category.", tags: ["category"] }, BY, "pg_cat_healing");
  await context.pages.create(ws, { title: "BPC-157", parentId: healing.id, body: "## Status\n\nResearch only.\n", tags: ["peptide"] }, BY, "pg_bpc-157");
  await context.pages.create(ws, { title: "TB-500", parentId: healing.id, body: "Pairs with [[pg_bpc-157]].", tags: ["peptide"] }, BY, "pg_tb-500");
  const peptides = await context.collections.create(
    ws,
    { name: "Peptides", fields: [{ name: "name", type: "text", required: true }, { name: "grams", type: "number" }] },
    BY,
    "col_peptides",
  );
  await context.collections.upsertRow(ws, peptides.id, { values: { name: "BPC-157", grams: 5 } }, BY, { id: "row_bpc" });
  await context.collections.upsertRow(ws, peptides.id, { values: { name: "TB-500", grams: 2 } }, BY, { id: "row_tb" });
}

async function edit(context: AppContext, id: string, body: string) {
  const page = await context.pages.get(context.workspaceId, id);
  // Distinct timestamps, so "newer" is never a tie.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return context.pages.update(context.workspaceId, id, { title: page.title, parentId: page.parentId, tags: page.tags, body }, page.version, BY);
}

async function pageOrNull(context: AppContext, id: string) {
  return context.pages.get(context.workspaceId, id).catch(() => null);
}

beforeEach(async () => {
  a = await createContext({ database: ":memory:", workspaceId: "ws_a" });
  b = await createContext({ database: ":memory:", workspaceId: "ws_b" });
  const trust = { enabled: true, hosts: ["localhost"] };
  apps = new Map([
    [A_URL, createApp({ context: a, token: null, trust })],
    [B_URL, createApp({ context: b, token: null, trust })],
  ]);
  config = await mkdtemp(join(tmpdir(), "cairn-sync-test-"));
});

afterEach(async () => {
  await closeContext(a);
  await closeContext(b);
  await rm(config, { recursive: true, force: true });
});

describe("cairn sync between two servers", () => {
  it("copies everything into an empty Cairn, keeping ids, tree and rows", async () => {
    await seed(a);
    expect(await sync()).toBe(0);
    expect(stdout).toContain(`to ${B_URL}: 3 pages, 1 collection, 2 rows written`);

    const bpc = await b.pages.get(b.workspaceId, "pg_bpc-157");
    expect(bpc.parentId).toBe("pg_cat_healing");
    expect(bpc.body).toBe("## Status\n\nResearch only.\n");
    expect(bpc.tags).toEqual(["peptide"]);
    const row = await b.collections.getRow(b.workspaceId, "col_peptides", "row_tb");
    expect(row.values).toEqual({ name: "TB-500", grams: 2 });

    const history = await b.pages.history(b.workspaceId, "pg_bpc-157");
    expect(history[0]!.note).toBe(`Synced from ${A_URL}`);

    // A second run finds nothing to do.
    expect(await sync()).toBe(0);
    expect(stdout).toContain(`to ${A_URL}: nothing to change`);
    expect(stdout).toContain(`to ${B_URL}: nothing to change`);
    expect(stdout).toContain("6 records already the same");
  });

  it("keeps its state out of the way, one file per pair of servers", async () => {
    await seed(a);
    await sync();
    expect(await readdir(join(config, "cairn", "sync"))).toHaveLength(1);
    // The same pair in the other order shares the file.
    await cairn("sync", B_URL, A_URL);
    expect(await readdir(join(config, "cairn", "sync"))).toHaveLength(1);
    expect(stdout).toContain("nothing to change");
  });

  it("copies an edit made on either side to the other", async () => {
    await seed(a);
    await sync();
    await edit(b, "pg_tb-500", "Edited on B.");
    await edit(a, "pg_bpc-157", "Edited on A.");
    const version = (await b.collections.getRow(b.workspaceId, "col_peptides", "row_bpc")).version;
    await b.collections.upsertRow(b.workspaceId, "col_peptides", { values: { name: "BPC-157", grams: 10 } }, BY, { id: "row_bpc", expectedVersion: version });

    expect(await sync()).toBe(0);
    expect((await a.pages.get(a.workspaceId, "pg_tb-500")).body).toBe("Edited on B.");
    expect((await b.pages.get(b.workspaceId, "pg_bpc-157")).body).toBe("Edited on A.");
    expect((await a.collections.getRow(a.workspaceId, "col_peptides", "row_bpc")).values["grams"]).toBe(10);
    expect(stdout).not.toContain("conflict");
  });

  it("copies records created on both sides", async () => {
    await seed(a);
    await sync();
    await a.pages.create(a.workspaceId, { title: "Made on A", body: "a" }, BY, "pg_made_a");
    await b.pages.create(b.workspaceId, { title: "Made on B", parentId: "pg_cat_healing", body: "b" }, BY, "pg_made_b");
    await sync();
    expect((await b.pages.get(b.workspaceId, "pg_made_a")).title).toBe("Made on A");
    expect((await a.pages.get(a.workspaceId, "pg_made_b")).parentId).toBe("pg_cat_healing");
  });

  it("copies a deletion, of a page or a row", async () => {
    await seed(a);
    await sync();
    const tb = await a.pages.get(a.workspaceId, "pg_tb-500");
    await a.pages.delete(a.workspaceId, "pg_tb-500", tb.version, BY);
    const row = await b.collections.getRow(b.workspaceId, "col_peptides", "row_tb");
    await b.collections.deleteRow(b.workspaceId, "col_peptides", "row_tb", row.version, BY);

    await sync();
    expect(await pageOrNull(b, "pg_tb-500")).toBeNull();
    await expect(a.collections.getRow(a.workspaceId, "col_peptides", "row_tb")).rejects.toThrow();
    expect(stdout).toContain(`to ${B_URL}: 1 deleted`);
  });

  it("lets the newer edit win a conflict, and keeps the other in history", async () => {
    await seed(a);
    await sync();
    await edit(a, "pg_bpc-157", "Older edit, on A.");
    await edit(b, "pg_bpc-157", "Newer edit, on B.");

    await sync();
    expect((await a.pages.get(a.workspaceId, "pg_bpc-157")).body).toBe("Newer edit, on B.");
    expect((await b.pages.get(b.workspaceId, "pg_bpc-157")).body).toBe("Newer edit, on B.");
    expect(stdout).toContain(`conflict: BPC-157 changed on both; kept the newer edit, from ${B_URL}`);

    const history = await a.pages.history(a.workspaceId, "pg_bpc-157");
    expect(history[0]!.note).toContain("Sync conflict");
    const replaced = await a.pages.revision(a.workspaceId, "pg_bpc-157", history[1]!.version);
    expect(replaced.snapshot.body).toBe("Older edit, on A.");
  });

  it("lets an edit win over a deletion made on the other side", async () => {
    await seed(a);
    await sync();
    const tb = await a.pages.get(a.workspaceId, "pg_tb-500");
    await a.pages.delete(a.workspaceId, "pg_tb-500", tb.version, BY);
    await edit(b, "pg_tb-500", "Still needed.");

    await sync();
    expect((await a.pages.get(a.workspaceId, "pg_tb-500")).body).toBe("Still needed.");
    expect((await b.pages.get(b.workspaceId, "pg_tb-500")).body).toBe("Still needed.");
  });

  it("settles two Cairns that already hold the same pages without writing", async () => {
    // A migration done earlier by export and import: same content, no state.
    await seed(a);
    await seed(b);
    expect(await sync()).toBe(0);
    expect(stdout).toContain(`to ${A_URL}: nothing to change`);
    expect(stdout).toContain(`to ${B_URL}: nothing to change`);
    expect((await b.pages.history(b.workspaceId, "pg_bpc-157"))).toHaveLength(1);
  });

  it("writes nothing in a dry run, and says what it would do", async () => {
    await seed(a);
    expect(await sync("--dry-run")).toBe(0);
    expect(stdout).toContain(`write to ${B_URL}: page BPC-157`);
    expect(await pageOrNull(b, "pg_bpc-157")).toBeNull();
  });

  it("copies collections in the tree and linked rows, targets first (ADR-024)", async () => {
    const ws = a.workspaceId;
    await a.pages.create(ws, { title: "Peptides", body: "Hub." }, BY, "pg_home");
    // Named so the linking collection sorts before its target.
    await a.collections.create(ws, { name: "Targets", parentId: "pg_home", fields: [{ name: "name", type: "text", required: true }] }, BY, "col_z_targets");
    await a.collections.create(
      ws,
      { name: "Links", parentId: "pg_home", fields: [{ name: "title", type: "text", required: true }, { name: "to", type: "relation", target: "col_z_targets", multiple: true }] },
      BY,
      "col_a_links",
    );
    await a.collections.upsertRow(ws, "col_z_targets", { values: { name: "BPC-157" } }, BY, { id: "row_bpc" });
    await a.collections.upsertRow(ws, "col_a_links", { values: { title: "Stack", to: ["row_bpc"] } }, BY, { id: "row_stack" });

    expect(await sync()).toBe(0);
    expect(stderr).toBe("");
    expect((await b.collections.get(b.workspaceId, "col_a_links")).parentId).toBe("pg_home");
    expect((await b.collections.rowBacklinks(b.workspaceId, "col_z_targets", "row_bpc")).map((e) => e.sourceId)).toEqual(["col_a_links/row_stack"]);

    // A move on one side reaches the other.
    const links = await b.collections.get(b.workspaceId, "col_a_links");
    await b.collections.move(b.workspaceId, "col_a_links", null, links.version, BY);
    await sync();
    expect((await a.collections.get(a.workspaceId, "col_a_links")).parentId).toBeNull();
  });

  it("says when a collection's schema loses a conflict, since schemas keep no history", async () => {
    await seed(a);
    await sync();
    for (const [side, name] of [[a, "Peptides on A"], [b, "Peptides on B"]] as const) {
      const collection = await side.collections.get(side.workspaceId, "col_peptides");
      await new Promise((resolve) => setTimeout(resolve, 5));
      await side.collections.update(side.workspaceId, "col_peptides", { name, fields: collection.fields }, collection.version, BY);
    }
    await sync();
    expect((await a.collections.get(a.workspaceId, "col_peptides")).name).toBe("Peptides on B");
    expect(stdout).toContain("Collections keep no history, so the other schema was replaced");
  });

  it("refuses the same server twice, and a bad interval", async () => {
    expect(await cairn("sync", A_URL, `${A_URL}/`)).toBe(2);
    expect(stderr).toContain("two different servers");
    expect(await sync("--every", "5")).toBe(2);
    expect(stderr).toContain("--every");
  });
});

describe("the sync rules", () => {
  const page = (id: string, body: string, updatedAt: string): Promise<SyncRecord> =>
    record("page", id, null, id, { title: id, parent_id: null, tags: [], body }, updatedAt, "v1");
  const snap = (...records: SyncRecord[]): Snapshot => new Map(records.map((r) => [r.key, r]));

  it("copies the side that changed, and treats both changing as a conflict", async () => {
    const old = await page("pg_x", "old", "2026-01-01T00:00:00Z");
    const changedA = await page("pg_x", "new on a", "2026-01-02T00:00:00Z");
    const changedB = await page("pg_x", "new on b", "2026-01-03T00:00:00Z");
    const base = { "page:pg_x": old.hash };

    const oneSide = plan(snap(changedA), snap(old), base);
    expect(oneSide.actions).toMatchObject([{ key: "page:pg_x", op: "put", to: "b", conflict: false }]);

    const both = plan(snap(changedA), snap(changedB), base);
    expect(both.actions).toMatchObject([{ op: "put", to: "a", conflict: true }]);
  });

  it("copies a deletion only when the other side did not change", async () => {
    const old = await page("pg_x", "old", "2026-01-01T00:00:00Z");
    const edited = await page("pg_x", "edited", "2026-01-02T00:00:00Z");
    const base = { "page:pg_x": old.hash };
    expect(plan(snap(), snap(old), base).actions).toMatchObject([{ op: "delete", to: "b", conflict: false }]);
    expect(plan(snap(), snap(edited), base).actions).toMatchObject([{ op: "put", to: "a", conflict: true }]);
  });

  it("with no record of a last sync, copies what one side lacks and records what matches", async () => {
    const x = await page("pg_x", "same", "2026-01-01T00:00:00Z");
    const y = await page("pg_y", "only on b", "2026-01-01T00:00:00Z");
    const result = plan(snap(x), snap(x, y), {});
    expect(result.actions).toMatchObject([{ key: "page:pg_y", op: "put", to: "a", conflict: false }]);
    expect(result.base).toEqual({ "page:pg_x": x.hash });
  });

  it("reads intervals of at least 30 seconds", () => {
    expect(parseInterval("5m")).toBe(300_000);
    expect(parseInterval("30s")).toBe(30_000);
    expect(parseInterval("2h")).toBe(7_200_000);
    expect(() => parseInterval("10s")).toThrow("at least 30s");
    expect(() => parseInterval("5")).toThrow();
  });
});
