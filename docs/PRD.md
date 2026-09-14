# Cairn: PRD v0.1

Working name. A cairn is a stack of stones that marks a trail. Rename freely.

Status: draft
Owner: Diego
Last updated: 11 September 2026

## tl;dr

**A wiki and tables your agents can write to, with every change reviewable.**

A source-available, self-hosted wiki and table store where agents are the primary client, free for any non-commercial use (ADR-015). They get in through MCP, a REST API or a command-line tool (ADR-013). The web editor comes second.

It runs as one small container: on your own server, or within the free grants of a cloud (Azure today, AWS later). SQLite holds the data; Cosmos DB or DynamoDB can take over by configuration if one instance is ever not enough (ADR-020).

Search is keyword (BM25) plus meaning, merged, with an explicit link graph and Claude doing the multi-hop reasoning. The meaning part uses a small English model inside the container, so it works only for English text (ADR-022).

Kill criterion: if I'm not reaching for it from Claude at least 4 days a week after two weeks of MCP-only use, stop before building the UI.

## 1. Problem

I want structured, queryable state that Claude can read and write across chats: parts inventories, print logs, project specs, tracked metrics. Today that state is scattered across OneDrive, Dropbox, Google Drive and Claude project files. None of it is queryable. Claude can't update any of it reliably.

Notion solves this with a connector, but it's closed, SaaS-only, and its AI features cost €20+ per seat for capabilities I already get from Claude.

The open-source alternatives (Docmost, Outline, AppFlowy, AFFiNE) need Postgres plus Redis, don't run on serverless free tiers and treat AI access as an afterthought.

### Landscape, September 2026

Agent memory is a crowded field, and Hacker News is tired of it. The recurring comment is that most memory tools are "about the same as grep in a memory/ directory", and the typical commenter keeps a MEMORY.md and a SQLite file of their own. Where Cairn sits:

1. **Memory layers** (Mem0 and OpenMemory, Letta, Zep and Graphiti, Cognee) extract facts from conversations into fragments or graphs, built for retrieval by software rather than reading by a person. Cairn stores documents a person reads and edits.
2. **Basic Memory** is closest in spirit: Markdown on disk, wiki links, MCP, AGPL, about 3,900 GitHub stars. It has no typed tables, edit history only in its paid cloud, and a local install cannot be reached by claude.ai or another machine.
3. **Remnus** is closest in data model: pages plus databases with JSON schemas, 14 MCP tools, SQLite, OAuth 2.1, AGPL. A one-person project, and proof the niche exists.
4. **Obsidian with the vault in a git repository** is what many of the same people already use. It wins on its editor, plugins, graph view, price, and plain files with git history. It has no way for an agent on claude.ai or a phone to reach it, nothing that stops one agent overwriting another's edit, and no typed tables, sources or freshness. The roadmap section "Against a notes app kept in git" lists the features that would close its lead, starting with a bridge to and from a vault.

What no one combines: typed tables next to the wiki, a revision for every write by every actor, a review screen that shows agent writes first, and one codebase that runs as a SQLite file or on a cloud free tier. That combination is the pitch. "Memory for agents" is not.

## 2. Goals

1. Claude can find, read, create and update pages and table rows through MCP with no manual copy and paste.
2. Sustained running cost of €0 to €2 per month for a single user with up to 5,000 pages on either Azure or AWS free tier.
3. Keyword-only search (no embeddings) hits recall@5 of 0.8 or better on my 30-query eval set when driven by Claude.
4. The same container image runs on your own server, on Azure and on AWS, switching only configuration (ADR-020).
5. A new user goes from clone to a working Claude connector in under 30 minutes by following the README.

## 3. Non-goals

1. **A Notion clone.** No board, calendar or timeline views, no formulas, no rollups in v1. They are months of work and not what makes this useful.
2. **Real-time collaborative editing.** Single editor at a time. Designed so Yjs can be added later (see P2).
3. **Large or hosted embedding models.** A small English model ships in the container (ADR-022, which reversed this non-goal); anything bigger is not a goal.
4. **GraphRAG entity extraction.** Expensive to index and noisy on small corpora. Revisit above 50,000 chunks or with multi-user teams.
5. **Mobile apps.** The web UI should work on mobile browsers. Native apps are out of scope.
6. **Corporate use.** Personal project. Not for customer or employer data.

