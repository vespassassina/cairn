# Changelog

What changed, and why. Newest first. One entry per meaningful change: code, design direction or decision. The why matters more than the what: the code already records the what.

Entries link to the ADR when there is one. A change of direction that has no ADR yet still gets an entry here.

## 2026-09-13

### Added: search by meaning, with sqlite-vec and a small English model in the container (ADR-022)

Search now matches meaning as well as keywords, for English text. "Something to help me fall asleep" finds DSIP, whose page only says "sleep"; "anything for wrinkles" finds Matrixyl.

1. **Vectors in SQLite** through the sqlite-vec extension, in tables created only when embeddings are on.
2. **bge-small-en-v1.5** (34 MB, English only) runs in the server process through transformers.js, behind a new `Embedder` port and the `adapter-embeddings-local` package. On by default; `CAIRN_EMBEDDINGS=off` turns it off.
3. **Background embedding.** Writes never wait for the model. Chunks are embedded after each write, and caught up by a hash comparison when the model loads, so nothing is embedded twice.
4. **Hybrid search** fuses the keyword ranking with the nearest vectors (reciprocal rank fusion). A vector match counts only when it stands at least 0.065 above the similarity of its neighbourhood, which, unlike a fixed threshold, separates conversational questions with an answer from on-topic questions without one.
5. **Degrades to keyword search** when the extension or model cannot load or fails, and `/health` reports `semantic_search` with the reason.
6. **The image ships the model and the native packages** for its own platform only (about 110 MB more), and never downloads at runtime. CI now checks that semantic search reaches `ready`, runs a hybrid search, and logs the container's memory.
7. **Azure:** a template parameter and `CAIRN_EMBEDDINGS` in `deploy.sh`. The container size stays at 0.25 vCPU and 0.5 GiB.

Measured, SQLite FTS5 plus sqlite-vec, 96-page wiki, 18 queries with an answer and 9 without: recall@5 0.83 keyword, 1.00 hybrid; no-answer queries returning nothing, 9 of 9 in both. Memory 347 MB with the model loaded and every chunk embedded, after cutting the model's batch to one text per call (it was 1.3 GB at 32).

Also: seven eval queries (h01 to h04 with answers, n07 to n09 without), eight hybrid conformance tests with a fake synonym embedder, SQLite tests for restarts and model changes, a real-model test behind `CAIRN_TEST_MODEL=1`, and the search wording in the tool description, instructions, skill and CLI help. MCP context stays at about 2,725 tokens.

Why: the owner asked for vector search in SQLite with an in-container model. Keyword search could not bridge different words for the same thing.

### Changed: commits go straight to main

No branches or pull requests from now on (owner direction). `CLAUDE.md` has a Workflow section.

## 2026-09-12

### Fixed: search returned pages for questions Cairn has no answer to (ADR-021)

Search matched any one word of a query, so every question returned something. Now a page must hold most of the query's words, filler words in English, Italian and Dutch are ignored, words are stemmed ("peptides" finds "peptide"), and each matching page's best chunk comes before a second chunk of any page. The rules live in core and in the search conformance suite, for every backend.

Before and after, SQLite FTS5, keyword mode, 96-page peptide wiki: recall@5 1.00 and 1.00 on 14 queries; no-answer queries returning nothing, 0 of 6 and 6 of 6.

Also:

1. The eval scores questions with no answer (`expected: none`), with six new queries n01 to n06.
2. An existing search index is recreated with the stemmer at the first start and rebuilt from the pages (`needsRebuild` on the port). 96 pages took 61 ms.
3. The search tool description, the server instructions, the skill and `cairn --help` say a page must hold most of the words, and to use two or three distinctive ones. MCP context went from about 2,716 to 2,726 tokens; the README's "about 2,700" stands.
4. 18 new tests: the term rules, five conformance tests for the match rule, stemming and the index upgrade in SQLite, the upgrade at startup, and no-answer scoring.

### Decision: one container everywhere, and your own server as a target (ADR-020)

Cairn runs as one container on every target, with nothing beside it. Azure Functions and AWS Lambda are dropped as targets and spike S1 is closed without running. Cosmos DB and DynamoDB become optional storage adapters for the same container, built only if someone needs more than one instance, the cold restore gets too slow, or the write-loss window matters. SQLite with FTS5 stays the store everywhere, kept either on a mounted local volume or by a Litestream replica, or both.

Why: the owner asked whether Functions and Cosmos would serve Azure better. Functions adds little over Container Apps for Cairn and costs portability; Cosmos adds durability and scale-out that one person does not need yet, and costs search quality (no Dutch, multi-language in preview) and test coverage. The owner chose containers, "as compact as possible, not a fleet", and asked for local mounted storage to run on Proxmox.

Added:

