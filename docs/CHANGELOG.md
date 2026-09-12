# Changelog

What changed, and why. Newest first. One entry per meaningful change: code, design direction or decision. The why matters more than the what: the code already records the what.

Entries link to the ADR when there is one. A change of direction that has no ADR yet still gets an entry here.

## 2026-09-12

### Decision: one core, three surfaces (ADR-013)

Agents now get in three ways: MCP, a REST API at `/api/v1`, and a `cairn` command with a skill file. All three sit on the same core, the same auth check and the same error codes. ADR-001 is refined, not replaced: the agent is still the primary client, and MCP is now one of its doors.

Why: MCP loads every tool schema into every session, used or not. The most common Hacker News complaint about agent memory tools is exactly that cost. Agents with a shell can use a command that costs nothing until it runs.

### Added: REST API at `/api/v1`

Pages, collections, rows, history, revisions, search and an overview, with version tokens as `ETag` and `If-Match`. `PATCH` and `DELETE` without `If-Match` get 428, and a wildcard is refused, so no write skips the concurrency check. A stale version gets 409 with the current content. Pages can be read as Markdown with `?format=markdown`, the cheapest read for an agent. 20 contract tests.

### Added: the changes feed

`GET /api/v1/changes?since=<time>&actor=agent|user` lists revisions newest first. `since` is inclusive, and the response says which value to pass next time. This is how a second agent, a script or another machine finds out what changed, instead of searching again.

### Added: the `cairn` CLI and skill

`packages/cli` is a dependency-free HTTP client with compact text output and `--json` for scripts. `skills/cairn/SKILL.md` tells a coding agent when to use it, in the same terms as the MCP server instructions. `cairn append` may skip `--version`, because appending never overwrites; every other edit needs the version the agent read. Checked live against a copy of the seeded wiki, and by 9 tests that drive the real app.

### Changed: MCP and REST share one operations module

Edit modes, section replacement, error mapping and the JSON shapes of pages, rows and revisions moved from the MCP tools into `packages/api/src/operations.ts`. The MCP tools now translate only. No change to their behaviour; the existing contract tests pass unchanged.

### Finding: MCP costs about 23 times more context than the CLI

`pnpm context-cost` measures what each door sends. On the peptide wiki, MCP sends 10,721 characters per session, about 2,700 tokens: 8,912 for the 12 tool schemas, 1,809 for the instructions and summary. The skill description is 459 characters, about 115 tokens, and the skill body, about 724 tokens, loads only when Cairn is used. Tokens are estimated at four characters each. The README states these numbers.

### Changed: the workspace summary no longer names an MCP tool

The collections heading said "query with query_collection", which is wrong for a CLI user reading `cairn overview`. It now just says "Collections".

### Direction: the tagline is "a wiki and tables your agents can write to, with every change reviewable"

The owner chose it from the project review. The PRD and the README lead with it, and the README now shows the three doors and their context cost.

### Finding: the landscape, and what to fix before publishing

A review against similar projects on Hacker News and elsewhere. Agent memory is crowded and HN is tired of it: a typical comment on a 71-point Show HN called another memory tool "about the same as grep in a memory/ directory". The closest projects are Basic Memory (Markdown and MCP, no typed tables, history only in its paid cloud) and Remnus (pages and databases over MCP on SQLite). No one found combines typed tables, a revision for every write, a review screen for agent writes, and one codebase for local and free-tier cloud. PRD section 1 records the landscape.

The same review found gaps to close before launch, now the roadmap's launch checklist: the eval set has 2 of 30 queries, export is not built, nothing runs on a cloud yet, OAuth is missing so claude.ai cannot connect, and the online and offline model is not designed.

It also answered parts of Q1 and Q7 from Microsoft's docs. Cosmos vector indexing is not supported on shared-throughput accounts, so vectors on the free tier need a dedicated container. Flex Consumption grants 250,000 executions and 100,000 GB-s a month. Cosmos full-text lists Italian, but multi-language support is in preview and Dutch is not listed.

