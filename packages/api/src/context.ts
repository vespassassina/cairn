import { CollectionService, PageService } from "@cairn/core";
import type { Actor, AuthStore, DocumentStore, SearchIndex } from "@cairn/core";
import { SqliteAuthStore, SqliteDocumentStore, SqliteSearchIndex } from "@cairn/adapter-sqlite";
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
  config: Pick<Config, "database" | "workspaceId">,
): Promise<AppContext> {
  // Both adapters open the same file. WAL mode lets them share it.
  const store = new SqliteDocumentStore({ location: config.database });
  const search = new SqliteSearchIndex({ location: config.database });
  const auth = new SqliteAuthStore({ location: config.database });
  await store.init();
  await search.init();
  await auth.init();

  return {
    store,
    search,
    pages: new PageService(store, search),
    collections: new CollectionService(store),
    auth,
    workspaceId: config.workspaceId,
  };
}

export async function closeContext(context: AppContext): Promise<void> {
  await context.auth.close();
  await context.search.close();
  await context.store.close();
}
