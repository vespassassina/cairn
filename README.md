# Cairn

Open-source document and collection store built for Claude. MCP first, web editor second. Runs on Azure or AWS free tier, or in a single container.

Status: design. See `docs/PRD.md`.

## Start here

1. Read `docs/PRD.md`, then `docs/decisions/`
2. Open this folder in Claude Code; it picks up `CLAUDE.md`
3. Fill `eval/queries.yaml` with 30 real queries before any search work

## Run it locally

See `docs/LOCAL.md`. Short version, with Node 22 or later:

```
corepack enable && pnpm install
export CAIRN_TOKEN=$(openssl rand -hex 24)
pnpm import ~/notes
pnpm dev
```

Then point Claude Code at it:

```
claude mcp add --transport http cairn http://127.0.0.1:8787/mcp --header "Authorization: Bearer $CAIRN_TOKEN"
```

## What exists

1. `packages/core`. Domain logic and the two adapter interfaces, plus the
   conformance suites every adapter runs. No cloud dependencies.
2. `packages/adapter-sqlite`. The reference adapter, on Node's built-in
   `node:sqlite`. FTS5 gives keyword search with no native dependency.
3. `packages/api`. Hono app, the MCP server over stateless streamable HTTP,
   dev-mode bearer auth, and the import, rebuild and eval commands.

Not yet: OAuth, the Cosmos and DynamoDB adapters, the web editor, embeddings,
attachments and export.

## Licence

To be decided (PRD Q4). Leaning AGPL-3.0.
