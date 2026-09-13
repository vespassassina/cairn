import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalEmbedder } from "../src/index.js";

/**
 * Runs the real model, so it is skipped unless CAIRN_TEST_MODEL=1: the first
 * run downloads 34 MB. The rest of the suite uses a fake embedder
 * (`SynonymEmbedder`), and the container image is checked in CI.
 */
describe.skipIf(!process.env["CAIRN_TEST_MODEL"])("LocalEmbedder with bge-small-en-v1.5", () => {
  it("returns normalised 384-dimension vectors that rank a related passage first", async () => {
    const embedder = new LocalEmbedder({ cacheDir: join(homedir(), ".cache", "cairn", "models") });
    await embedder.init();
    try {
      expect(embedder.dimensions).toBe(384);
      const [sleep, bread] = await embedder.embedDocuments([
        "DSIP is a neuropeptide studied for its effect on sleep.",
        "Knead the dough and let it rise overnight.",
      ]);
      const query = await embedder.embedQuery("something to help me fall asleep");
      const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, value, i) => sum + value * b[i]!, 0);
      expect(Math.hypot(...query)).toBeCloseTo(1, 3);
      expect(dot(query, sleep!)).toBeGreaterThan(dot(query, bread!));
    } finally {
      await embedder.close();
    }
  }, 120_000);
});
