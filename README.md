# Cairn

**A wiki and tables your agents can write to, with every change reviewable.**

Open source and self-hosted. Agents write pages and table rows directly, with no approval step, and every write is a revision you can review in a small console and undo. Runs as one SQLite file on your machine, and is being built to run on the Azure or AWS free tier.

Three doors for agents, over one core:

| Door | For | Context cost per session |
|---|---|---|
| `cairn` CLI and skill | agents with a shell: Claude Code, Codex | about 115 tokens until used |
| MCP | claude.ai, Claude Desktop, Cowork | about 2,700 tokens |
| REST at `/api/v1` | scripts, cron jobs, other agents | none |

Characters measured with `pnpm context-cost` on a 33-page wiki, tokens estimated at four characters each.

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

Or, for Claude Code, use the CLI and skill instead (`docs/LOCAL.md` section 5b):

```
pnpm build && npm install -g ./packages/cli
cp -r skills/cairn ~/.claude/skills/
cairn overview
```

## What exists

1. `packages/core`. Domain logic and the two adapter interfaces, plus the
   conformance suites every adapter runs. No cloud dependencies.
2. `packages/adapter-sqlite`. The reference adapter, on Node's built-in
   `node:sqlite`. FTS5 gives keyword search with no native dependency.
3. `packages/api`. Hono app, the MCP server over stateless streamable HTTP,
   the review console, no sign-in on localhost (ADR-010), server
   instructions that tell Claude when to use Cairn (ADR-011), the REST API
   and changes feed (ADR-013), and the import, rebuild and eval commands.
4. `packages/cli`. The `cairn` command, and `skills/cairn`, the skill that
   teaches a coding agent to use it.

Not yet: OAuth, the Cosmos and DynamoDB adapters, the web editor, embeddings,
attachments and export.

## Licence

To be decided (PRD Q4). Leaning AGPL-3.0.