## 4. Users

**Primary: Claude (the agent).** Calls MCP tools from claude.ai, Claude Desktop, Claude Code or Cowork. Needs predictable tool contracts, useful error messages and compact results that fit in context.

**Secondary: the owner (technical individual).** Writes and browses in the web editor. Deploys and maintains the instance. Comfortable with Azure or AWS portals and a CLI.

**Tertiary: small team (2 to 10 people).** Shares a workspace. Needs auth and basic permissions, not real-time co-editing.

**Later: readers on the web.** Cairn is a knowledge manager, and it can also be a free knowledge source: the owner publishes a collection, such as the peptide wiki, for anyone to read and for search engines to index. Either Cairn serves it read-only with no sign-in, or an export as a static site is put on GitHub Pages, a blob storage or S3 static website, Google Cloud Storage or Dropbox, with no server at all. The read-only surface is built (ADR-032): the owner publishes a page, and it and everything under it are served at `/w` with no sign-in. The static site export is not; see that roadmap item (owner's direction of 2026-09-14).

## 5. User stories

### Claude as client

1. As Claude, I want to search by keyword and get page titles, heading paths and snippets so that I can decide what to open without loading whole pages.
2. As Claude, I want to know when search ran in keyword-only mode so that I try synonyms and related terms before concluding nothing exists.
3. As Claude, I want to read a page and its backlinks so that I can follow related context the user never mentioned.
4. As Claude, I want to append a row to a table with validation errors I can act on so that I can fix a bad field without asking the user.
5. As Claude, I want to update a single block of a page so that I don't overwrite the user's edits elsewhere on it.

### Owner

1. As the owner, I want to deploy to my Azure free tier with one command so that I can try it without a budget conversation with myself.
2. As the owner, I want semantic search without an external service or key, and to be able to turn it off. (Was: point the app at an embeddings endpoint. Changed by ADR-022.)
3. As the owner, I want to see which search mode each result came from so that I can judge whether embeddings help.
4. As the owner, I want to export my whole workspace to Markdown and JSON so that I'm never locked into my own software.

### Edge cases

1. As Claude, when the embedding model is not loaded or fails, I get keyword results with a `mode: "keyword"` flag, not an error.
2. As the owner, when I change embedding model, search keeps working: keyword search in full, and hybrid search over the chunks embedded so far (ADR-022).
3. As Claude, when I update a page someone else changed since I read it, I get a version conflict with the current content so that I can merge and retry.

## 6. Product principles

1. **MCP first.** Every capability exists as a tool before it exists as a button.
2. **Portable by interface.** Storage, blobs, queues, secrets and embeddings sit behind adapters. No cloud SDK outside an adapter.
3. **Degrade, don't fail.** Optional services (embeddings, home lab) never break the core path.
4. **Explicit over inferred.** Graph edges come from links, mentions and relations the user wrote. No LLM guessing in v1.
5. **Your data leaves easily.** Export is a P0, not an afterthought.
6. **Bridges, not islands.** A fact keeps its citation and a link to the original wherever it goes: through export, import, sync, a public page or a static site. A page that comes from another Cairn points back to it. This is what lets separate Cairns form a web of knowledge instead of a set of islands (owner's direction of 2026-09-14). Sources on every write (ADR-027) are the start; checking them and linking across Cairns are on the roadmap under "Bridges between Cairns".
7. **The code guides you, whether you are a person or an agent.** Sensible defaults, so most things work without a setting, and errors that say what happened and exactly what to do next, including when a default was used that you did not choose (owner's direction of 2026-09-14, ADR-031).

## 7. Architecture

### Runtime

1. **API and MCP server:** TypeScript with Hono, on Node, in one container (ADR-020). Azure Functions and AWS Lambda were targets until ADR-020 dropped them.
2. **Frontend:** React with BlockNote (ProseMirror based). Hosted on Azure Static Web Apps free plan or S3 plus CloudFront.
3. **Indexer:** extracts links, mentions and tags and writes chunks. Runs inline on write in P0, because it is cheap and removes a moving part. Embeddings are slower, so they are computed in the background in the same process, never on the write path (ADR-022). A full rebuild command regenerates all derived data from pages (ADR-005).

The MCP server runs in stateless streamable HTTP mode, which suits a container that scales to zero. See ADR-006.

**Deployment (ADR-018, ADR-020):** one container per deployment, nothing beside it. On your own server the SQLite file lives on a mounted local volume (`docs/DEPLOY-DOCKER.md`). On Azure the container runs on Container Apps, consumption plan, scaled to zero, with SQLite kept in Blob Storage by Litestream. Cosmos DB and DynamoDB are optional adapters for the same container, built when more than one instance is needed, the cold restore is too slow, or the write-loss window matters.

### Storage adapters

Search is a separate adapter from the document store, so a deployment pairs them freely. See ADR-005 for the reasoning and the full rules. Since ADR-020 the default everywhere is the self-hosted column, SQLite with FTS5; the Azure and AWS columns are the optional adapters, not the plan.

| Concern | Azure | AWS | Self-hosted |
|---|---|---|---|
| Documents | Cosmos DB NoSQL (free tier: 1,000 RU/s, 25 GB) | DynamoDB (25 GB always free) | SQLite or Postgres |
| Full-text search | Cosmos full-text index (BM25) | Serialized BM25 index in S3, built by the indexer | SQLite FTS5 or Postgres tsvector |
| Vectors (optional) | Cosmos vector index (quantizedFlat, DiskANN later) | Same S3 artefact, with vectors | sqlite-vec or pgvector |
| Blobs | Blob Storage | S3 | Local disk or S3-compatible (MinIO) |
| Queue (P1, embeddings only) | Storage Queue | SQS | In-process |
| Secrets | Key Vault | Secrets Manager | Environment variables |

Five rules govern the boundary (ADR-005).

1. Search is its own adapter, independent of the document store.
2. Pages and rows are the source of truth. Edges and chunks are derived and rebuildable, written with an idempotent replace scoped to one source.
3. No transactions across documents. Write the page first, then its derived data.
4. Consistency is stated per operation. Point reads are immediate, derived reads are eventual within 10 seconds.
5. Table filtering runs in core, in memory. Adapters may declare a pushdown capability that must produce identical results.

### Data model

One logical store with three document families, partitioned by workspace.

1. **Pages.** Title, parent, tags, BlockNote JSON blocks embedded in the document, sources, version token. One point read per page. Sources are where the page's facts came from: URLs or short citations, added to by each write (ADR-027). Rows carry them too. `verified_at` is when the page's facts were last confirmed, null for never, set by a write that says it re-checked them (ADR-028).
2. **Tables.** A schema document plus one document per row. Field types in v1: text, number, date, select, multi-select, checkbox, URL, relation. A relation links to pages, or to the rows of a table, its own included, and can hold a list (ADR-024). A table sits under a page in the tree, or at the top. Until ADR-026 tables were called collections; a collection is now a top-level page and everything under it, one wiki, a view of the tree rather than a stored family.
3. **Edges.** One document per link, partitioned by source page. A mirrored reverse edge partitioned by target so backlinks are a single-partition query. Edge types: link, mention, relation, parent, tag.

**Chunks** live in a separate container from day one, even with embeddings off. Chunk at block and heading level. Each chunk stores page id, heading path, text, and when embeddings are enabled: vector, model name, model version and dimensions.

### Search pipeline

1. **Keyword mode (default).** BM25 over chunks. Results grouped by page with heading path and snippet.
2. **Hybrid mode (default when the model is loaded).** The keyword ranking and the nearest vectors fused with reciprocal rank fusion; a vector match counts only when it stands out from its neighbours (ADR-022).
3. **Graph expansion.** Optional one-hop expansion over edges from the top results, then rerank. Used by the web UI. Claude gets the raw tools and traverses itself.
4. **Fallback.** Model not loaded, or failing, means keyword mode, flagged in the response.

### Embeddings (a small model inside the container, ADR-022)

The design until 2026-09-13 was a bring-your-own OpenAI-compatible endpoint (ADR-003). ADR-022 replaced it as the default:

1. **bge-small-en-v1.5**, 34 MB, 384 dimensions, run by transformers.js and ONNX Runtime in the server process. **English only**: text in other languages gets keyword search.
2. Vectors in SQLite through **sqlite-vec**, in tables created only when embeddings are on.
3. Chunks are embedded in the background after each write and caught up when the model loads; no text leaves the machine.
4. Changing model drops the old vectors and embeds everything again.
5. `CAIRN_EMBEDDINGS=off` turns it off. A bring-your-own endpoint could come back behind the same `Embedder` port.

### Auth

Cairn contains one small OAuth 2.1 authorization server that delegates login to any OIDC provider (GitHub, Entra ID, Google). The same code runs on every target. See ADR-007.

1. MCP: OAuth 2.1, authorization code with PKCE, dynamic client registration, rotating refresh tokens, JWT access tokens verified locally. This is the highest-risk piece (see R1).
2. Web UI: the same server, same session.
3. Identity: whatever the provider asserts, keyed by issuer plus subject, against an allowlist. No user database, no passwords, no roles in v1.
4. Dev mode: loopback only. Requests addressed to a trusted local host name need no token; a static bearer token covers anything else (ADR-010).
5. Public mode: any other bind address requires OAuth, and forces local trust off (ADR-017).
6. As built (ADR-017): a consent page names each client before it gets a token; GitHub is supported as plain OAuth, any other provider through OpenID Connect; tokens are HS256, checked locally; auth records live in their own store, never in content or exports.

## 8. MCP tools (v1)

| Tool | Purpose |
|---|---|
| `search` | Keyword or hybrid search. Returns page id, title, heading path, snippet, score, mode. Description tells Claude to retry with synonyms when results are thin. |
| `get_page` | Full page as Markdown plus metadata and version token. Optional `include_backlinks`. |
| `create_page` | Title, parent, tags, Markdown body. |
| `update_page` | Replace a block, append blocks or replace the whole body. Requires version token. |
| `get_backlinks` | Pages linking to a page, with edge type. |
| `get_neighbours` | Outbound and inbound edges for a page, one hop. |
| `list_tables` | Tables with their schemas. |
| `query_table` | Filter and sort rows. Simple filter grammar, not SQL. |
| `upsert_row` | Create or update a row. Returns field-level validation errors. |
| `create_table` | Create a table with a typed schema. Added during the PoC: this list assumed tables were created in the web editor, which is Phase 2, so without it tables cannot be used at all. |
| `get_history` | Revisions of a page or row, newest first, with actor, time and change note (ADR-008). |
| `get_revision` | One revision's content, and its diff against the version it replaced. |

Write tools (`create_page`, `update_page`, `upsert_row`) accept an optional `change_note` so an agent can say why it made a change. It is shown in the review console's recent changes. They also accept `sources`, URLs or short citations for where the facts came from, added to the page's or row's list and shown beside it in the console (ADR-027). `update_page` takes `verified: true` when the agent re-checked the page's facts and they still hold; `get_page` and search hits return `verified_at` (ADR-028).

Server instructions: at initialize, Cairn also tells the client when to use it: search before answering, save durable knowledge without being asked, prefer updating an existing page, and give every write a change note (ADR-011). Tools alone are available but never required, so without this Claude uses Cairn only when asked. The instructions end with a live summary of what the workspace holds: tables with row counts, top-level pages with their size, and common tags, so Claude knows which questions Cairn can answer (ADR-012).

The same capabilities are on a REST API at `/api/v1` and a `cairn` command-line tool with a skill file, for agents that have a shell and would rather not pay for tool schemas in every session (ADR-013). A changes feed, `GET /api/v1/changes?since=`, lets an agent or script ask what changed since it last looked.

Result size: every tool truncates at a configurable token budget and says so, with a cursor for the next page.

## 9. Requirements

### P0: must have

**P0.1 Pages CRUD with optimistic concurrency.**
Given a page at version A, when Claude calls `update_page` with version A, then the update applies and returns version B.
Given the page is now at version B, when a second update arrives with version A, then it's rejected with the current content and version B.

**P0.2 Keyword search over chunks.**
Given 1,000 pages indexed, when Claude searches a term present in one heading, then that page is in the top 3 and the snippet shows the matching text.
Search p95 latency under 800 ms on Cosmos free tier, measured warm. Cold-start latency is measured and reported separately (ADR-006).

**P0.3 Link and backlink graph.**
Given page A links to page B, when page A is saved, then `get_backlinks(B)` returns A within 10 seconds.
Given the link is removed and A is saved, then the backlink disappears.

**P0.4 Tables with typed rows.**
Given a table with a required date field, when `upsert_row` omits it, then the call fails with an error naming the field.

**P0.5 MCP server usable from claude.ai as a custom connector.**
Given a deployed instance, when the owner adds the connector URL in Claude, then OAuth completes and all tools in section 8 are callable.
Status 2026-09-12: the OAuth server is built and tested end to end with a stand-in provider (ADR-017). Proven when a deployed instance is connected from claude.ai.

**P0.6 Storage and search adapter interfaces with Cosmos and SQLite implementations.** (Since ADR-020 the Cosmos implementation is optional and waits for a trigger; the interfaces and the SQLite implementation are done.)
Given the conformance test suite, when run against both adapters, then all tests pass with no adapter-specific branches in business logic.
Given an adapter that declares table-query pushdown, when the suite runs the query set with pushdown on and off, then the results are identical.

**P0.10 Every write is a revision (ADR-008).**
Given a page updated three times, when the owner opens its history, then they see four revisions with actor, time and change note, and can restore any of them.
Given a restore, then it creates a new revision, so the restore itself can be undone.
Given an agent write, then it applies at once with no approval step, and appears in recent changes.

**P0.11 Review console (ADR-009).**
Given agent writes since yesterday, when the owner opens the console, then recent changes lists them with the change notes, filterable to agents only.
Given a page, then it renders in read mode with resolved links and backlinks, and Edit opens a Markdown textarea that saves with a version check.

**P0.9 Rebuild of derived data.**
Given a workspace whose edges and chunks have been deleted, when the owner runs rebuild, then backlinks and search results match what they were before, with no change to any page.

**P0.7 Export.**
Given a workspace, when the owner runs export, then they get a zip with one Markdown file per page (folder tree mirrors hierarchy), one JSON file per table, and all attachments.
Status 2026-09-12: done as a folder rather than a zip, written by `cairn export`, whole or from one root, and read back by `cairn import` without loss (ADR-016). Attachments do not exist yet; history is not exported yet.

**P0.8 Azure free-tier deployment.**
Given a fresh subscription with Cosmos free tier unused, when the owner runs the deploy script, then the instance is live with no resource on a paid SKU except Blob Storage.
Status 2026-09-12: Azure uses Container Apps and Blob Storage instead of Functions and Cosmos (ADR-018, ADR-020), and meets the same test: nothing on a paid SKU but Blob Storage. Template and scripts are checked in CI; a first real deployment is still to be run.

### P1: fast follow

1. **Web editor** with BlockNote, page tree, backlinks panel, table view.
2. **Embeddings** with hybrid search and fallback as described in section 7. Done 2026-09-13 with a model inside the container (ADR-022).
3. **AWS:** the same container on an AWS container service, with a deploy script. DynamoDB and S3 adapters only on an ADR-020 trigger.
4. **Attachments** up to 25 MB per file, stored via the blob adapter.
5. **Local MCP server** packaged as a Claude Desktop extension (`.mcpb`), pointing at the remote API.
6. **Eval runner** that executes `eval/queries.yaml` and reports recall@5 per search mode.

### P2: design for, don't build

1. **Real-time co-editing** with Yjs and a WebSocket relay. Keep blocks addressable by stable ids now.
2. **Postgres adapter with Apache AGE** for deep graph traversal.
3. **Similarity edges** computed from vectors at write time ("related pages").
4. **Client-side embeddings** in the browser via Transformers.js with a pinned model.
5. **Import** from Notion export and Obsidian vaults. The Obsidian half, both ways, is now a roadmap item of its own ("Against a notes app kept in git").
6. **Permissions** beyond workspace membership: per-page sharing, read-only guests.
7. **Publishing:** a collection served read-only to anyone and indexable by search engines, or exported as a static site for any static host. On the roadmap since 2026-09-14.

## 10. Success metrics

### Leading (first 2 to 4 weeks)

1. **Usage:** Claude calls at least one tool on 4 or more days per week during MCP-only phase. Measured from API logs.
2. **Search quality:** recall@5 of 0.8 or better in keyword mode on the eval set. Stretch: 0.9. Reported per search backend, because BM25 scoring differs between Cosmos, FTS5 and a JavaScript index. One number for the project would be meaningless.
3. **Write success:** 95% or more of Claude write calls succeed on first or second attempt.
4. **Latency:** p95 under 800 ms for `search` and `get_page`.

### Lagging (1 to 3 months)

1. **Cost:** monthly bill of €2 or less on Azure with up to 5,000 pages.
2. **Consolidation:** at least two recurring use cases moved off OneDrive, Dropbox or Drive files (parts inventory, print log).
3. **External adoption (only if published):** 3 or more people other than me running an instance.

## 11. Evaluation

`eval/queries.yaml` holds the queries and the pages that answer them. Each was written from the content, and its expected pages chosen, before it was ever run: a query written while watching the results measures nothing.

As of 2026-09-14 it holds 32 queries with expected pages, plus 9 questions the workspace does not answer, where returning nothing is the right result (ADR-021). Measured against the 104-page peptide wiki, on SQLite with FTS5: recall@5 of 0.97 with meaning and keyword together, 0.88 on keyword alone, and 9 of 9 for the questions with no answer in both. That is above the 0.8 target and the 0.9 stretch in section 10.

Two cautions when reading it. The four conversational queries (h01 to h04) were used while choosing the vector margin in ADR-022, so they show what search by meaning adds rather than prove it generalises. And one query is still missed in both modes: "which peptide makes you really hungry" returns the appetite suppressants, because the wiki talks about appetite on 18 pages and nothing in the text marks the direction.

Run after every change to chunking, indexing, weights or embedding model. No search change merges without a before and after number.

## 12. Risks

**R1. OAuth for MCP stalls the project.** Most home-built connectors die here.
Mitigation: time-box to 3 days. Fallback: API Management consumption tier with Entra ID, or a hosted identity provider free tier.

**R2. Cosmos full-text doesn't support Dutch or Italian well.** Keyword search is the default path, so this hurts. Since ADR-020 this applies only if the optional Cosmos adapter is built.
Mitigation: verify language support before P0.2. Fallback: store a stemmed or lowercased shadow field per language.

**R3. Cosmos lock-in creeps past the adapter.** RU-specific query shapes leak into business logic.
Mitigation: SQLite adapter ships in P0 and runs the same conformance suite in CI.

**R4. Free tier rules change.** AWS moved new accounts to a credit model in July 2025.
Mitigation: document the cost of each resource at small scale, not just "free".

**R6. "Source-available" reads as a bait and switch on Hacker News.** Cairn forbids commercial use without a licence (ADR-015), so it is not open source by the OSI definition, and HN readers call out projects that claim otherwise.
Mitigation: never call it open source. Say "source-available, free for non-commercial use" in the README and the post, and say why in one sentence.

**R5. I build the editor first because it's fun.**
Mitigation: phase gate below. No editor code until the MCP-only phase passes its usage check. The review console (ADR-009) is the one exception, allowed because reviewing agent writes is part of the MCP-only phase, and held to scope limits that ADR lists: no rich editor, no board views, no client-side application.

## 13. Open questions

| # | Question | Owner | Blocking? |
|---|---|---|---|
| Q1 | Which Cosmos full-text languages are GA today, and is Dutch or Italian among them? Partly answered 2026-09-12: English, German, French, Italian, Portuguese and Spanish are listed, multi-language is still preview, stopword removal is English only, and Dutch is not listed. | Engineering | Yes, before P0.2 |
| Q2 | ~~Full-text on AWS~~ Answered by ADR-005: serialized BM25 index in S3, built by the indexer at concurrency 1, loaded by query functions with ETag caching. Still to prove at 5,000 pages. | Engineering | No |
| Q3 | ~~OAuth approach for MCP~~ Answered by ADR-007: own small OAuth 2.1 server delegating to any OIDC provider. | Engineering | No |
| Q7 | Does Cosmos free tier support full-text and vector indexes on shared throughput? Does Flex Consumption have a free monthly allowance? How does the AWS credit-based free plan of July 2025 affect the always-free services on a new account? Partly answered 2026-09-12 from Microsoft docs: vector indexing is not supported on shared-throughput accounts, so vectors on the free tier need a dedicated container. Flex Consumption grants 250,000 executions and 100,000 GB-s a month per pay-as-you-go subscription. The AWS question and full-text on shared throughput are still open. | Engineering | Yes, before Phase 1 |
| Q8 | Does the Cosmos emulator support full-text search? If not, search conformance on Cosmos needs a nightly run against a real account. | Engineering | Yes, before P0.2 |
| Q4 | ~~Licence: AGPL or MIT?~~ Answered by ADR-015: PolyForm Noncommercial 1.0.0. Free for non-commercial use; commercial use needs a separate licence. | Owner | No |
| Q5 | Final name. Check GitHub, npm and domain availability. | Owner | No |
| Q6 | Chunk size and overlap for BlockNote content. Settle with the eval set. | Engineering | No |

## 14. Phasing

**Phase 0: foundations (1 week).** Adapter interfaces, SQLite adapter, conformance tests, eval query set written. Plus the two spikes from ADR-006: Hono on Azure Functions (S1) and the MCP transport shape (S2). S2 is done; S1 was closed without running when ADR-020 dropped Functions.

**Phase 1: MCP only (2 to 3 weeks).** Pages, tables, edges, keyword search, MCP server, OAuth, a container deploy on your own server and on Azure. Use it from Claude daily. (The Cosmos adapter was here until ADR-020 made it optional.)

Gate: usage and recall targets from section 10 met for two weeks. If not, stop or rethink.

**Phase 2: editor (3 to 4 weeks).** BlockNote frontend, page tree, backlinks panel, table view, export UI.

**Phase 3: options (open-ended).** A multilingual or bring-your-own embedding model, AWS adapters, Desktop extension, import.

## 15. Decisions log

Record decisions in `docs/decisions/` as short ADRs. Already decided in design discussion:

1. ADR-001: MCP server is the primary interface. Web UI is secondary.
2. ADR-002: Graph is modelled as edge documents in the document store. No Gremlin API.
3. ADR-003: Embeddings are opt-in via a bring-your-own OpenAI-compatible endpoint. No bundled model in the cloud path. Superseded as the default by ADR-022.
4. ADR-004: Chunks live in their own container. Vector container is created at enable time, not deploy time.
5. ADR-005: Adapter boundary. Search is its own adapter, derived data is rebuildable, no cross-document transactions, consistency stated per operation, table filtering in core with optional pushdown.
6. ADR-006: Hono plus stateless MCP transport, written to the lowest common denominator of the platforms.
7. ADR-007: Auth is one small OAuth server in front of any OIDC provider.
8. ADR-008: Every write is a revision, and agents write directly.
9. ADR-009: A server-rendered review console, styled with artifactkit.
10. ADR-010: No sign-in for trusted local requests.
11. ADR-011: Cairn tells clients when to use it, through MCP server instructions.
12. ADR-012: The server instructions carry a live summary of the workspace.
13. ADR-013: One core, three surfaces: MCP, REST and a CLI.
14. ADR-014: The CLI ships as an npm package and as standalone executables for Windows, macOS and Linux.
15. ADR-015: Cairn is source-available under PolyForm Noncommercial 1.0.0.

The full index, with status, is in `docs/decisions/README.md`. What changed and why, in order, is in `docs/CHANGELOG.md`. The owner's instructions are in `docs/DIRECTIONS.md`, and failures and lessons in `docs/LESSONS.md`. Live status is in `docs/ROADMAP.md`.