### Decision: a live summary of the workspace in the server instructions (ADR-012)

At initialize, the instructions now end with what the workspace holds: collections with row counts, the page total, top-level pages largest first with the number of pages under each, and up to 12 common tags. On the peptide wiki the whole text is 1,838 of the 2,000 characters.

Why: ADR-011 told Claude to search Cairn when it might hold a topic, but Claude could not know what it held without searching first. The owner asked whether Cairn advertised its topics; it did not.

Safety: titles and tags are written by agents too, and this text reaches every session. Each value is flattened to one line, cut to 60 characters and written as a JSON string, and the summary says they are data, never instructions. A test stores a title that tries to inject new lines and a fake entry, and checks it stays on one quoted line. The summary is built only for initialize, cached for 60 seconds, and a failure to build it falls back to the fixed text.

### Decision: Cairn tells clients when to use it (ADR-011)

Cairn now sends MCP server instructions at initialize: search before answering, save lasting knowledge without being asked, prefer updating an existing page, give every write a change note, merge on a version conflict, never store secrets. The text is 1,221 characters in `packages/api/src/mcp/instructions.ts`. A contract test holds it under a 2,000 character budget and checks that every tool it names exists.

Why: tools are available to a client, never required. Without guidance, Claude used Cairn only when asked, which makes it a store rather than memory. Server instructions reach every Claude Code session with no setup, unlike a per-user CLAUDE.md.

The owner's own global Claude Code instructions gained a matching section. That file is outside this repo; `docs/DIRECTIONS.md` records it.

### Fixed: `pnpm dev` crashed with a raw stack trace when the port was taken

The owner's `pnpm dev` failed because a server the agent had started was holding port 8787. It now prints what EADDRINUSE means and how to check, find or move away from the other process. See `docs/LESSONS.md`.

### Fixed: the server did not answer on IPv6 localhost

It bound 127.0.0.1 only, so a client resolving `localhost` to ::1 would get no answer. It now binds both loopback addresses. The IPv6 one is optional, and the startup banner lists what was bound.

### Added: logs of owner directions and of failures and lessons

`docs/DIRECTIONS.md` keeps the owner's instructions, in their words, with where each landed. `docs/LESSONS.md` keeps failures with cause, fix and lesson, backfilled to the start of the project. `docs/README.md` maps all the docs. CLAUDE.md's documentation discipline now names the four logs: directions, decisions, changes, lessons.

Why: the owner asked for it, because Cairn will be open source. The ADRs and this file kept the decisions and the work, but not the original ask or what went wrong, so a reader could not tell the owner's choices from the agent's, or learn from the failures.

### Changed: `docs/LOCAL.md` and the README for connecting Claude Code

They now use `--scope user`, say that a session must be restarted to see a newly added server, explain the port-in-use message, and describe the server instructions and tool permissions. The old LOCAL.md intro still described a static bearer token, which ADR-010 removed; that doc was wrong and is now fixed.

### Decision: no sign-in on localhost (ADR-010)

On the loopback dev server, requests addressed to a trusted local host name need no token, in the console or over MCP. `CAIRN_TOKEN` is now optional. Extra host names and an off switch live in a new, committed `cairn.config.json`.

Why: the owner asked for it, and a token on a loopback-only server protected against little while making the console look broken.

What keeps it safe: the Host header must be on the trusted list, which defeats DNS rebinding, and MCP refuses any request carrying a foreign Origin, which defeats cross-site requests from a page in the owner's browser. Both attacks have tests.

### Fixed: the console did not start from the app's launcher

The launch config ran `bash -c` from a working directory it could not read, and relied on `$PWD` and an nvm-installed pnpm that a non-interactive shell does not have on its PATH. The server never started. It now uses absolute paths and sets PATH. The config stays untracked because it names machine-specific paths.

### Fixed: a relative database path depended on the start directory

`./cairn.sqlite` resolved under `packages/api` when started through `pnpm dev`, and under the repo root when started elsewhere. A relative path now resolves against the config file, or the working directory when there is none.

