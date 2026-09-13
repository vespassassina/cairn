import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { closeContext, createContext, OWNER } from "../src/context.js";
import { parseQueries, runEval } from "../src/cli/eval.js";

/**
 * Starting on a database whose search index predates stemming rebuilds the
 * index from the pages before serving (ADR-021), and the eval scores queries
 * that have no answer (ADR-021).
 */

const WS = "ws_upgrade";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-upgrade-"));
  dirs.push(dir);
  return join(dir, "cairn.sqlite");
}

describe("search index upgrade at startup", () => {
  it("rebuilds an old index from the pages", async () => {
    const database = tempDatabase();
    const first = await createContext({ database, workspaceId: WS });
    await first.pages.create(
      WS,
      { title: "MT-2", parentId: null, tags: [], body: "# MT-2\n\nA tanning peptide, used for sunless tanning." },
      { actor: OWNER },
      "pg_mt-2",
    );
    await closeContext(first);

    // Put the index back the way it was before stemming.
    const db = new DatabaseSync(database);
    db.exec("DROP TABLE chunks");
    db.exec(`CREATE VIRTUAL TABLE chunks USING fts5(
      workspace_id UNINDEXED, chunk_id UNINDEXED, page_id UNINDEXED,
      heading_path UNINDEXED, ordinal UNINDEXED, text)`);
    db.close();

    const second = await createContext({ database, workspaceId: WS });
    try {
      const result = await second.search.search(WS, { query: "tanning peptides" });
      expect(result.hits.map((h) => h.pageId)).toContain("pg_mt-2");
    } finally {
      await closeContext(second);
    }
  });
});

describe("eval", () => {
  it("reads `expected: none` as a query with no answer", () => {
    const [query] = parseQueries(`queries:\n  - id: n01\n    query: "sourdough starter"\n    expected: none\n`);
    expect(query).toMatchObject({ id: "n01", absent: true, expected: [] });
  });

  it("scores a no-answer query as right only when nothing comes back", async () => {
    const context = await createContext({ database: ":memory:", workspaceId: WS });
    try {
      await context.pages.create(
        WS,
        { title: "Sourdough", parentId: null, tags: [], body: "Sourdough notes. Feed the starter twice a day." },
        { actor: OWNER },
        "pg_sourdough",
      );
      const report = await runEval(context, [
        { id: "n01", query: "kubernetes ingress", expected: [], absent: true },
        { id: "n02", query: "sourdough starter", expected: [], absent: true },
        { id: "q01", query: "starter feeding", expected: ["pg_sourdough"] },
      ]);
      expect(report).toMatchObject({ absent: 2, absentEmpty: 1, scored: 1, unscored: 0, recall: 1 });
    } finally {
      await closeContext(context);
    }
  });
});
