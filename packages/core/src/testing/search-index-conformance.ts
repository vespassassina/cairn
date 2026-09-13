import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SearchIndex } from "../ports/search-index.js";
import type { ChunkInput, WorkspaceId } from "../types.js";
import { eventually } from "./eventually.js";

/**
 * The shared conformance suite for {@link SearchIndex}.
 *
 * It deliberately does not assert exact ranking or scores. BM25 differs
 * between Cosmos, FTS5 and a JavaScript index, so the suite checks the
 * contract (what is found, what is filtered, what is replaced) and leaves
 * quality to the eval set, which is reported per backend (PRD section 10).
 */

export interface SearchIndexHarness {
  create(): Promise<SearchIndex>;
}

const WS: WorkspaceId = "ws_search_conformance";

function chunk(
  pageId: string,
  ordinal: number,
  text: string,
  headingPath: string[] = ["Page"],
): ChunkInput {
  return { id: `${pageId}:${ordinal}`, pageId, ordinal, text, headingPath };
}

export function runSearchIndexConformance(
  name: string,
  harness: SearchIndexHarness,
): void {
  describe(`SearchIndex conformance: ${name}`, () => {
    let index: SearchIndex;

    beforeAll(async () => {
      index = await harness.create();
      await index.init();
      await index.replaceChunksForPage(WS, "pg_print", [
        chunk(
          "pg_print",
          0,
          "The first layer failed because bed adhesion was poor on the textured plate.",
          ["Print log", "Failures"],
        ),
        chunk("pg_print", 1, "Reprinted at 65 degrees with a brim and it stuck.", [
          "Print log",
          "Fixes",
        ]),
      ]);
      await index.replaceChunksForPage(WS, "pg_esc", [
        chunk("pg_esc", 0, "Flashed BLHeli_32 firmware on the ESC of the 5 inch build.", [
          "Quad build",
        ]),
      ]);
    });

    afterAll(async () => {
      await index?.close();
    });

    it("finds a page by a term in its text", async () => {
      await eventually(async () => {
        const result = await index.search(WS, { query: "adhesion" });
        expect(result.hits.map((h) => h.pageId)).toContain("pg_print");
      });
    });

    it("returns heading path and a snippet containing the match", async () => {
      await eventually(async () => {
        const result = await index.search(WS, { query: "BLHeli" });
        const hit = result.hits.find((h) => h.pageId === "pg_esc");
        expect(hit).toBeDefined();
        expect(hit!.headingPath).toEqual(["Quad build"]);
        expect(hit!.snippet.toLowerCase()).toContain("blheli");
        expect(hit!.chunkId).toBe("pg_esc:0");
        expect(typeof hit!.score).toBe("number");
      });
    });

    it("reports the mode it actually ran in", async () => {
      const result = await index.search(WS, { query: "adhesion" });
      expect(["keyword", "hybrid"]).toContain(result.mode);
      if (!index.capabilities.vectors) expect(result.mode).toBe("keyword");
    });

    it("degrades to keyword instead of throwing when vectors are unavailable", async () => {
      const result = await index.search(WS, { query: "adhesion", mode: "hybrid" });
      if (!index.capabilities.vectors) expect(result.mode).toBe("keyword");
      expect(result.hits.length).toBeGreaterThan(0);
    });

    it("returns an empty result rather than throwing when nothing matches", async () => {
      const result = await index.search(WS, { query: "zzzznotaword" });
      expect(result.hits).toEqual([]);
      expect(result.truncated).toBe(false);
      expect(result.cursor).toBeNull();
    });

    // The match rule every backend shares (core search/terms.ts, ADR-021).

    it("returns nothing when no page holds most of the query's words", async () => {
      // pg_print holds "adhesion", pg_esc holds "BLHeli", nothing holds "sourdough".
      const result = await index.search(WS, { query: "adhesion BLHeli sourdough" });
      expect(result.hits).toEqual([]);
    });

    it("needs every word of a two-word query", async () => {
      const result = await index.search(WS, { query: "adhesion firmware" });
      expect(result.hits).toEqual([]);
    });

    it("counts words found in different sections of the same page", async () => {
      // "adhesion" is under Failures, "brim" under Fixes.
      await eventually(async () => {
        const result = await index.search(WS, { query: "adhesion brim" });
        expect(result.hits.map((h) => h.pageId)).toContain("pg_print");
      });
    });

    it("does not let filler words decide a match", async () => {
      await eventually(async () => {
        const result = await index.search(WS, { query: "which firmware did I flash on the" });
        expect(result.hits.map((h) => h.pageId)).toEqual(["pg_esc"]);
      });
    });

    it("shows each matching page before a second chunk of any page", async () => {
      await index.replaceChunksForPage(WS, "pg_many", [
        chunk("pg_many", 0, "cooling duct cooling duct fan shroud"),
        chunk("pg_many", 1, "cooling duct again, cooling duct print"),
        chunk("pg_many", 2, "more cooling duct notes, cooling duct"),
      ]);
      await index.replaceChunksForPage(WS, "pg_one", [
        chunk("pg_one", 0, "a single cooling duct remark"),
      ]);
      await eventually(async () => {
        const result = await index.search(WS, { query: "cooling duct", limit: 2 });
        expect(new Set(result.hits.map((h) => h.pageId))).toEqual(new Set(["pg_many", "pg_one"]));
      });
    });

    it("scopes results to one workspace", async () => {
      const result = await index.search("ws_elsewhere", { query: "adhesion" });
      expect(result.hits).toEqual([]);
    });

    it("respects a limit and offers a cursor when it truncates", async () => {
      const result = await index.search(WS, { query: "the", limit: 1 });
      expect(result.hits.length).toBeLessThanOrEqual(1);
      if (result.truncated) expect(result.cursor).not.toBeNull();
    });

    it("replaces a page's chunks rather than adding to them", async () => {
      await index.replaceChunksForPage(WS, "pg_replace", [
        chunk("pg_replace", 0, "original nozzle text"),
      ]);
      await eventually(async () => {
        expect(
          (await index.search(WS, { query: "nozzle" })).hits.map((h) => h.pageId),
        ).toContain("pg_replace");
      });

      await index.replaceChunksForPage(WS, "pg_replace", [
        chunk("pg_replace", 0, "rewritten hotend text"),
      ]);
      await eventually(async () => {
        const nozzle = await index.search(WS, { query: "nozzle" });
        expect(nozzle.hits.map((h) => h.pageId)).not.toContain("pg_replace");
        const hotend = await index.search(WS, { query: "hotend" });
        expect(hotend.hits.map((h) => h.pageId)).toContain("pg_replace");
      });
    });

    it("is idempotent when the same chunks are written twice", async () => {
      const chunks = [chunk("pg_idem", 0, "gyroid infill at fifteen percent")];
      await index.replaceChunksForPage(WS, "pg_idem", chunks);
      await index.replaceChunksForPage(WS, "pg_idem", chunks);
      await eventually(async () => {
        const result = await index.search(WS, { query: "gyroid" });
        expect(result.hits.filter((h) => h.pageId === "pg_idem")).toHaveLength(1);
      });
    });

    it("removes a deleted page from the index", async () => {
      await index.replaceChunksForPage(WS, "pg_gone", [
        chunk("pg_gone", 0, "ephemeral filament notes"),
      ]);
      await eventually(async () => {
        expect(
          (await index.search(WS, { query: "ephemeral" })).hits,
        ).not.toHaveLength(0);
      });

      await index.deleteChunksForPage(WS, "pg_gone");
      await eventually(async () => {
        expect((await index.search(WS, { query: "ephemeral" })).hits).toHaveLength(0);
      });
    });
  });
}
