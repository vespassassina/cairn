import { LocalEmbedder } from "./index.js";

/**
 * Downloads the default model into a folder, with exactly the settings the
 * server loads it with. The container build runs it, so the image ships the
 * model and never fetches at runtime (ADR-022).
 *
 * Usage: node fetch-model.mjs <folder>
 */
const folder = process.argv[2];
if (!folder) {
  process.stderr.write("usage: node fetch-model.mjs <folder>\n");
  process.exit(2);
}
const embedder = new LocalEmbedder({ cacheDir: folder, allowDownload: true });
await embedder.init();
process.stdout.write(`${embedder.model}: ${embedder.dimensions} dimensions, in ${folder}\n`);
await embedder.close();
