import { CollectionService, PageService } from "@cairn/core";
import type { DocumentStore, SearchIndex } from "@cairn/core";
import { SqliteDocumentStore, SqliteSearchIndex } from "@cairn/adapter-sqlite";
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
  collections: CollectionService;
  workspaceId: string;
}

export async function createContext(config: Config): Promise<AppContext> {
  // Both adapters open the same file. WAL mode lets them share it.
  const store = new SqliteDocumentStore({ location: config.database });
  const search = new SqliteSearchIndex({ location: config.database });
  await store.init();
  await search.init();

  return {
    store,
    search,
    pages: new PageService(store, search),
    collections: new CollectionService(store),
    workspaceId: config.workspaceId,
  };
}

export async function closeContext(context: AppContext): Promise<void> {
  await context.search.close();
  await context.store.close();
}