### Verified: the review console, visually

Checked in the browser pane on the seeded wiki:

1. Recent changes with actor pills and notes.
2. The page view with its tree, breadcrumb and rail of links and tags at desktop width.
3. The collection table.

This closes the visual check that the console entry below left open.

### Added: review console (ADR-009)

A server-rendered console in the same Hono app. It has these screens:

1. Recent changes, filterable to agents or people.
2. Read-mode pages with a page tree, backlinks, outbound links and the last actor.
3. A Markdown editor with preview.
4. History with a per-version diff and restore.
5. Collections as a sortable table, with row forms built from the schema.
6. Search, and new page.

It is styled with artifactkit, embedded by `pnpm sync:artifactkit` as a generated module. Cairn adds one small stylesheet that uses only artifactkit tokens.

Why: agents write directly (ADR-008), and the owner needs to see and undo what they wrote.

Security choices, because agent-written content is rendered here:

1. Markdown is rendered with raw HTML disabled, and links are limited to http, https, mailto, anchors and page links.
2. A strict Content-Security-Policy applies: no inline script or style, no external images, no framing.
3. Sign-in sets an HttpOnly, SameSite=Strict cookie holding an HMAC of the dev token, never the token itself.
4. Every form post must carry a matching Origin header.
5. Search snippets are escaped before match markers become `<mark>`.

A save that loses a version conflict keeps the owner's text, shows the difference from the version that won, and makes the next save a deliberate overwrite. The other version stays in history.

### Finding: artifactkit's documented paths are stale

The skill's instructions point at `src/` and `examples/templates/`. The files live in `assets/` and `assets/templates/`. The sync script reads `assets/` and accepts `ARTIFACTKIT_DIR` to override.

### Not yet verified: how the console looks

It is covered by 24 contract tests: sign-in, cross-origin refusal, escaping of hostile content, conflicts, restore and collections. It has not been checked visually. No headless Chrome is installed, and the browser pane would not load the rendered snapshots. That check is still owed (artifactkit gate G4).

### Added: revisions for pages and rows (ADR-008)

Every write of a page or row now stores an immutable full snapshot with the actor, time and an optional change note, linked into a chain by the version it replaced. Pages and rows carry `updatedBy`. Restore writes an old snapshot as a new revision. Deletion records a final revision, so history survives it.

MCP gains `get_history` and `get_revision` (with a +/- diff), and `create_page`, `update_page` and `upsert_row` accept `change_note`. MCP writes are attributed to an agent actor labelled with the client's user agent. Command-line writes are attributed to the owner via the named tool (import, seed).

Why: agents write directly (ADR-008), so every write must be visible and reversible.

Design details worth keeping:

1. The service chooses version tokens, so a record and its revision share one. The port's write methods now take a `WriteMeta`.
2. Revision first, then the record. A version conflict deletes the new revision. A crash between the two leaves a revision off the chain, which history never shows because it is read by walking the chain from the current version.
3. `pnpm rebuild` sweeps revisions off the chain, but only those older than an hour. A younger one may belong to a write still in flight, and deleting it would break that write's chain.
4. Row revisions are filed under `<collectionId>/<rowId>`, because row ids are only unique within a collection. Found by a test that reused a row id across two collections.

### Changed: existing SQLite databases migrate in place

`init` adds the `updated_by` column to tables created before revisions existed, with a default actor labelled "Before history was recorded". History for those records starts at their next write.

Why: the owner's local database already held the seeded wiki. Throwing it away to change a schema would teach the wrong habit.

### Finding: MCP client identity is not available on tool calls

In stateless mode the client sends its name only at initialize, and every tool call is a fresh request. The user agent header is the only per-call signal until OAuth client registrations exist (ADR-007).

### Direction: track every decision, keep the docs aligned

Every change now records what and why in this file, and the PRD, roadmap, architecture blueprint and ADR index move with the code in the same commit. See CLAUDE.md, "Documentation discipline".

