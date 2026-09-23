import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeContext, createApp, createContext, OWNER, type AppContext } from "@cairn/api";
import { run, type Io } from "../src/main.js";

/**
 * System-level regression tests for `cairn sync` (ADR-023, ADR-030, ADR-060),
 * one level above `sync.test.ts` and `merge.test.ts`. Those cover a single
 * conflict, a single merge, and the pure merge algorithm; this file exercises
 * multiple sync rounds, multiple records, and real HTTP round trips through
 * the CLI, to catch what a change to sync or merge code could break silently
 * without showing up in a single-round test.
 *
 * Same harness as `sync.test.ts`: two real in-process `@cairn/api` Hono apps
 * over `:memory:` databases, a fetch dispatcher keyed by origin, and the real
 * CLI `run()` driving `cairn sync <urlA> <urlB>`.
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
  config = await mkdtemp(join(tmpdir(), "cairn-sync-system-test-"));
});

afterEach(async () => {
  await closeContext(a);
  await closeContext(b);
  await rm(config, { recursive: true, force: true });
});

describe("cairn sync: multi-round system regression", () => {
  it("converges over three rounds of interleaved, non-conflicting edits on both sides", async () => {
    await seed(a);
    expect(await sync()).toBe(0);

    // Round 1: A edits page 1 (BPC-157).
    await edit(a, "pg_bpc-157", "Round 1, edited on A.");
    expect(await sync()).toBe(0);
    expect(stdout).not.toContain("conflict");

    // Round 2: B edits page 2 (TB-500).
    await edit(b, "pg_tb-500", "Round 2, edited on B.");
    expect(await sync()).toBe(0);
    expect(stdout).not.toContain("conflict");

    // Round 3: A edits a table row.
    const row = await a.tables.getRow(a.workspaceId, "col_peptides", "row_bpc");
    await a.tables.upsertRow(a.workspaceId, "col_peptides", { values: { ...row.values, grams: 42 } }, BY, {
      id: row.id,
      expectedVersion: row.version,
    });
    expect(await sync()).toBe(0);
    expect(stdout).not.toContain("conflict");

    // Both sides hold identical final state for every touched record.
    for (const side of [a, b]) {
      const bpc = await side.pages.get(side.workspaceId, "pg_bpc-157");
      expect(bpc.body).toBe("Round 1, edited on A.");
      expect(bpc.tags).toEqual(["peptide"]);
      const tb = await side.pages.get(side.workspaceId, "pg_tb-500");
      expect(tb.body).toBe("Round 2, edited on B.");
      expect(tb.tags).toEqual(["peptide"]);
      const rowNow = await side.tables.getRow(side.workspaceId, "col_peptides", "row_bpc");
      expect(rowNow.values["grams"]).toBe(42);
    }

    // A fourth sync is a true no-op.
    expect(await sync()).toBe(0);
    expect(stdout).toContain(`to ${A_URL}: nothing to change`);
    expect(stdout).toContain(`to ${B_URL}: nothing to change`);
    expect(stdout).not.toContain("conflict");
    expect(stdout).toContain("6 records already the same");
  });

  it("is idempotent: repeating an already-converged sync changes nothing further", async () => {
    await seed(a);
    await sync();

    // One real conflict: both sides edit the same page's body.
    await edit(a, "pg_bpc-157", "Older edit, on A.");
    await edit(b, "pg_bpc-157", "Newer edit, on B.");
    expect(await sync()).toBe(0);
    expect(stdout).toContain("conflict:");

    // Second sync: a stable fixed point.
    expect(await sync()).toBe(0);
    expect(stdout).not.toContain("conflict");
    expect(stdout).toContain(`to ${A_URL}: nothing to change`);
    expect(stdout).toContain(`to ${B_URL}: nothing to change`);

    // Third sync: still nothing.
    expect(await sync()).toBe(0);
    expect(stdout).not.toContain("conflict");
    expect(stdout).toContain(`to ${A_URL}: nothing to change`);
    expect(stdout).toContain(`to ${B_URL}: nothing to change`);
  });

  it("chains conflicts on the same page across rounds, using the post-merge state as the new base", async () => {
    await seed(a);
    await sync(); // Both sides agree; this becomes the base.

    // Round 1: both edit pg_bpc-157's body differently.
    await edit(a, "pg_bpc-157", "A's first divergent edit.");
    await edit(b, "pg_bpc-157", "B's first divergent edit.");
    expect(await sync()).toBe(0);
    const afterRound1 = stdout;
    const conflictCount = (text: string) => (text.match(/conflict: BPC-157/g) ?? []).length;
    expect(conflictCount(afterRound1)).toBe(1);
    for (const side of [a, b]) {
      expect((await side.pages.get(side.workspaceId, "pg_bpc-157")).body).toBe("B's first divergent edit.");
    }
    // The losing side's older content is recoverable from history.
    const historyAfter1 = await a.pages.history(a.workspaceId, "pg_bpc-157");
    expect(historyAfter1[0]!.note).toContain("Sync conflict");
    const replaced1 = await a.pages.revision(a.workspaceId, "pg_bpc-157", historyAfter1[1]!.version);
    expect(replaced1.snapshot.body).toBe("A's first divergent edit.");

    // Round 2: both edit the resulting (post-merge) page's body differently again.
    await edit(a, "pg_bpc-157", "A's second divergent edit.");
    await edit(b, "pg_bpc-157", "B's second divergent edit.");
    expect(await sync()).toBe(0);
    expect(conflictCount(stdout)).toBe(1);
    for (const side of [a, b]) {
      expect((await side.pages.get(side.workspaceId, "pg_bpc-157")).body).toBe("B's second divergent edit.");
    }
    const historyAfter2 = await a.pages.history(a.workspaceId, "pg_bpc-157");
    expect(historyAfter2[0]!.note).toContain("Sync conflict");
    const replaced2 = await a.pages.revision(a.workspaceId, "pg_bpc-157", historyAfter2[1]!.version);
    expect(replaced2.snapshot.body).toBe("A's second divergent edit.");
  });

  it("carries non-conflicting merges of different fields across multiple rounds", async () => {
    await seed(a);
    await sync();

    // Round 1: A edits tags, B edits body, same record, same round.
    const onA1 = await a.pages.get(a.workspaceId, "pg_bpc-157");
    await a.pages.update(a.workspaceId, onA1.id, { ...onA1, tags: ["peptide", "healing"] }, onA1.version, BY);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const onB1 = await b.pages.get(b.workspaceId, "pg_bpc-157");
    await b.pages.update(b.workspaceId, onB1.id, { ...onB1, body: "Body changed on B, round 1." }, onB1.version, BY);
    expect(await sync()).toBe(0);
    expect(stdout).not.toContain("conflict:");
    for (const side of [a, b]) {
      const page = await side.pages.get(side.workspaceId, "pg_bpc-157");
      expect(page.tags).toEqual(["peptide", "healing"]);
      expect(page.body).toBe("Body changed on B, round 1.");
    }

    // Round 2, on top of the merged state: A edits sources, B edits title.
    const onA2 = await a.pages.get(a.workspaceId, "pg_bpc-157");
    await a.pages.update(a.workspaceId, onA2.id, { ...onA2, sources: ["Smith 2021"] }, onA2.version, BY);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const onB2 = await b.pages.get(b.workspaceId, "pg_bpc-157");
    await b.pages.update(b.workspaceId, onB2.id, { ...onB2, title: "BPC-157 (renamed)" }, onB2.version, BY);
    expect(await sync()).toBe(0);
    expect(stdout).not.toContain("conflict:");
    for (const side of [a, b]) {
      const page = await side.pages.get(side.workspaceId, "pg_bpc-157");
      expect(page.sources).toEqual(["Smith 2021"]);
      expect(page.title).toBe("BPC-157 (renamed)");
      // Round 1's merged fields survived round 2's merge.
      expect(page.tags).toEqual(["peptide", "healing"]);
      expect(page.body).toBe("Body changed on B, round 1.");
    }
  });

  it("never deletes a page it cannot prove was deleted (ADR-060), even alongside an unrelated real conflict in the same round", async () => {
    await seed(a);
    await sync();

    // B loses pg_tb-500 with no trace (not a real delete: no history left
    // behind), while pg_tb-500 itself is untouched on A, so plan() sees A
    // matching the last-agreed hash and B absent: exactly the shape plan()
    // reads as "B deleted it". In the same round, A and B also genuinely
    // conflict on a different page, to prove the delete-verification step
    // and ordinary conflict resolution compose correctly in one run.
    const tb = await b.pages.get(b.workspaceId, "pg_tb-500");
    await b.pages.delete(b.workspaceId, "pg_tb-500", tb.version, BY);
    await b.store.pruneRevisions(b.workspaceId, "page", "pg_tb-500", "not-a-real-version");
    expect(await b.pages.history(b.workspaceId, "pg_tb-500")).toEqual([]);
    await edit(a, "pg_bpc-157", "Older edit, on A.");
    await edit(b, "pg_bpc-157", "Newer edit, on B.");

    expect(await sync()).toBe(0);
    // pg_tb-500: not deleted anywhere, recreated on B from A's untouched copy.
    expect((await a.pages.get(a.workspaceId, "pg_tb-500")).body).toContain("Pairs with");
    expect((await b.pages.get(b.workspaceId, "pg_tb-500")).body).toContain("Pairs with");
    expect(stdout).toContain("warning:");
    expect(stdout).toContain("pg_tb-500");
    expect(stdout).toContain("no history at all");
    // pg_bpc-157: the real conflict resolved as usual, unaffected by the warning.
    expect(stdout).toContain("conflict: BPC-157 changed on both");
    for (const side of [a, b]) {
      expect((await side.pages.get(side.workspaceId, "pg_bpc-157")).body).toBe("Newer edit, on B.");
    }

    // A second sync is now a stable no-op: no repeated warning, no repeated delete.
    expect(await sync()).toBe(0);
    expect(stdout).not.toContain("warning:");
    expect(stdout).not.toContain("conflict");
    expect(stdout).toContain(`to ${A_URL}: nothing to change`);
    expect(stdout).toContain(`to ${B_URL}: nothing to change`);
  });

  it("never deletes a page the other side never got word of being created (ADR-060)", async () => {
    await seed(a);
    await sync();

    // A creates a brand-new page and syncs it to B.
    await a.pages.create(a.workspaceId, { title: "New page", body: "Made on A." }, BY, "pg_new");
    expect(await sync()).toBe(0);
    expect((await b.pages.get(b.workspaceId, "pg_new")).body).toBe("Made on A.");

    // Now simulate B's copy vanishing without a trace (never a real delete):
    // absence on B looks, at the hash level, just like "B deleted it" once
    // the sync state agrees both sides had it.
    const onB = await b.pages.get(b.workspaceId, "pg_new");
    await b.pages.delete(b.workspaceId, "pg_new", onB.version, BY);
    await b.store.pruneRevisions(b.workspaceId, "page", "pg_new", "not-a-real-version");
    expect(await b.pages.history(b.workspaceId, "pg_new")).toEqual([]);

    expect(await sync()).toBe(0);
    // A's still-good copy was not deleted; B's was recreated instead.
    expect((await a.pages.get(a.workspaceId, "pg_new")).body).toBe("Made on A.");
    expect((await b.pages.get(b.workspaceId, "pg_new")).body).toBe("Made on A.");
    expect(stdout).toContain("warning:");
    expect(stdout).toContain("pg_new");
    expect(stdout).toContain("no history at all");
  });

  it("merges a table row's per-field edits over two real round trips", async () => {
    await seed(a);
    await sync();

    // Round 1: A edits grams, B edits name, same row, same round.
    const onA1 = await a.tables.getRow(a.workspaceId, "col_peptides", "row_bpc");
    await a.tables.upsertRow(a.workspaceId, "col_peptides", { values: { ...onA1.values, grams: 99 } }, BY, {
      id: onA1.id,
      expectedVersion: onA1.version,
    });
    const onB1 = await b.tables.getRow(b.workspaceId, "col_peptides", "row_bpc");
    await b.tables.upsertRow(b.workspaceId, "col_peptides", { values: { ...onB1.values, name: "BPC 157 renamed" } }, BY, {
      id: onB1.id,
      expectedVersion: onB1.version,
    });
    expect(await sync()).toBe(0);
    expect(stdout).not.toContain("conflict:");
    for (const side of [a, b]) {
      const row = await side.tables.getRow(side.workspaceId, "col_peptides", "row_bpc");
      expect(row.values).toEqual({ name: "BPC 157 renamed", grams: 99 });
    }

    // Round 2: both sides edit the SAME field (grams) differently: a real conflict.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const onA2 = await a.tables.getRow(a.workspaceId, "col_peptides", "row_bpc");
    await a.tables.upsertRow(a.workspaceId, "col_peptides", { values: { ...onA2.values, grams: 111 } }, BY, {
      id: onA2.id,
      expectedVersion: onA2.version,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const onB2 = await b.tables.getRow(b.workspaceId, "col_peptides", "row_bpc");
    await b.tables.upsertRow(b.workspaceId, "col_peptides", { values: { ...onB2.values, grams: 222 } }, BY, {
      id: onB2.id,
      expectedVersion: onB2.version,
    });
    expect(await sync()).toBe(0);
    const conflictLines = stdout.split("\n").filter((line) => line.includes("conflict:"));
    expect(conflictLines).toHaveLength(1);
    for (const side of [a, b]) {
      const row = await side.tables.getRow(side.workspaceId, "col_peptides", "row_bpc");
      // Newer value (B's, made later) wins; the renamed name from round 1 survives.
      expect(row.values["grams"]).toBe(222);
      expect(row.values["name"]).toBe("BPC 157 renamed");
    }
  });
});
