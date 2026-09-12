# Cairn

Open-source document and collection store built for Claude. MCP first, web editor second. Runs on Azure or AWS free tier, or in a single container.

Status: design. See `docs/PRD.md`.

## Start here

1. Read `docs/README.md` for a map of the docs, then `docs/PRD.md` and `docs/decisions/`
2. Open this folder in Claude Code; it picks up `CLAUDE.md`
3. Fill `eval/queries.yaml` with 30 real queries before any search work

## Run it locally

See `docs/LOCAL.md`. Short version, with Node 22 or later:

```
corepack enable && pnpm install
pnpm import ~/notes
pnpm dev
```

Open http://localhost:8787 for the review console, and point Claude Code at it:

```
claude mcp add --transport http --scope user cairn http://localhost:8787/mcp
```

No token on localhost (ADR-010). Settings are in `cairn.config.json`. Start a new Claude session after adding it: sessions load MCP servers when they start. Cairn tells Claude when to use it (ADR-011).

## What exists

1. `packages/core`. Domain logic and the two adapter interfaces, plus the
   conformance suites every adapter runs. No cloud dependencies.
2. `packages/adapter-sqlite`. The reference adapter, on Node's built-in
   `node:sqlite`. FTS5 gives keyword search with no native dependency.
3. `packages/api`. Hono app, the MCP server over stateless streamable HTTP,
   the review console, no sign-in on localhost (ADR-010), server
   instructions that tell Claude when to use Cairn (ADR-011), and the import,
   rebuild and eval commands.

Not yet: OAuth, the Cosmos and DynamoDB adapters, the web editor, embeddings,
attachments and export.

## Licence

To be decided (PRD Q4). Leaning AGPL-3.0.
