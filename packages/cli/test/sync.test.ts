import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeContext, createApp, createContext, OWNER, type AppContext } from "@cairn/api";
import { revisionRecordId } from "@cairn/core";
import { run, type Io } from "../src/main.js";
import { loadState, newer, parseInterval, plan, record, type Snapshot, type SyncRecord } from "../src/sync.js";

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
  const peptides = await context.tables.create(
    ws,
    { name: "Peptides", fields: [{ name: "name", type: "text", required: true }, { name: "grams", type: "number" }] },
    BY,
    "col_peptides",
  );
  await context.tables.upsertRow(ws, peptides.id, { values: { name: "BPC-157", grams: 5 } }, BY, { id: "row_bpc" });
  await context.tables.upsertRow(ws, peptides.id, { values: { name: "TB-500", grams: 2 } }, BY, { id: "row_tb" });
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
    expect(stdout).toContain(`to ${B_URL}: 3 pages, 1 table, 2 rows written`);

    const bpc = await b.pages.get(b.workspaceId, "pg_bpc-157");
    expect(bpc.parentId).toBe("pg_cat_healing");
    expect(bpc.body).toBe("## Status\n\nResearch only.\n");
    expect(bpc.tags).toEqual(["peptide"]);
    const row = await b.tables.getRow(b.workspaceId, "col_peptides", "row_tb");
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
    const version = (await b.tables.getRow(b.workspaceId, "col_peptides", "row_bpc")).version;
    await b.tables.upsertRow(b.workspaceId, "col_peptides", { values: { name: "BPC-157", grams: 10 } }, BY, { id: "row_bpc", expectedVersion: version });

    expect(await sync()).toBe(0);
    expect((await a.pages.get(a.workspaceId, "pg_tb-500")).body).toBe("Edited on B.");
    expect((await b.pages.get(b.workspaceId, "pg_bpc-157")).body).toBe("Edited on A.");
    expect((await a.tables.getRow(a.workspaceId, "col_peptides", "row_bpc")).values["grams"]).toBe(10);
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
    const row = await b.tables.getRow(b.workspaceId, "col_peptides", "row_tb");
    await b.tables.deleteRow(b.workspaceId, "col_peptides", "row_tb", row.version, BY);

    await sync();
    expect(await pageOrNull(b, "pg_tb-500")).toBeNull();
    await expect(a.tables.getRow(a.workspaceId, "col_peptides", "row_tb")).rejects.toThrow();
    expect(stdout).toContain(`to ${B_URL}: 1 deleted`);
  });

  it("recreates a page that vanished with no trace instead of deleting the copy that survived (ADR-060)", async () => {
    await seed(a);
    await sync();
    // Simulate real data loss on B, not a delete: the page and every one of
    // its revisions are gone, unlike a genuine delete, which always leaves a
    // revision behind (ADR-059). A hard as opposed to soft delete.
    const tb = await b.pages.get(b.workspaceId, "pg_tb-500");
    await b.pages.delete(b.workspaceId, "pg_tb-500", tb.version, BY);
    await b.store.pruneRevisions(b.workspaceId, "page", "pg_tb-500", "not-a-real-version");
    expect(await b.pages.history(b.workspaceId, "pg_tb-500")).toEqual([]);

    expect(await sync()).toBe(0);
    expect((await a.pages.get(a.workspaceId, "pg_tb-500")).body).toContain("Pairs with");
    expect((await b.pages.get(b.workspaceId, "pg_tb-500")).body).toContain("Pairs with");
    expect(stdout).toContain("warning:");
    expect(stdout).toContain("pg_tb-500");
    expect(stdout).toContain("no history at all");
  });

  it("recreates a row that vanished with no trace instead of deleting the copy that survived (ADR-060)", async () => {
    await seed(a);
    await sync();
    const row = await b.tables.getRow(b.workspaceId, "col_peptides", "row_tb");
    await b.tables.deleteRow(b.workspaceId, "col_peptides", "row_tb", row.version, BY);
    await b.store.pruneRevisions(b.workspaceId, "row", revisionRecordId("row", "row_tb", "col_peptides"), "not-a-real-version");
    expect(await b.tables.rowHistory(b.workspaceId, "col_peptides", "row_tb")).toEqual([]);

    expect(await sync()).toBe(0);
    await expect(a.tables.getRow(a.workspaceId, "col_peptides", "row_tb")).resolves.toBeTruthy();
    await expect(b.tables.getRow(b.workspaceId, "col_peptides", "row_tb")).resolves.toBeTruthy();
    expect(stdout).toContain("warning:");
    expect(stdout).toContain("row_tb");
    expect(stdout).toContain("no history at all");
  });

  it("lets the newer edit win where both changed the same part, and keeps the other in history", async () => {
    await seed(a);
    await sync();
    await edit(a, "pg_bpc-157", "Older edit, on A.");
    await edit(b, "pg_bpc-157", "Newer edit, on B.");

    await sync();
    expect((await a.pages.get(a.workspaceId, "pg_bpc-157")).body).toBe("Newer edit, on B.");
    expect((await b.pages.get(b.workspaceId, "pg_bpc-157")).body).toBe("Newer edit, on B.");
    expect(stdout).toContain(`conflict: BPC-157 changed on both; merged, and 1 part changed on both kept the newer edit, from ${B_URL}`);
    // B already held the result, so only A was written.
    expect(stdout).toContain(`to ${B_URL}: nothing to change`);

    const history = await a.pages.history(a.workspaceId, "pg_bpc-157");
    expect(history[0]!.note).toContain("Sync conflict");
    const replaced = await a.pages.revision(a.workspaceId, "pg_bpc-157", history[1]!.version);
    expect(replaced.snapshot.body).toBe("Older edit, on A.");
  });

  it("merges edits to different parts of a page, as git does (ADR-030)", async () => {
    await seed(a);
    await a.pages.create(a.workspaceId, { title: "Notes", body: "## Dosing\n\n250 mcg.\n\n## Evidence\n\nRodents.\n", tags: ["peptide"] }, BY, "pg_notes");
    await sync();
    const onA = await a.pages.get(a.workspaceId, "pg_notes");
    await a.pages.update(a.workspaceId, onA.id, { ...onA, body: onA.body.replace("250 mcg.", "250 to 500 mcg."), sources: ["Smith 2021"] }, onA.version, BY);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const onB = await b.pages.get(b.workspaceId, "pg_notes");
    await b.pages.update(b.workspaceId, onB.id, { ...onB, body: onB.body.replace("Rodents.", "Rodents, and one human trial."), tags: ["peptide", "healing"] }, onB.version, BY);

    expect(await sync()).toBe(0);
    const want = "## Dosing\n\n250 to 500 mcg.\n\n## Evidence\n\nRodents, and one human trial.\n";
    for (const side of [a, b]) {
      const page = await side.pages.get(side.workspaceId, "pg_notes");
      expect(page.body).toBe(want);
      expect(page.tags).toEqual(["peptide", "healing"]);
      expect(page.sources).toEqual(["Smith 2021"]);
      expect((await side.pages.history(side.workspaceId, "pg_notes"))[0]!.note).toContain("Merged in sync with");
    }
    expect(stdout).toContain("merged: Notes changed on both, in different parts; both edits kept");
    expect(stdout).not.toContain("conflict:");
    // Both now agree, and on the edit time too, so the merge orders after both edits.
    const [ea, eb] = [await a.pages.get(a.workspaceId, "pg_notes"), await b.pages.get(b.workspaceId, "pg_notes")];
    expect(ea.editedAt).toBe(eb.editedAt);
    expect(await sync()).toBe(0);
    expect(stdout).toContain(`to ${A_URL}: nothing to change`);
    expect(stdout).toContain(`to ${B_URL}: nothing to change`);
  });

  it("merges a row field by field", async () => {
    await seed(a);
    await sync();
    const onA = await a.tables.getRow(a.workspaceId, "col_peptides", "row_bpc");
    await a.tables.upsertRow(a.workspaceId, "col_peptides", { values: { ...onA.values, grams: 10 } }, BY, { id: onA.id, expectedVersion: onA.version });
    const onB = await b.tables.getRow(b.workspaceId, "col_peptides", "row_bpc");
    await b.tables.upsertRow(b.workspaceId, "col_peptides", { values: { ...onB.values, name: "BPC 157" } }, BY, { id: onB.id, expectedVersion: onB.version });
    expect(await sync()).toBe(0);
    for (const side of [a, b]) {
      expect((await side.tables.getRow(side.workspaceId, "col_peptides", "row_bpc")).values).toEqual({ name: "BPC 157", grams: 10 });
    }
  });

  it("carries the time an edit was made, so order holds across hops (ADR-030)", async () => {
    const C_URL = "http://localhost:4003";
    const c = await createContext({ database: ":memory:", workspaceId: "ws_c" });
    apps.set(C_URL, createApp({ context: c, token: null, trust: { enabled: true, hosts: ["localhost"] } }));
    try {
      await seed(a);
      await sync();
      await cairn("sync", A_URL, C_URL);
      const older = await edit(a, "pg_bpc-157", "Older edit, made on A.");
      const newer = await edit(c, "pg_bpc-157", "Newer edit, made on C.");
      await new Promise((resolve) => setTimeout(resolve, 5));
      // A's older edit reaches B only now, after C's edit was made.
      await sync();
      const onB = await b.pages.get(b.workspaceId, "pg_bpc-157");
      expect(onB.editedAt).toBe(older.editedAt);
      expect(Date.parse(onB.updatedAt)).toBeGreaterThan(Date.parse(newer.editedAt));

      // Stored on B after C's edit, but made before it: C's edit wins.
      expect(await cairn("sync", B_URL, C_URL)).toBe(0);
      expect((await b.pages.get(b.workspaceId, "pg_bpc-157")).body).toBe("Newer edit, made on C.");
      expect(stdout).toContain(`kept the newer edit, from ${C_URL}`);
    } finally {
      await closeContext(c);
    }
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

  it("copies a source added on one side, and one removed on the other (ADR-027)", async () => {
    await seed(a);
    await sync();
    const page = await a.pages.get(a.workspaceId, "pg_bpc-157");
    await a.pages.update(a.workspaceId, page.id, { ...page, sources: ["Smith 2021", "Jones 2022"] }, page.version, BY);
    const row = await a.tables.getRow(a.workspaceId, "col_peptides", "row_tb");
    await a.tables.upsertRow(a.workspaceId, "col_peptides", { values: row.values, sources: ["Jones 2022"] }, BY, {
      id: row.id,
      expectedVersion: row.version,
    });
    expect(await sync()).toBe(0);
    expect((await b.pages.get(b.workspaceId, "pg_bpc-157")).sources).toEqual(["Smith 2021", "Jones 2022"]);
    expect((await b.tables.getRow(b.workspaceId, "col_peptides", "row_tb")).sources).toEqual(["Jones 2022"]);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const onB = await b.pages.get(b.workspaceId, "pg_bpc-157");
    await b.pages.update(b.workspaceId, onB.id, { ...onB, sources: [] }, onB.version, BY);
    expect(await sync()).toBe(0);
    expect((await a.pages.get(a.workspaceId, "pg_bpc-157")).sources).toEqual([]);
    // Settled: nothing more to copy.
    expect(await sync()).toBe(0);
    expect(stdout).toContain(`to ${A_URL}: nothing to change`);
    expect(stdout).toContain(`to ${B_URL}: nothing to change`);
  });

  it("copies the approval mark made on one side, and its removal (ADR-078)", async () => {
    await seed(a);
    await sync();
    const page = await a.pages.get(a.workspaceId, "pg_bpc-157");
    const marked = await a.pages.update(
      a.workspaceId,
      page.id,
      { ...page, approval: "approved", approvalAt: "2026-09-24T10:00:00.000Z", approvalVersion: page.version },
      page.version,
      BY,
    );
    expect(await sync()).toBe(0);
    const onB = await b.pages.get(b.workspaceId, "pg_bpc-157");
    expect(onB.approval).toBe("approved");
    expect(onB.approvalAt).toBe("2026-09-24T10:00:00.000Z");
    // The approved version on A means nothing on B: the mark points at the
    // copy B just wrote, so the diff since approval works there too.
    expect(onB.approvalVersion).toBe(onB.version);
    expect(onB.approvalVersion).not.toBe(marked.approvalVersion);
    expect((await b.pages.revision(b.workspaceId, onB.id, onB.approvalVersion!)).snapshot.body).toBe(page.body);
    expect((await b.pages.get(b.workspaceId, "pg_cat_healing")).approval).toBe("neutral");
    expect(await sync()).toBe(0);
    expect(stdout).toContain(`to ${A_URL}: nothing to change`);
    expect(stdout).toContain(`to ${B_URL}: nothing to change`);

    // A large edit on A resets the mark; the copy on B keeps the trace.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const edited = await a.pages.update(
      a.workspaceId,
      page.id,
      { title: marked.title, parentId: marked.parentId, tags: marked.tags, body: "Rewritten from scratch, at length, so the mark cannot stay." },
      marked.version,
      BY,
    );
    expect(edited.approval).toBe("neutral");
    expect(await sync()).toBe(0);
    const reset = await b.pages.get(b.workspaceId, "pg_bpc-157");
    expect(reset.approval).toBe("neutral");
    expect(reset.approvalPrevious).toBe("approved");
    expect(reset.approvalVersion).toBe(onB.version);

    // An unmark on A clears B.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await a.pages.update(a.workspaceId, page.id, { ...edited, approval: "neutral", approvalAt: null, approvalPrevious: null }, edited.version, BY);
    expect(await sync()).toBe(0);
    const cleared = await b.pages.get(b.workspaceId, "pg_bpc-157");
    expect(cleared.approval).toBe("neutral");
    expect(cleared.approvalPrevious).toBeNull();
    expect(cleared.approvalAt).toBeNull();
    expect(await sync()).toBe(0);
    expect(stdout).toContain(`to ${B_URL}: nothing to change`);
  });

  it("copies a verification made on one side (ADR-028)", async () => {
    await seed(a);
    await sync();
    const page = await a.pages.get(a.workspaceId, "pg_bpc-157");
    const checked = await a.pages.update(a.workspaceId, page.id, { ...page, verified: true }, page.version, BY);
    expect(await sync()).toBe(0);
    expect((await b.pages.get(b.workspaceId, "pg_bpc-157")).verifiedAt).toBe(checked.verifiedAt);
    expect((await b.pages.get(b.workspaceId, "pg_cat_healing")).verifiedAt).toBeNull();
    expect(await sync()).toBe(0);
    expect(stdout).toContain(`to ${A_URL}: nothing to change`);
    expect(stdout).toContain(`to ${B_URL}: nothing to change`);
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

  it("copies tables in the tree and linked rows, targets first (ADR-024)", async () => {
    const ws = a.workspaceId;
    await a.pages.create(ws, { title: "Peptides", body: "Hub." }, BY, "pg_home");
    // Named so the linking table sorts before its target.
    await a.tables.create(ws, { name: "Targets", parentId: "pg_home", fields: [{ name: "name", type: "text", required: true }] }, BY, "col_z_targets");
    await a.tables.create(
      ws,
      { name: "Links", parentId: "pg_home", fields: [{ name: "title", type: "text", required: true }, { name: "to", type: "relation", target: "col_z_targets", multiple: true }] },
      BY,
      "col_a_links",
    );
    await a.tables.upsertRow(ws, "col_z_targets", { values: { name: "BPC-157" } }, BY, { id: "row_bpc" });
    await a.tables.upsertRow(ws, "col_a_links", { values: { title: "Stack", to: ["row_bpc"] } }, BY, { id: "row_stack" });

    expect(await sync()).toBe(0);
    expect(stderr).toBe("");
    expect((await b.tables.get(b.workspaceId, "col_a_links")).parentId).toBe("pg_home");
    expect((await b.tables.rowBacklinks(b.workspaceId, "col_z_targets", "row_bpc")).map((e) => e.sourceId)).toEqual(["col_a_links/row_stack"]);

    // A move on one side reaches the other.
    const links = await b.tables.get(b.workspaceId, "col_a_links");
    await b.tables.move(b.workspaceId, "col_a_links", null, links.version, BY);
    await sync();
    expect((await a.tables.get(a.workspaceId, "col_a_links")).parentId).toBeNull();
  });

  it("says when a table's schema loses a conflict, since schemas keep no history", async () => {
    await seed(a);
    await sync();
    for (const [side, name] of [[a, "Peptides on A"], [b, "Peptides on B"]] as const) {
      const table = await side.tables.get(side.workspaceId, "col_peptides");
      await new Promise((resolve) => setTimeout(resolve, 5));
      await side.tables.update(side.workspaceId, "col_peptides", { name, fields: table.fields }, table.version, BY);
    }
    await sync();
    expect((await a.tables.get(a.workspaceId, "col_peptides")).name).toBe("Peptides on B");
    expect(stdout).toContain("Tables keep no history, so the other schema was replaced");
  });

  it("refuses the same server twice, and a bad interval", async () => {
    expect(await cairn("sync", A_URL, `${A_URL}/`)).toBe(2);
    expect(stderr).toContain("two different servers");
    expect(await sync("--every", "5")).toBe(2);
    expect(stderr).toContain("--every");
  });
});

describe("publication does not travel (ADR-032)", () => {
  it("copies a published page as a private page, and never publishes on the other side", async () => {
    await seed(a);
    const healing = await a.pages.get(a.workspaceId, "pg_cat_healing");
    await a.pages.update(
      a.workspaceId,
      healing.id,
      { title: healing.title, parentId: healing.parentId, tags: healing.tags, body: healing.body, public: true },
      healing.version,
      BY,
    );

    expect(await sync()).toBe(0);
    expect((await b.pages.get(b.workspaceId, "pg_cat_healing")).public).toBe(false);
    expect((await b.pages.get(b.workspaceId, "pg_bpc-157")).public).toBe(false);
    // And the copy that is published stays published: sync did not take it down.
    expect((await a.pages.get(a.workspaceId, "pg_cat_healing")).public).toBe(true);

    // A page edited on the other side and synced back does not publish it either.
    await edit(b, "pg_bpc-157", "Edited over there.");
    expect(await sync()).toBe(0);
    expect((await a.pages.get(a.workspaceId, "pg_bpc-157")).public).toBe(false);
    expect((await a.pages.get(a.workspaceId, "pg_cat_healing")).public).toBe(true);
  });
});

describe("the sync rules", () => {
  const page = (id: string, body: string, updatedAt: string): Promise<SyncRecord> =>
    record("page", id, null, id, { title: id, parent_id: null, tags: [], body }, updatedAt, "v1");
  const snap = (...records: SyncRecord[]): Snapshot => new Map(records.map((r) => [r.key, r]));

  it("orders two edits by the time they were made, then by hash, the same both ways round", async () => {
    const early = await record("page", "pg_x", null, "x", { body: "early" }, "2026-01-05T00:00:00Z", "v1", "2026-01-01T00:00:00Z");
    const late = await record("page", "pg_x", null, "x", { body: "late" }, "2026-01-02T00:00:00Z", "v1", "2026-01-02T00:00:00Z");
    // Stored later, edited earlier: the edit time decides.
    expect(newer(early, late)).toBe("b");
    expect(newer(late, early)).toBe("a");
    const tie = await record("page", "pg_x", null, "x", { body: "tie" }, "2026-01-02T00:00:00Z", "v1", "2026-01-02T00:00:00Z");
    expect(newer(late, tie) === "a").toBe(newer(tie, late) === "b");
  });

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

  it("reads state saved before tables were called tables (ADR-026)", async () => {
    const file = join(config, "old-state.json");
    await writeFile(file, JSON.stringify({ servers: [A_URL, B_URL], last_sync: null, base: { "collection:col_x": "h1", "page:pg_x": "h2" } }));
    expect((await loadState(file, A_URL, B_URL)).base).toEqual({ "table:col_x": "h1", "page:pg_x": "h2" });
  });

  it("reads intervals of at least 30 seconds", () => {
    expect(parseInterval("5m")).toBe(300_000);
    expect(parseInterval("30s")).toBe(30_000);
    expect(parseInterval("2h")).toBe(7_200_000);
    expect(() => parseInterval("10s")).toThrow("at least 30s");
    expect(() => parseInterval("5")).toThrow();
  });
});
