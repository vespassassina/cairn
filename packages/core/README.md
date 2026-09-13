# @cairn/core

Domain logic and adapter interfaces. Builds with zero cloud dependencies, and
imports nothing outside the Node standard library.

## Layout

1. `src/types.ts` and `src/errors.ts`. Domain types and the error taxonomy.
2. `src/ports/`. The two adapter interfaces, `DocumentStore` and `SearchIndex`.
   The comments there are the contract: read them before writing an adapter.
3. `src/query/`. The table filter grammar and row validation, both of
   which run here rather than in an adapter (ADR-005 rule 5).
4. `src/indexer/`. Link extraction and chunking. Pure functions, deterministic,
   so a rebuild reproduces the same derived data.
5. `src/services/`. The write paths. `PageService` owns the order of page then
   derived data, and the rebuild that repairs a gap between them.
6. `src/testing/`. The conformance suites, exported as `@cairn/core/testing`.

## Writing a new adapter

1. Implement `DocumentStore`, `SearchIndex`, or both. They are independent.
2. Declare capabilities honestly. Only claim `rowQueryPushdown` if `queryRows`
   is implemented and returns what core's in-memory evaluation returns.
3. Run all three suites from `@cairn/core/testing`. See
   `packages/adapter-sqlite/test/conformance.test.ts`, which is six lines.
4. If a suite needs a branch for your adapter, the adapter is wrong, not the
   suite (CLAUDE.md hard rule 2).