1. `deploy/docker/compose.yaml` and `env.example`: one service, the database in a local folder, the port on 127.0.0.1 unless `CAIRN_BIND` says otherwise, secrets in a git-ignored `.env`.
2. `docs/DEPLOY-DOCKER.md`: own server, HTTPS through a proxy or tunnel, Proxmox VM and LXC notes including the unprivileged uid mapping, backups.
3. `docker/start.sh` now says whether the database is on a mounted volume, and stops with the `chown` to run when `/data` is not writable, instead of failing later inside SQLite.
4. CI starts the image with a mounted folder, checks the database file appears there, checks a read-only folder is refused with that message, and validates the compose file.
5. `docs/AGENT-INSTALL.md` offers the own-server path, keeping `deploy/docker/.env` out of the agent's reach like the Azure settings file.
6. The server's OAuth configuration errors point to both deploy guides.

Also fixed: `docs/LOCAL.md` still listed OAuth and export as not built.

Not yet checked: a run on Proxmox. CI covers the image and the compose file.

### Decision: installation is written for agents first (ADR-019)

`docs/AGENT-INSTALL.md` is a script for a coding agent: ask where Cairn should run, check prerequisites, run and check each step, hand over. Credentials stay with the person: they sign in to Azure and create the OAuth app themselves, and paste the client secret into the deploy script's private settings file, which the agent is told never to read. `AGENTS.md` and the top of CLAUDE.md point agents at it, and the README leads with "clone it and ask your agent".

Why: the owner expects most people to install Cairn this way.

### Decision: Azure runs Cairn as one container with Litestream (ADR-018)

Container Apps on the consumption plan, scaled to zero, one replica at most. The database stays on the container's disk and Litestream streams it to Blob Storage, restoring on start, through the app's managed identity, so no storage key exists anywhere. No Log Analytics. `deploy/azure/main.bicep` and `deploy.sh` do it in two passes, because the OAuth app needs the address the first pass reveals. `docs/DEPLOY-AZURE.md` is the guide.

Why: the owner asked for Azure deployment now. The PRD's Functions and Cosmos path needs an adapter and a spike that are not done; the container path works today inside the free grants and leaves that path open.

Checked: CI compiles the template, lints the scripts, and builds and starts the image. Not yet checked: a real deployment.

### Added: the server image and a bundled server

`pnpm build:server` bundles the server with esbuild into one 2 MB file that runs with nothing but Node; checked from a folder with no config and no `node_modules`. The `Dockerfile` adds Node and Litestream v0.5.7, pinned by checksum. CI publishes it to `ghcr.io/vespassassina/cairn` for amd64 and arm64: `edge` from `main`, versions and `latest` from tags.

### Decision: the OAuth server as built (ADR-017)

A small OAuth 2.1 server: discovery (RFC 8414, RFC 9728), dynamic client registration, authorization code with PKCE, a consent page, single-use rotating refresh tokens with reuse detection, revocation. Sign-in through GitHub or any OpenID Connect provider, against an allowlist. Access tokens are HS256 JWTs checked locally. Auth records live in a new `AuthStore` port with a conformance suite, apart from content. The console signs people in through the same provider and attributes their writes to them. `cairn login`, `whoami` and `logout` sign the CLI in through the browser.

It amends ADR-007 in five places, each with its reason in ADR-017. The largest: a consent page, because dynamic registration plus a provider that approves silently would otherwise let another site obtain a token for the owner's Cairn.

Public mode: a non-loopback bind now starts, but only with OAuth fully configured, and it forces local trust off, because there the Host header is attacker-controlled. A partial OAuth setup is a startup error that names every missing setting. Secrets come only from the environment.

Checked: 18 end-to-end tests of the flow and its attacks with a stand-in provider, 5 of `cairn login` through a real loopback listener, 6 of the configuration rules, and a live run of the real entry point with GitHub settings showing the metadata, the sign-in button and the redirect to GitHub. Not yet checked: a sign-in against real GitHub, and a claude.ai connector.

### Fixed: console form checks and cookies behind a TLS proxy

Behind Azure's ingress the server sees plain HTTP, so comparing a form's Origin with the request's own URL would have refused every console form in the cloud. With a public URL configured, the check and the cookies' Secure flag use it instead. Found while reading the code for OAuth, before it failed anywhere.

### Decision: export is Markdown and JSON that imports back without loss (ADR-016)

`cairn export <folder>` writes pages as Markdown with a small front matter, in folders that mirror the page tree, collections as JSON, and a manifest; `--root` exports one page and everything under it. `cairn import` reads it back keeping every id, compares before writing, and changes nothing on a second run; `--dry-run` shows the plan. REST gained `GET /api/v1/export/pages` and `PUT` for pages and collections at a given id.

Why: the owner asked for data owned by its users and reprocessable, whole or by root. Checked on the peptide wiki: exported, imported into an empty database, exported again, and the two exports were identical.

### Changed: the peptide wiki seed follows the updated wiki

The wiki grew to 79 peptides, 8 categories, and a new stacks file, with citations and mixing notes per peptide. The seed now writes a Stacks page with a page per stack, links stack components and mixing notes, lists citations, and fills a second collection, Stacks. Reseeded in place: 63 pages created, 33 updated, 96 in all, every change a revision.

