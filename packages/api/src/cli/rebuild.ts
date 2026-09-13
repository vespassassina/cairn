import { basename } from "node:path";
import { ConfigError, loadConfig } from "../config.js";
import { closeContext, createContext } from "../context.js";

/**
 * Regenerate every edge and chunk from the pages (PRD P0.9). The repair path
 * after a crash between a page write and its derived data, and the command to
 * run after changing chunking.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  // A short-lived command: the server embeds new chunks when it next starts (ADR-022).
  const context = await createContext({ ...config, embeddings: { ...config.embeddings, provider: "off" } });
  try {
    const started = Date.now();
    const result = await context.pages.rebuildWorkspace(config.workspaceId);
    const rows = await context.tables.rebuildWorkspace(config.workspaceId);
    process.stdout.write(
      `rebuilt ${result.pages} pages and the links of ${rows.rows} rows in ${Date.now() - started}ms\n` +
        `swept ${result.orphanRevisions} revisions left off their chain by an interrupted write\n`,
    );
  } finally {
    await closeContext(context);
  }
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`configuration error: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  });
}
