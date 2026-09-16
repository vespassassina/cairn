import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SynonymEmbedder } from "@cairn/core/testing";
import { SqliteSearchIndex } from "../src/index.js";

/**
 * What the SQLite index does beyond the shared contract: Porter stemming, and
 * upgrading an index built with the old tokenizer (ADR-021).
 */

const WS = "ws_sqlite_search";
const dirs: string[] = [];

function tempDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-search-"));
  dirs.push(dir);
  return join(dir, "cairn.sqlite");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SqliteSearchIndex", () => {
  it("finds other forms of a word", async () => {
    const index = new SqliteSearchIndex();
    await index.init();
    await index.replaceChunksForPage(WS, "pg_mt2", [
      { id: "pg_mt2:0", pageId: "pg_mt2", ordinal: 0, headingPath: ["MT-2"], text: "Tanning peptides, combined with sun exposure." },
    ]);
    for (const query of ["tanning peptide", "combine peptide", "tan peptides"]) {
      const result = await index.search(WS, { query });
      expect(result.hits.map((h) => h.pageId), query).toEqual(["pg_mt2"]);
    }
    await index.close();
  });

  it("keeps a straight or curly apostrophe in a snippet (fault 4, console-and-search-polish)", async () => {
    const index = new SqliteSearchIndex();
    await index.init();
    await index.replaceChunksForPage(WS, "pg_apo_straight", [
      { id: "pg_apo_straight:0", pageId: "pg_apo_straight", ordinal: 0, headingPath: [], text: "The page's history is long." },
    ]);
    await index.replaceChunksForPage(WS, "pg_apo_curly", [
      { id: "pg_apo_curly:0", pageId: "pg_apo_curly", ordinal: 0, headingPath: [], text: "The page’s notes are short." },
    ]);
    const result = await index.search(WS, { query: "page" });
    const snippets = result.hits.map((h) => h.snippet).join(" ");
    expect(snippets).toContain("'s");
    expect(snippets).toContain("’s");
    await index.close();
  });

  it("recreates an index built with the old tokenizer and asks for a rebuild", async () => {
    const location = tempDatabase();
    const old = new DatabaseSync(location);
    old.exec(`CREATE VIRTUAL TABLE chunks USING fts5(
      workspace_id UNINDEXED, chunk_id UNINDEXED, page_id UNINDEXED,
      heading_path UNINDEXED, ordinal UNINDEXED, text)`);
    old.exec(`INSERT INTO chunks VALUES ('${WS}', 'pg_old:0', 'pg_old', '[]', 0, 'stale text')`);
    old.close();

    const index = new SqliteSearchIndex({ location });
    await index.init();
    expect(index.needsRebuild).toBe(true);
    expect((await index.search(WS, { query: "stale" })).hits).toEqual([]);
    await index.close();

    const again = new SqliteSearchIndex({ location });
    await again.init();
    expect(again.needsRebuild).toBe(false);
    await again.close();
  });

  it("keeps vectors across a restart and embeds only what changed", async () => {
    const location = tempDatabase();
    const first = new SqliteSearchIndex({ location, embedder: new SynonymEmbedder(), minSimilarity: 0.5 });
    await first.init();
    await first.replaceChunksForPage(WS, "pg_a", [{ id: "pg_a:0", pageId: "pg_a", ordinal: 0, headingPath: [], text: "automobile notes" }]);
    await first.settled();
    await first.close();

    // Written while no model was running, as a short-lived command does.
    const offline = new SqliteSearchIndex({ location });
    await offline.init();
    await offline.replaceChunksForPage(WS, "pg_b", [{ id: "pg_b:0", pageId: "pg_b", ordinal: 0, headingPath: [], text: "banana notes" }]);
    await offline.close();

    const embedder = new SynonymEmbedder();
    const second = new SqliteSearchIndex({ location, embedder, minSimilarity: 0.5 });
    await second.init();
    await second.settled();
    expect(embedder.documentCalls).toBe(1);
    expect((await second.search(WS, { query: "car" })).hits.map((h) => h.pageId)).toEqual(["pg_a"]);
    expect((await second.search(WS, { query: "fruit" })).hits.map((h) => h.pageId)).toEqual(["pg_b"]);
    await second.close();
  });

  it("embeds everything again when the model changes", async () => {
    const location = tempDatabase();
    const first = new SqliteSearchIndex({ location, embedder: new SynonymEmbedder("synonyms v1"), minSimilarity: 0.5 });
    await first.init();
    await first.replaceChunksForPage(WS, "pg_a", [{ id: "pg_a:0", pageId: "pg_a", ordinal: 0, headingPath: [], text: "automobile notes" }]);
    await first.settled();
    await first.close();

    const embedder = new SynonymEmbedder("synonyms v2");
    const second = new SqliteSearchIndex({ location, embedder, minSimilarity: 0.5 });
    await second.init();
    await second.settled();
    expect(embedder.documentCalls).toBe(1);
    expect((await second.search(WS, { query: "vehicle" })).hits.map((h) => h.pageId)).toEqual(["pg_a"]);
    await second.close();
  });

  it("creates no vector tables without an embedder (ADR-004)", async () => {
    const location = tempDatabase();
    const index = new SqliteSearchIndex({ location });
    await index.init();
    await index.close();
    const db = new DatabaseSync(location);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%vector%'").all() as { name: string }[]).map((row) => row.name);
    db.close();
    expect(tables).toEqual([]);
  });

  it("does not ask for a rebuild on a new index", async () => {
    const index = new SqliteSearchIndex({ location: tempDatabase() });
    await index.init();
    expect(index.needsRebuild).toBe(false);
    await index.close();
  });

  it("does not match a page whose only occurrence of a term is negated (ADR-042)", async () => {
    const index = new SqliteSearchIndex();
    await index.init();
    // Both terms are literally present, "hungry" only inside a negation, so
    // this page would wrongly pass requiredMatches' coverage bar without the
    // negation check: it is q17's own shape, "less hungry" for "hungry".
    await index.replaceChunksForPage(WS, "pg_suppressant", [
      {
        id: "pg_suppressant:0",
        pageId: "pg_suppressant",
        ordinal: 0,
        headingPath: ["Community notes"],
        text: "This peptide leaves some users feeling less hungry during the day.",
      },
    ]);
    await index.replaceChunksForPage(WS, "pg_stimulant", [
      {
        id: "pg_stimulant:0",
        pageId: "pg_stimulant",
        ordinal: 0,
        headingPath: ["Mechanism"],
        text: "This peptide makes users feel hungry within the hour.",
      },
    ]);

    const result = await index.search(WS, { query: "peptide hungry" });
    expect(result.hits.map((h) => h.pageId)).toEqual(["pg_stimulant"]);
    await index.close();
  });

  it("still matches a page that states a term plainly elsewhere on the same page (ADR-042)", async () => {
    const index = new SqliteSearchIndex();
    await index.init();
    await index.replaceChunksForPage(WS, "pg_mixed", [
      { id: "pg_mixed:0", pageId: "pg_mixed", ordinal: 0, headingPath: ["Mechanism"], text: "Peptide known to leave users feeling hungry soon after dosing." },
      { id: "pg_mixed:1", pageId: "pg_mixed", ordinal: 1, headingPath: ["Notes"], text: "Some report feeling less hungry on higher doses." },
    ]);

    const result = await index.search(WS, { query: "peptide hungry" });
    expect(new Set(result.hits.map((h) => h.pageId))).toEqual(new Set(["pg_mixed"]));
    await index.close();
  });
});
