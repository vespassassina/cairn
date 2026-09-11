# Cairn

Open-source document and collection store built for Claude. MCP first, web editor second. Runs on Azure or AWS free tier, or in a single container.

Status: design. See `docs/PRD.md`.

## Start here

1. Read `docs/PRD.md`, then `docs/decisions/`
2. Open this folder in Claude Code; it picks up `CLAUDE.md`
3. Fill `eval/queries.yaml` with 30 real queries before any search work

## Develop

Node 22 or later. pnpm comes from corepack.

```
corepack enable
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

## What exists

1. `packages/core`. Domain logic and the two adapter interfaces, plus the
   conformance suites every adapter runs. No cloud dependencies.
2. `packages/adapter-sqlite`. The reference adapter, on Node's built-in
   `node:sqlite`. FTS5 gives keyword search with no native dependency.

Nothing else yet. The API, the Cosmos adapter and the MCP server are Phase 1.

## Licence

To be decided (PRD Q4). Leaning AGPL-3.0.
