# Architecture

The blueprint: how Cairn is built today, and why it is shaped that way. The PRD says what Cairn is for. The ADRs record each decision. This file is the current picture, and it changes whenever the shape of the system does.

## The shape

```
Agent without a shell    Agent with a shell      Browser (owner)
(claude.ai, Desktop)     (Claude Code, Codex)
        |                  cairn CLI + skill            |
        |  stateless MCP         |  HTTP                |  HTML forms
        v                        v                      v
  +-----------------------------------------------------------+
  |  api: Hono app, web standard Req/Res                       |
  |    /mcp        MCP tools            \  one auth check,     |
  |    /api/v1     REST, changes feed   /  operations.ts      |
  |    /           review console (ADR-009)                    |
  |    entry/node.ts   (lambda, azure later)                   |
  +-----------------------------------------------------------+
        |
        v
  +-------------------------------------------+
  |  core: services, domain rules, no I/O deps |
  |    PageService, CollectionService          |
  |    indexer: links, chunks (pure)           |
  |    query: filter grammar, validation       |
  +-------------------------------------------+
        |                        |
        v                        v
  DocumentStore port        SearchIndex port
        |                        |
  adapter-sqlite            adapter-sqlite (FTS5)
  (cosmos, dynamo later)    (cosmos full-text, S3 index later)
```

## Packages

1. `packages/core`. Domain types, the two ports, the services, and the conformance suites. No dependencies. Nothing here knows which cloud it runs on.
2. `packages/adapter-sqlite`. The reference implementation of both ports on `node:sqlite`. CI always runs it.
3. `packages/api`. The Hono app, the MCP tools, and server instructions with a live summary of the workspace (ADR-011, ADR-012), the review console, and the command-line tools. The only package that knows about HTTP. On Node it listens on both loopback addresses, 127.0.0.1 and ::1.
4. `packages/cli`. The `cairn` command. A thin HTTP client for the REST API with no dependencies, so it works the same against a local or deployed server (ADR-013).
5. `skills/cairn`. The skill file that tells a coding agent when and how to use the CLI.
6. `examples/`. Dataset-specific scripts, such as the peptide wiki seed. Not part of the product.

## Three doors, one core

MCP, REST and the CLI are translations (ADR-013). `api/src/operations.ts` holds what they share: edit modes, section replacement, the error mapping and the JSON shapes of pages, rows and revisions. Both MCP and REST sit behind the same auth check, and REST writes are attributed like MCP writes, by the caller's user agent. Version tokens are ETags on REST and `version` fields on MCP; the check behind them is the same.

`pnpm context-cost` measures what each door costs an agent's context. MCP loads every tool schema in every session; the CLI costs a skill description until it is used.

## Data

Three kinds of record, and the difference between them is the most important thing in this file.

1. **Source of truth: pages and rows.** Written with optimistic concurrency. Never derived from anything.
2. **History: revisions.** One immutable snapshot per write of a page or row, linked into a chain by the version each one replaced. Also source of truth: history cannot be rebuilt from anything else (ADR-008).
3. **Derived: edges and chunks.** Computed from pages by pure functions, written with an idempotent replace per page, and rebuildable from scratch at any time (ADR-005).

## The write path

In this order, because no transaction spans documents (ADR-005 rule 3, ADR-008 rule 3):

1. Write the revision. Immutable, keyed by the new version, cannot conflict.
2. Write the page or row, checking the expected version. On conflict, delete the revision from step 1 and return the current content.
3. Replace the page's edges and chunks.

A crash after step 1 leaves a revision off the chain, which is never shown and is swept by rebuild. A crash after step 2 leaves stale derived data, which rebuild regenerates. Nothing is ever half-written in a way a reader can see.

## Consistency

1. Reads of a page, row or revision by id: immediate.
2. Lists, backlinks, neighbours, search and recent changes: eventual, within 10 seconds.

## Rules that keep this portable

See CLAUDE.md, "Hard rules". The short version: no cloud SDK outside an adapter, every adapter passes the shared suites unchanged, route handlers use web standard types, and optional services degrade instead of failing.

## Where the decisions live

`docs/decisions/README.md` indexes every ADR. `docs/CHANGELOG.md` records what changed and why, in order. `docs/DIRECTIONS.md` keeps the owner's instructions, and `docs/LESSONS.md` keeps failures and what they taught. `docs/README.md` maps them all.