Why: the project is being designed in conversation, and conversations are lost. Without a written trail, the reasons behind a decision disappear and the decision gets relitigated or silently reversed.

### Decision: every write is a revision, agents write directly (ADR-008)

Pages and rows get full-snapshot history with actor attribution and change notes. Agent writes apply at once, with no approval step.

Why: approval would put the owner on the critical path of every agent action and work against the four-days-a-week usage goal. History with one-click restore gives most of the safety with none of the waiting.

### Decision: a review console in Phase 1, styled with artifactkit (ADR-009)

A small server-rendered console for reviewing, navigating, editing and restoring. The rich editor stays gated to Phase 2.

Why: MCP-first means Claude writes unsupervised. The owner needs to see and undo what it wrote, or trust never forms. That is part of Phase 1, not the editor. artifactkit is the owner's existing visual language, and reusing it avoids designing a second one.

### Added: peptide wiki seed example

`examples/peptide-wiki` seeds a local Cairn from the wiki's source JSON: 7 category pages, 26 peptide pages, related peptides as links, and a Peptides collection.

Why: search quality only means something on real content, and this is the owner's real content. It reads the JSON rather than the generated HTML because the HTML pages are mostly filled in by JavaScript and carry little static text.

Probe results on it: "tendon healing", "GLP-1 weight loss" and the alias "Bepecin" all find the right pages first. Backlinks and collection queries return the expected sets.

## 2026-09-11

### Added: local PoC

`packages/api`: Hono app, MCP server over stateless streamable HTTP, dev-mode bearer auth on loopback only, and the `import`, `rebuild` and `eval` commands. Ten MCP tools, with contract tests.

Why: the kill criterion (PRD section 10) can only be tested by using Cairn from Claude. A local build gets there without OAuth, a cloud account or a tunnel.

### Added: `create_collection` MCP tool

Not in the original PRD tool list.

Why: the PRD assumed collections are created in the web editor, which is Phase 2. Without this tool, collections could not be used at all during the MCP-only phase.

### Finding: a stateless MCP transport cannot be reused (ADR-006, spike S2)

The SDK's web-standard transport answers S2: `@hono/mcp` is not needed. But in stateless mode a transport throws on its second request, so the server is built per request.

Why it matters: this suits serverless, where instances share no memory, and it means the API holds no per-connection state at all.

### Decision: Claude Code first, content from a real folder

The PoC targets the Claude Code CLI, which accepts plain http on localhost with a bearer token. Claude Desktop needs https and OAuth, so it waits for ADR-007.

### Added: Phase 0 foundations

`packages/core` with both adapter ports, the filter grammar, row validation, link extraction, chunking, services and three conformance suites. `packages/adapter-sqlite` on Node's built-in `node:sqlite`, with FTS5 for search.

Why `node:sqlite`: FTS5 with bm25 and snippets ships in Node's bundled SQLite, so the reference adapter needs no native dependency and no build step.

### Decision: the adapter boundary (ADR-005)

Search is its own adapter. Derived data is rebuildable. No transactions across documents. Consistency is stated per operation. Collection filtering runs in core, with optional pushdown.

Why: pairing search with the document store per cloud made AWS impossible, because DynamoDB has no full-text search. The other rules each close a gap where SQLite behaviour would pass locally and fail on Cosmos or DynamoDB.

### Decision: Hono with a stateless MCP transport (ADR-006)

Why: stateless is the only mode that fits Lambda and Azure Functions, which recycle instances and share no memory.

### Decision: one small OAuth server in front of any OIDC provider (ADR-007)

Why: per-cloud identity services would mean three auth code paths in the part of the system most likely to stall the project.

### Changed: vitest 5 and vite 8

Why: vite 5 cannot resolve `node:sqlite`, and vitest 5 needs vite 6 or later.

## 2026-09-10

### Design: PRD v0.1 and ADR-001 to ADR-004

Initial design. MCP is the product, the web editor comes second, the graph is edge documents, embeddings are bring-your-own, chunks live in their own store.
