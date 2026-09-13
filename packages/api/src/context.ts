import { TableService, PageService } from "@cairn/core";
import type { Actor, AuthStore, DocumentStore, SearchIndex } from "@cairn/core";
import { SqliteAuthStore, SqliteDocumentStore, SqliteSearchIndex } from "@cairn/adapter-sqlite";
import { LocalEmbedder } from "@cairn/adapter-embeddings-local";
import type { Config } from "./config.js";

/**
 * Everything a request handler needs. Built once at startup and passed in, so
 * no module reaches for a global and every test can supply its own.
 *
 * The adapters are chosen here and nowhere else. Swapping SQLite for Cosmos is
 * a change to this file alone (ADR-005).
 */
export interface AppContext {
  store: DocumentStore;
  search: SearchIndex;
  pages: PageService;
  tables: TableService;
  /** OAuth clients, codes and refresh tokens, apart from content (ADR-017). */
  auth: AuthStore;
  workspaceId: string;
}

/**
 * The owner, in dev mode. Web edits and command-line tools write as this actor
 * until OIDC sign-in gives a real identity (ADR-007, ADR-008 rule 4).
 */
export const OWNER: Actor = { kind: "user", id: "owner", label: "Owner" };

/** The owner acting through a named tool, so history shows how a change arrived. */
export function ownerVia(tool: string): Actor {
  return { ...OWNER, label: `Owner, via ${tool}` };
}

export async function createContext(
  config: Pick<Config, "database" | "workspaceId"> & Partial<Pick<Config, "embeddings">>,
): Promise<AppContext> {
  // Both adapters open the same file. WAL mode lets them share it.
  const store = new SqliteDocumentStore({ location: config.database });
  // Semantic search is opt-in per caller: tests and short-lived commands pass
  // no embeddings config and never load the model (ADR-022).
  const embeddings = config.embeddings;
  const search = new SqliteSearchIndex({
    location: config.database,
    ...(embeddings?.provider === "local"
      ? {
          embedder: new LocalEmbedder({ cacheDir: embeddings.modelDir, allowDownload: embeddings.allowDownload }),
          ...(embeddings.margin !== null ? { margin: embeddings.margin } : {}),
          onVectorError: (error: unknown) =>
            process.stderr.write(
              `semantic search is off, keyword search carries on: ${error instanceof Error ? error.message : String(error)}\n`,
            ),
        }
      : {}),
  });
  const auth = new SqliteAuthStore({ location: config.database });
  await store.init();
  await search.init();
  await auth.init();

  const pages = new PageService(store, search);
  if (search.needsRebuild) {
    // The search index changed format and was emptied. Chunks are derived
    // from pages, so rebuild them before serving (ADR-021).
    const started = Date.now();
    const result = await pages.rebuildWorkspace(config.workspaceId);
    process.stderr.write(
      `search index upgraded: rebuilt ${result.pages} pages in ${Date.now() - started}ms\n`,
    );
  }
  const tables = new TableService(store);
  if (await tables.needsRelink(config.workspaceId)) {
    // Rows written before relations became links (ADR-024).
    const result = await tables.rebuildWorkspace(config.workspaceId);
    process.stderr.write(`links derived for ${result.rows} rows\n`);
  }

  return {
    store,
    search,
    pages,
    tables,
    auth,
    workspaceId: config.workspaceId,
  };
}

export async function closeContext(context: AppContext): Promise<void> {
  await context.auth.close();
  await context.search.close();
  await context.store.close();
}
