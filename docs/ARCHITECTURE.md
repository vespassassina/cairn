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
  |    /w          published wiki, no sign-in (ADR-032)        |
  |    /.well-known/cairn.json  self-description (ADR-034)     |
  |    entry/node.ts   (one container everywhere, ADR-020)     |
  +-----------------------------------------------------------+
        |
        v
  +-------------------------------------------+
  |  core: services, domain rules, no I/O deps |
  |    PageService, TableService               |
  |    indexer: links, chunks (pure)           |
  |    query: filter grammar, validation       |
  +-------------------------------------------+
        |                        |
        v                        v
  DocumentStore port        SearchIndex port
        |                        |
  adapter-sqlite            adapter-sqlite (FTS5, sqlite-vec)
  (cosmos, dynamo: optional, on an ADR-020 trigger)
```

## Packages

1. `packages/core`. Domain types, the two ports, the services, and the conformance suites. No dependencies. Nothing here knows which cloud it runs on.
2. `packages/adapter-sqlite`. The reference implementation of both ports on `node:sqlite`. CI always runs it.
3. `packages/api`. The Hono app, the MCP tools, and server instructions with a live summary of the workspace (ADR-011, ADR-012), the REST API, the OAuth server (ADR-017), the review console, and the command-line tools. The only package that knows about HTTP. On Node it listens on both loopback addresses, 127.0.0.1 and ::1.
4. `packages/cli`. The `cairn` command. A thin HTTP client for the REST API with no dependencies, so it works the same against a local or deployed server (ADR-013). It ships as an npm package, and as standalone executables for five platforms built by `scripts/build-cli.mjs` (ADR-014).
5. `skills/cairn`. The skill file that tells a coding agent when and how to use the CLI.
6. `examples/`. Dataset-specific scripts, such as the peptide wiki seed. Not part of the product.
7. `scripts/`. Build and check tools: the artifactkit sync, the CLI build and its smoke test.
8. `.github/workflows/ci.yml`. Tests on Linux, macOS and Windows, a CLI build and smoke test on each, and release executables on a version tag.

## Three doors, one core

MCP, REST and the CLI are translations (ADR-013). `api/src/operations.ts` holds what they share: edit modes, section replacement, the error mapping and the JSON shapes of pages, rows and revisions. Both MCP and REST sit behind the same auth check, and REST writes are attributed like MCP writes, by the caller's user agent. Version tokens are ETags on REST and `version` fields on MCP; the check behind them is the same.

`pnpm context-cost` measures what each door costs an agent's context. MCP loads every tool schema in every session; the CLI costs a skill description until it is used.

## Signing in

Local: nothing (ADR-010). Anywhere else, OAuth (ADR-017):

1. `packages/api/src/oauth/` holds a small OAuth 2.1 server: discovery documents, dynamic client registration, authorize with a consent page, tokens, revocation. Sign-in is delegated to GitHub or any OpenID Connect provider; an allowlist decides who gets in.
2. Access tokens are HS256 JWTs, checked on every MCP and REST request with no store read. The console uses a session cookie from the same sign-in, and writes are attributed to the signed-in person.
3. Clients, codes and refresh tokens live in the `AuthStore` port, apart from content, with its own conformance suite. SQLite implements it in the same file. Refresh tokens rotate and are single use; a repeat within 60 seconds is answered with the tokens already issued, and after that it revokes the sign-in (ADR-033).
4. The one exception to sign-in is the published wiki (ADR-032): `/w`, `/sitemap.xml`, `/robots.txt` and `/.well-known/cairn.json` (ADR-034) serve pages an owner marked public, read-only, to anyone. `packages/core/src/publish.ts` works out which pages those are by walking each page's ancestors, and `packages/api/src/web/public.tsx` reads nothing outside that set. `cairn.json` describes the Cairn itself, from settings the owner sets (`CAIRN_NAME` and the like), for a registry or a crawler to read, and its `cites` field, the origins its published pages cite (`citedCairnOrigins`, reusing the `isBasedOn` computation below, ADR-041). Each published page also carries its sources as JSON-LD in its `<head>` (ADR-039): schema.org `citation` for every one, `isBasedOn` for any shaped like another Cairn's published page, computed from data the page already has, nothing fetched. The same surface's one write is `POST /webmention` (ADR-040): a Webmention-shaped citation notice, verified by an SSRF-safe fetch of the sender's page (`packages/api/src/citations.ts`) before it becomes a row in a lazily-created "Citations" table, `accepted` at once when its origin is in "Trusted cairns" (ADR-037) and `pending` for the owner otherwise. A published page shows a "Cited by" section for its accepted rows; a static site export does not, since it cannot receive the notice at all.

## Export and import

`cairn export` reads pages through `GET /api/v1/export/pages`, parents first, and tables through the rows endpoints, and writes Markdown and JSON (ADR-016). `cairn import` reads that folder and writes through `PUT` at the same ids, comparing first so a repeat changes nothing. Derived data is rebuilt by the writes, as always. `cairn export --format site` (ADR-035) reads the same pages and renders a folder of plain HTML instead, entirely in the CLI (`packages/cli/src/site-format.ts`): wiki links resolved to relative `.html` paths, a breadcrumb and child list per page, sources kept as clickable citations and the same JSON-LD `citation`/`isBasedOn` the published wiki carries (ADR-039), an `index.html`, and a `sitemap.xml` when `--site-url` is given. No server or MCP change; the CLI is the only surface that needs a site's worth of HTML.

`cairn check-sources [--root PAGE]` (ADR-036) is a client of the web, the same way sync is a client of two servers: it reads every page's and row's sources through the same export endpoints, checks each linked one (a web address, a DOI or a PubMed id, resolved by `sourceHref`) once, and reports which no longer answer, with a Wayback Machine copy for the dead ones. Report only, no server or MCP change, nothing written.

`cairn trust <url>` (ADR-037) is the same kind of client: it fetches `<url>/.well-known/cairn.json` (ADR-034) to confirm the address is a Cairn, then adds or updates a row for it in this Cairn's own "Trusted cairns" table, an ordinary table with no schema or storage change. Reading and managing that table needs nothing new: `cairn tables`, `rows`, `row` and `upsert`, and the equivalent MCP tools and REST endpoints, already work on it like any other table. The list stays local, part of this Cairn's own data, not on the published surface unless the owner publishes it like any other collection.

`cairn discover [--from URL]... [--depth N] [--limit N]` (ADR-041) is another client of the web, built on the same `fetchPeerDescription`: starting from every url in "Trusted cairns" plus any `--from`, it walks breadth first, reading each Cairn's `cites` and following the origins it names, bounded by `--depth` (default 2) and `--limit` (default 200 Cairns visited). A newly found Cairn lands in a new, lazily-created "Discovered cairns" table, the same free way "Trusted cairns" is read and managed; a Cairn already trusted is always a starting point of its own walk, so it is never reported as newly found. No server or MCP change: this is a CLI-only, client-of-the-web command, the same posture as `cairn trust` and `cairn check-sources`.

`POST /webmention` (ADR-040) is the other direction: a server, not a client, since it is this Cairn's own outward-facing address that gets notified when another site links to one of its published pages. `packages/api/src/citations.ts` verifies the notice by fetching the sender's page itself, through the one SSRF-safe helper in this codebase (http or https only, the hostname resolved and checked against private and loopback ranges at every redirect hop, bounded timeout and size), and confirming it really links back. A verified notice becomes a row in a lazily-created "Citations" table, `accepted` when the sender's origin is in "Trusted cairns" and `pending` otherwise, read and managed the same free way as that table: no new console, MCP or CLI code.

`cairn sync <a> <b>` (ADR-023) is a client of two servers. It reads every page, table and row from both, compares each record's content hash with the one both sides agreed on at the last sync, kept in a state file beside the CLI's credentials, and writes the side that changed to the other through the same `PUT` and `DELETE` endpoints, with `If-Match`. Each copy carries `edited_at`, when the record was edited where it was edited, so the order of edits survives any number of hops (ADR-030). When both changed a page or row, sync finds the version they last agreed on in history and merges the two three ways, as git does: the body line by line, tags and sources as sets, row fields one by one. A part both changed takes the newer edit, and the replaced version stays in that side's history. Without that version, and for tables, the newer edit wins whole. No server knows it is being synced.

With several Cairns registered by name in `instances.json` (ADR-029), the CLI sends each command to the first that answers `/health`, and `cairn sync` runs the same pairwise sync between that one and each of the others, a hub. `cairn start` and a job the CLI installs on launchd, systemd or Task Scheduler run that sync on starting and on a schedule. The servers are unchanged: each is an ordinary Cairn.

## Deployment

1. **Local:** `pnpm dev`, tsx running the TypeScript directly.
2. **Container:** `pnpm build:server` bundles the server with esbuild into one file. The image holds that file, Node and Litestream, and is published by CI to `ghcr.io/vespassassina/cairn`.
3. **Own server (ADR-020):** `deploy/docker/compose.yaml` runs the image with the database on a mounted local volume at `/data`. A Litestream replica is optional.
4. **Azure (ADR-018):** Container Apps, one replica at most, zero when idle. The database is on the container's disk; Litestream restores it from Blob Storage on start and streams every change back, through the app's managed identity. `deploy/azure/main.bicep` and `deploy.sh` create it all.

## Data

Three kinds of record, and the difference between them is the most important thing in this file.

1. **Source of truth: pages and rows.** Written with optimistic concurrency. Never derived from anything. Each carries its sources, the URLs or citations its facts came from, as part of its content: they are in its revisions, its export and its sync hash (ADR-027). A page also carries `verified_at`, when its facts were last confirmed, in the same places (ADR-028).
2. **History: revisions.** One immutable snapshot per write of a page or row, linked into a chain by the version each one replaced. Also source of truth: history cannot be rebuilt from anything else (ADR-008).
3. **Derived: edges and chunks.** Computed from pages, and edges also from rows, by pure functions, written with an idempotent replace per record, and rebuildable from scratch at any time (ADR-005).

## The tree and the link graph

Pages form a tree through `parent_id`, and tables sit in it too, under a page or at the top (ADR-024). A top-level page and everything under it is a collection, one wiki, which is how the console groups them (ADR-026); a collection is a view of the tree, not a stored record. The link graph is the edges table: one edge per link, mention, parent or tag in a page's text, and one per value of a row's relation fields. A node is a page id, a table id, or a row as `table-id/row-id`, so page text can link to all three (`[[id]]`), and a relation field links a row to pages or to the rows of any table, its own included. Backlinks are read from the same table by target, so nothing is stored twice.

An ordinary Markdown link whose address is shaped `<origin>/w/<page-id>`, another Cairn's canonical published address (ADR-032), becomes a `cairn_link` edge (ADR-038): its target is the full URL, not a local id, the same way a `tag` edge targets `tag:<name>`. Recognition is structural only, from the URL's shape, so extraction stays a pure function with no I/O (ADR-005, ADR-009's edges-rebuildable rule); nothing is fetched to tell a live link from a dead one, and the ADR-037 trusted list plays no part in what counts as a link. `get_backlinks`, `get_neighbours` and `cairn links` report a `cairn_link` edge as `{ cairn_url, type, label }`.

## The write path

In this order, because no transaction spans documents (ADR-005 rule 3, ADR-008 rule 3):

1. Write the revision. Immutable, keyed by the new version, cannot conflict.
2. Write the page or row, checking the expected version. On conflict, delete the revision from step 1 and return the current content.
3. Replace the page's edges and chunks, or the row's edges.

A crash after step 1 leaves a revision off the chain, which is never shown and is swept by rebuild. A crash after step 2 leaves stale derived data, which rebuild regenerates. Nothing is ever half-written in a way a reader can see.

## Consistency

1. Reads of a page, row or revision by id: immediate.
2. Lists, backlinks, neighbours, search and recent changes: eventual, within 10 seconds.

Search returns pages that hold most of the query's words, with filler words ignored and each page's best chunk first; the rules live in `core/src/search/terms.ts` and the conformance suite, so every backend applies them (ADR-021). SQLite stems with FTS5's Porter tokenizer. A term match does not count towards a page's coverage when every occurrence of it sits next to a negation or decrease word ("less hungry" is not "hungry"), a small generic English lexicon also in `core/src/search/terms.ts` (ADR-042).

With embeddings on (the default), the same adapter keeps vectors in sqlite-vec tables and searches by meaning too: a small English model (bge-small-en-v1.5) runs in the server process behind the `Embedder` port (`packages/adapter-embeddings-local`), chunks are embedded in the background after each write, and hybrid search fuses the two rankings. Without the model, or if it fails, search is keyword only and says so (ADR-022).

## Rules that keep this portable

See CLAUDE.md, "Hard rules". The short version: no cloud SDK outside an adapter, every adapter passes the shared suites unchanged, route handlers use web standard types, and optional services degrade instead of failing.

## Where the decisions live

`docs/decisions/README.md` indexes every ADR. `docs/CHANGELOG.md` records what changed and why, in order. `docs/DIRECTIONS.md` keeps the owner's instructions, and `docs/LESSONS.md` keeps failures and what they taught. `docs/README.md` maps them all.
