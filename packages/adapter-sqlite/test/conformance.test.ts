import {
  runAuthStoreConformance,
  runDocumentStoreConformance,
  runHybridSearchConformance,
  runPushdownConformance,
  runSearchIndexConformance,
} from "@cairn/core/testing";
import { SqliteAuthStore, SqliteDocumentStore, SqliteSearchIndex } from "../src/index.js";

// The adapter runs the shared suites unchanged (CLAUDE.md hard rule 2).
runDocumentStoreConformance("sqlite", {
  create: async () => new SqliteDocumentStore(),
});

runSearchIndexConformance("sqlite fts5", {
  create: async () => new SqliteSearchIndex(),
});

runHybridSearchConformance("sqlite fts5 + sqlite-vec", {
  create: async (embedder) => new SqliteSearchIndex({ embedder, minSimilarity: 0.5 }),
});

runPushdownConformance("sqlite", {
  create: async () => new SqliteDocumentStore(),
});

runAuthStoreConformance("sqlite", {
  create: async () => new SqliteAuthStore(),
});