### Added: fourteen eval queries, and a first recall number

q03 to q16, written from the wiki and each checked against its text: brand names, aliases, nicknames, descriptions and sentence-shaped questions. recall@5 is 1.00 on all fourteen, eleven at rank 1. Caveat: they were written by the agent that knows the content, so they are easier than real searches; q17 to q30 are left for the owner. The eval also shows the known weakness: q01 and q02, about content Cairn does not hold, return four or five unrelated pages instead of nothing.

### Fixed: heading paths nested sibling sections

A page starting at level 2 recorded "Status > Origin" for two sibling sections, because the chunker cut the path by heading depth. It now keeps a stack of open headings. Every search result showed the wrong path; found on the reseeded wiki.

### Fixed: `pnpm import` and `pnpm rebuild` ran pnpm's own commands

Both names are pnpm built-ins, which win over package scripts, so the documented commands never ran Cairn's. They are now `pnpm import:markdown` and `pnpm reindex`. The docs were wrong since the PoC.

### Fixed: `pnpm eval` and `import:markdown` looked for paths in the wrong folder

pnpm runs package scripts from the package folder, so `eval/queries.yaml` and relative folders were looked for under `packages/api`. The eval file now resolves next to `cairn.config.json`, and paths you type resolve against the folder you typed them in.

### Finding: the first CI run, on every OS

The test suite passed on Linux x64, Linux Arm, macOS and Windows on the first run, with no Windows-specific failures. Every CLI executable passed its smoke test on its own OS. The one failure was the smoke script deleting its temporary folder before the server had exited, which Windows does not allow; the script now waits and retries. `docs/CLI.md` now says what has been tested where.

### Decision: free for non-commercial use, under PolyForm Noncommercial 1.0.0 (ADR-015), and the repository is public

Cairn is published at https://github.com/vespassassina/cairn. `LICENSE` holds the PolyForm Noncommercial 1.0.0 text with a `Required Notice` line, and every package declares `PolyForm-Noncommercial-1.0.0` with a link to the repository.

Why: the owner wants anyone to be able to use, change and share Cairn, but not for profit. PolyForm Noncommercial is the standard licence written for exactly that, for software. It makes Cairn source-available rather than open source, so the README, PRD and CLAUDE.md no longer call it open source, and PRD risk R6 covers how that reads on Hacker News.

AGPL-3.0 was chosen first, then replaced before anything was pushed, because AGPL allows commercial use. The AGPL text was never published: a licence grant cannot be withdrawn, so the unpushed commit that held it was changed rather than followed by a new one. PRD Q4 is answered.

Before the first push, commit authorship moved from a personal address to the GitHub no-reply address, so no private inbox is in the public history. The README's status line, which still said "design", now says what runs today: that doc was wrong.

### Decision: the CLI ships as an npm package and as standalone executables (ADR-014)

`pnpm build:cli` builds `cairn` for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64` and `windows-x64`, into `dist/cli/` with a `SHA256SUMS` file. Each executable carries its own runtime, so it needs nothing installed. Node users can still install it with npm.

Why: the owner asked for the CLI to build for Windows, macOS and Linux, with clear docs. Bun compiles for every platform from one machine, where Node's single executable applications need each platform's own Node binary. Bun is a build tool only; the server and tests stay on Node, and its version is pinned.

Checked: all five build from one Mac and are the right executable format. Both macOS builds pass `pnpm smoke:cli`, which runs the executable against a real server: create, read, append, search, changes and a version conflict. The Intel build ran under Rosetta. The build also works without Bun installed, fetching the pinned version. Linux and Windows executables have not been run yet; CI runs them on each OS once the repository is on GitHub.

### Added: CI for Linux, macOS and Windows

`.github/workflows/ci.yml` runs the tests on Linux x64 and arm64, macOS and Windows, then builds the CLI on each runner and smoke-tests it. A version tag builds all five executables and attaches them to a GitHub release. `.gitattributes` checks text out with LF on every OS, so tests that compare text behave the same on Windows.

### Added: `docs/CLI.md`, installing the CLI on each OS

Which file to download for which machine, how to check it against `SHA256SUMS`, where to put it and how to add it to the PATH on macOS, Linux and Windows, how to get past the unsigned-executable warnings, environment variables in each shell, installing the skill, and uninstalling. It ends with a table of what has been tested where.

### Changed: the CLI turns Windows line endings into plain newlines, and prints its version

Text piped in or read with `--file` on Windows arrives with a carriage return on every line; the CLI now stores plain newlines. `cairn -V` and `cairn version` print the version (`--version` was already the page version for edits).

### Fixed: a raw NUL byte in `pages.ts` made git treat it as binary

`PageService` compared tag lists by joining them with a NUL character, written into the source as a raw byte. The code worked, but git treated the file as binary, so diffs and grep skipped it. It now compares the lists as JSON. A scan of every file in the repository finds no other control bytes. See `docs/LESSONS.md`.

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
