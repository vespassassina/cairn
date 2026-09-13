import { afterEach, describe, expect, it } from "vitest";
import type { Embedder } from "../ports/embedder.js";
import type { SearchIndex } from "../ports/search-index.js";
import type { ChunkInput, WorkspaceId } from "../types.js";
import { eventually } from "./eventually.js";

/**
 * The shared suite for search with vectors (ADR-022). It runs with
 * {@link SynonymEmbedder}, a fake whose vectors put known synonyms on the same
 * axis, so "car" and "automobile" match exactly and "banana" matches neither.
 * No model is downloaded and every result is predictable.
 */

const GROUPS = [
  ["car", "cars", "automobile", "vehicle"],
  ["banana", "bananas", "fruit"],
  ["repair", "fix", "maintenance", "service"],
  ["sleep", "insomnia", "rest"],
];

/** A fake embedder for tests: one axis per group of synonyms. */
export class SynonymEmbedder implements Embedder {
  readonly model: string;
  dimensions = 0;
  documentCalls = 0;
  failQueries = false;

  constructor(
    model = "synonyms v1",
    private readonly failInit = false,
  ) {
    this.model = model;
  }

  async init(): Promise<void> {
    if (this.failInit) throw new Error("model could not be loaded");
    this.dimensions = GROUPS.length + 1;
  }

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    this.documentCalls += 1;
    return texts.map((text) => this.vector(text));
  }

  async embedQuery(text: string): Promise<Float32Array> {
    if (this.failQueries) throw new Error("model crashed");
    return this.vector(text);
  }

  async close(): Promise<void> {}

  private vector(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    for (const word of text.toLowerCase().split(/[^a-z]+/)) {
      const axis = GROUPS.findIndex((group) => group.includes(word));
      if (axis !== -1) vector[axis] = 1;
    }
    // A last axis every text shares weakly, so no vector is all zeros.
    vector[GROUPS.length] = 0.05;
    const length = Math.hypot(...vector);
    return vector.map((value) => value / length);
  }
}

export interface HybridSearchHarness {
  /** A fresh index using this embedder. */
  create(embedder: Embedder): Promise<SearchIndex>;
}

const WS: WorkspaceId = "ws_hybrid_conformance";

function chunk(pageId: string, ordinal: number, text: string): ChunkInput {
  return { id: `${pageId}:${ordinal}`, pageId, ordinal, text, headingPath: ["Page"] };
}

export function runHybridSearchConformance(name: string, harness: HybridSearchHarness): void {
  describe(`hybrid search conformance: ${name}`, () => {
    const open: SearchIndex[] = [];

    async function ready(embedder: Embedder = new SynonymEmbedder()): Promise<SearchIndex> {
      const index = await harness.create(embedder);
      open.push(index);
      await index.init();
      await index.replaceChunksForPage(WS, "pg_garage", [chunk("pg_garage", 0, "Automobile maintenance log for the old estate.")]);
      await index.replaceChunksForPage(WS, "pg_kitchen", [chunk("pg_kitchen", 0, "Banana bread, with fruit from the market.")]);
      await index.settled();
      return index;
    }

    afterEach(async () => {
      for (const index of open.splice(0)) await index.close();
    });

    it("finds a page by meaning when no word is shared", async () => {
      const index = await ready();
      const hybrid = await index.search(WS, { query: "car" });
      expect(hybrid.mode).toBe("hybrid");
      expect(hybrid.hits.map((h) => h.pageId)).toEqual(["pg_garage"]);
      expect(hybrid.hits[0]!.snippet.toLowerCase()).toContain("automobile");
    });

    it("runs keyword only when asked", async () => {
      const index = await ready();
      const keyword = await index.search(WS, { query: "car", mode: "keyword" });
      expect(keyword.mode).toBe("keyword");
      expect(keyword.hits).toEqual([]);
    });

    it("still returns nothing when nothing is close in meaning", async () => {
      const index = await ready();
      const result = await index.search(WS, { query: "insomnia" });
      expect(result.hits).toEqual([]);
    });

    it("reports vectors ready and nothing pending once settled", async () => {
      const index = await ready();
      expect(index.status()).toMatchObject({ vectors: "ready", pending: 0, detail: null });
      expect(index.capabilities.vectors).toBe(true);
    });

    it("forgets the meaning of text a page no longer has", async () => {
      const index = await ready();
      await index.replaceChunksForPage(WS, "pg_garage", [chunk("pg_garage", 0, "Now a page about sleep and rest.")]);
      await index.settled();
      await eventually(async () => {
        expect((await index.search(WS, { query: "vehicle" })).hits).toEqual([]);
        expect((await index.search(WS, { query: "insomnia" })).hits.map((h) => h.pageId)).toEqual(["pg_garage"]);
      });
    });

    it("drops a deleted page's vectors", async () => {
      const index = await ready();
      await index.deleteChunksForPage(WS, "pg_kitchen");
      await index.settled();
      expect((await index.search(WS, { query: "fruit" })).hits).toEqual([]);
    });

    it("falls back to keyword search when the model fails on a query", async () => {
      const embedder = new SynonymEmbedder();
      const index = await ready(embedder);
      embedder.failQueries = true;
      const result = await index.search(WS, { query: "banana" });
      expect(result.mode).toBe("keyword");
      expect(result.hits.map((h) => h.pageId)).toEqual(["pg_kitchen"]);
      expect(index.status().vectors).toBe("failed");
    });

    it("serves keyword search when the model cannot load", async () => {
      const index = await ready(new SynonymEmbedder("broken", true));
      const result = await index.search(WS, { query: "banana" });
      expect(result.mode).toBe("keyword");
      expect(result.hits.map((h) => h.pageId)).toEqual(["pg_kitchen"]);
      expect(index.status()).toMatchObject({ vectors: "failed", detail: "model could not be loaded" });
    });
  });
}
