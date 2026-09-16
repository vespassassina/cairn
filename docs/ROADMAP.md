# Roadmap

Where Cairn is, what is next, and what gates each step. The PRD (section 14) holds the original phasing. This file holds the live state, and is updated whenever work lands or plans change.

Status key: done, in progress, next, later, blocked.

## Phase 0: foundations

| Item | Status | Notes |
|---|---|---|
| Adapter interfaces (document store, search index) | done | ADR-005 |
| SQLite adapter | done | `node:sqlite`, FTS5 |
| Conformance suites | done | document store, search index, pushdown equivalence |
| Documentation logs | done | Directions, decisions, changelog, lessons. `docs/README.md` maps them |
| Spike S2: MCP transport shape | done | Web-standard transport, one server per request. ADR-006 |
| Spike S1: Hono on Azure Functions | dropped | ADR-020: Functions is no longer a target |
| Eval query set, 30 real queries | done | 2026-09-14: 32 queries with expected pages, plus 9 with no answer (ADR-021). The two placeholders about drones and 3D printing, which nothing answered, were removed. Every query was written from the content and scored before it was run |

## Phase 1: MCP only, used daily

| Item | Status | Notes |
|---|---|---|
| Local PoC: API, MCP server, dev auth | done | Claude Code CLI, loopback only |
| Import, rebuild, eval commands | done | |
| Peptide wiki seed | done | `examples/peptide-wiki` |
| Revisions: history, actor, change notes | done | ADR-008. MCP `get_history`, `get_revision`, `change_note` |
| Restore an old revision, outside the console | done | ADR-045. REST `POST /pages/:id/revisions/:version/restore`, CLI `cairn restore` and `cairn peek` |
| Review console | done | ADR-009. 24 contract tests, checked visually |
| Console: a new page starts under the page being read | done | The owner's direction of 2026-09-14. The header button carries the page you are on, the form says it chose that parent, and a parent that is gone falls back to the top level with a banner |
| No sign-in on localhost | done | ADR-010. `cairn.config.json` |
| MCP server instructions | done | ADR-011. Read first, write back, change notes |
| Live workspace summary in the instructions | done | ADR-012. Tables, collections (top-level pages), tags, within the budget |
| Daily use from Claude Code | blocked | Server added with `--scope user`. Watch agent writes in the console (ADR-011 consequence 4). On 2026-09-16 the registration was found to be gone from the user scope, alongside a stopped server and a deleted sign-in. ADR-053 is what makes this stick |
| Semantic search: sqlite-vec and a model in the container | done | ADR-022. English only. Hybrid recall@5 1.00 against keyword 0.83, no-answer 9 of 9 in both |
| Search precision: OR matching over-matches | done | ADR-021. Most of the words, stemmed, one chunk per page first. No-answer queries 0 of 6 to 6 of 6, recall@5 unchanged at 1.00 |
| Search does not know direction | done | ADR-042. "Which peptide makes you really hungry" was matching on a negated word: the wrong page's only occurrence of "hungry" was "less hungry". Keyword search now discounts a term match that is negated everywhere it appears in a page. Recall@5 unchanged (keyword 0.88, hybrid 0.97, both before and after): the query returns nothing now, not a confident wrong answer, which this project already treats as the honest result |
| Vector margin misses a chunk in a dense topic cluster | later | Found while investigating the row above. The correct chunk for "which peptide makes you really hungry" is the single closest chunk in the workspace (cosine 0.7246), but ADR-022's margin filter needs 0.7250 for this query, because 18 pages sharing "appetite" vocabulary raise the neighbourhood baseline the margin is measured against. Missed by 0.0004. Shrinking the margin to pass this one query would be overfitting to the eval set; a real fix needs its own before/after evaluation across more than one query |
| Cosmos adapter | later, on a trigger | ADR-020: only if more than one instance, a slow cold restore, or the write-loss window matters |
| Own-server deploy (Proxmox, NAS, Docker) | done | ADR-020. `deploy/docker/`, database on a mounted local volume. CI starts it with one; not yet run on Proxmox. Proxmox specifics split into `docs/DEPLOY-PROXMOX.md` |
| AWS and GCP deploy guides | done | ADR-043. A small VM running the same Docker setup as any other self-hosted target, not a managed container service. `docs/DEPLOY-AWS.md`, `docs/DEPLOY-GCP.md`. Not yet run for real on either cloud |
| OAuth server | done | ADR-017. GitHub or any OpenID Connect provider, consent page, CLI login. 23 end-to-end tests. Proven with claude.ai after a deploy |
| Azure deploy | done | ADR-018. Running in Sweden Central since 2026-09-13, holding the owner's wiki. The first deployment found three bugs, all fixed. Cold start about 30 s, mostly the image pull |
| Agent-first install guide | done | ADR-019. `docs/AGENT-INSTALL.md`, `AGENTS.md` |
| Agent-first configuration and operation guide | done | ADR-031. `docs/AGENT-OPERATE.md`: every setting, health, updates, sync, backups, access, cost and troubleshooting. A test fails when a setting the code reads is missing from it, or when either agent guide names a setting or `cairn` command that does not exist |
| Peptide wiki reseeded from the updated wiki | done | 96 pages, 79 peptides, 8 stacks, 2 tables |

Gate: usage and recall targets from PRD section 10 met for two weeks. If not, stop or rethink.

The two week clock restarts once the presence work below is in place. A review on 2026-09-16 found that the gate had been measuring an instrument that was switched off: on the owner's own machine the server was not running, no MCP server was registered, the stored sign-in had been deleted, and no sync job was installed. See the section below.

## The review of 2026-09-16

A hands-on review of Cairn as a tool, done against the owner's laptop copy of 104 pages, the console, a live MCP initialize and the CLI. The full review is a page in the owner's Cairn, "Cairn review 2026-09-16: fixes and improvements". It found nothing missing from the design and four things wrong with the fact of it: Cairn was not reachable, the sign-in deleted itself, the summary that tells an agent what Cairn holds was empty, and an agent had no way to walk the page tree.

Six ADRs and four specs came out of it. The order below is the order to build in. Items one and two are what stand between the project and a fair test of its own kill criterion.

| Item | Status | Notes |
|---|---|---|
| Presence: a session hook, a job that starts the local Cairn, and `cairn status` | done | 2026-09-17. ADR-053, `docs/specs/presence.md`. `cairn hook install` adds a Claude Code SessionStart hook running a bounded `cairn overview --brief`; the scheduled job runs `cairn start` instead of `cairn sync`; `cairn status` reports instance, sign-in, last sync, embeddings, job and hook in one screen, each bad line carrying its fix. Database size and last-backup age (spec design item 7) are left out, since `/health` does not report them and wiring `BackupEngine`'s state through `app.ts` is its own piece of plumbing; the embeddings line reports a plain count rather than a trend, since one run has no earlier run to compare against. Both are noted in the spec itself |
| The sign-in that deletes itself | done | 2026-09-17. ADR-054, `docs/specs/sign-in-resilience.md`. The server's refresh branch now polls up to `REFRESH_RACE_WAIT_MS` (1s) for the winning request's replay record before answering `invalid_grant`, so a losing concurrent request gets the same tokens instead of being wrongly refused; theft detection (a used record, a revoked family) still answers immediately, no wait. The CLI's `storedToken` forgets a sign-in only on a parsed `invalid_grant`; an HTTP error or a network failure (timeout, connection refusal, an unparseable body) throws `RefreshFailed` and keeps the credentials, and `main.ts` prints the instance, address and next step instead of swallowing it. `writeCredentials` re-reads the file immediately before writing one server's entry, so two processes finishing out of order no longer erase each other. The refresh request gets a 30 second timeout with one retry, per ADR-054 decision 6. Access tokens stay at one hour, per ADR-033 |
| The workspace summary gets its own budget | done | 2026-09-17. ADR-055, part of `docs/specs/agent-navigation.md`. The fixed instructions are now 1,418 characters against a 1,500 ceiling a test enforces; the summary gets a 700 character floor of its own regardless, and the total budget is 2,400. A section that would name fewer than three items is dropped whole rather than shown as a bare "and N more" stub. Tested against a generated 100-page, 12-collection, 2-table, 20-tag workspace, which is the scale the old tests missed |
| An agent can walk the tree, and MCP catches up | next | ADR-058, part of `docs/specs/agent-navigation.md`. `list_children` on all three surfaces, children reported when a page is read, and MCP gains delete, the changes feed and a table schema update, all of which REST and the CLI already have. A test fails when the three surfaces drift apart, so hard rule 14 stops being a rule people are asked to remember. Tables gain a description |
| A search result names each page once | next | ADR-057, part of `docs/specs/console-and-search-polish.md`. Three pages took nine of ten hits in a live search. Results become pages carrying up to three passages each, and a limit counts pages. Hard rule 7 applies: `pnpm eval` before and after, per backend, with recall@5 and a new distinct-page count recorded |
| Eight smaller faults | next | Part of `docs/specs/console-and-search-polish.md`. The CLI's conflict error carrying REST's ETag wording, `--where` on an unknown field printing "no rows", a write without a note passing silently, snippets dropping apostrophes, the `search` tool calling `mode` an input when it is an output, an empty result that suggests nothing, an unreachable Cairn that does not say which instance it tried, and no way to see Cairn's own state from the console. Four of them are misleading errors and each earns a `docs/LESSONS.md` entry |

## Surfaces and what sets Cairn apart

Added after the project review of 2026-09-12. Done in this order, before the cloud work, because each one is small and sharpens the pitch.

| Item | Status | Notes |
|---|---|---|
| REST API at `/api/v1` | done | ADR-013. Same core, auth and errors as MCP. ETag and If-Match. 20 contract tests |
| Changes feed | done | ADR-013. `GET /api/v1/changes?since=` |
| `cairn` CLI and skill file | done | ADR-013. About 115 tokens per session against about 3,100 for MCP (2,725 before the `move` tool, ADR-024; 2,931 before sources, ADR-027; 3,091 before freshness, ADR-028). 9 tests, checked live |
| CLI for Windows, macOS and Linux | done | ADR-014. Five standalone executables and npm. Each smoke-tested on its own OS in CI |
| Publish the CLI to npm | done | Published as `@vespassassina/cairncli` (2026-09-15), after `@cairn/cli` (npm org taken) and unscoped `cairncli` (too similar to an existing package) both failed at publish time. `v0.1.5` confirmed live on both npm and ghcr.io, CI green (`docs/LESSONS.md`, `docs/DIRECTIONS.md`) |
| Provenance: `sources` on every write | done | ADR-027. A list of URLs or short citations on each page and row, added to by writes, shown in the console and its history; optional but prompted |
| Freshness: `verified_at` on pages | done | ADR-028. When a page's facts were last confirmed: set by `verified: true` on a write, or at creation with sources; shown as an age on each page and in a Freshness list, least recent first |
| Collections in the page tree, and relations as links | done | ADR-024 (the collections it moved are tables since ADR-026). `move` for pages and tables; relation fields to pages or rows, lists allowed; backlinks from rows |
| Collections are wikis, and tables are called tables | done | ADR-026. The web app opens on collections (top-level pages and their trees); REST, MCP, CLI and export say table, with the old REST paths and CLI names kept for now |
| Sync between two Cairns | done | ADR-023. `cairn sync <a> <b> [--every 5m]`: content compared with the last sync, newest edit wins, the other kept in history. Checked between the owner's laptop and Azure |
| Named instances, kept in sync: backup and a hybrid service | done | ADR-029. `cairn instances add <name> <url>` registers each Cairn in the owner's order; every command goes to the first that answers; `cairn sync` with no addresses syncs them all through the first that answers; `cairn start` starts the local copy and catches up with the cloud; `cairn sync install` puts a job on launchd, systemd or Task Scheduler, every hour by default so a scale-to-zero copy can sleep between runs. MCP clients keep one fixed address |
| Ordered history and three-way merge in sync | done | ADR-030. Every page and row keeps `edited_at`, the time it was edited where it was edited, from a clock that never repeats and never goes back for a record; sync carries it across hops and orders by it. When both sides changed a page or row, sync merges them three ways against the version they last agreed on, found in history: the body line by line as git does, tags and sources as sets, row fields one by one. Only a part both changed takes the newer edit, and the other stays in history with a note. Tested with three Cairns |
| History as one chain across instances | later | From the same direction ("newest and link the older keeping the chain in order"), left out of ADR-030. Each revision would carry the id of the one it replaced, travelling with sync, so a record's history reads as one chain across instances as git's does, and sync finds the base by link instead of by hash. Needs an ADR |
| Sync conflicts to review in the console | later | Left out of ADR-030: a console list of records where a sync conflict took the newer edit for some part, with the version it replaced one click away. Today the change note and the sync report say so |

## Against a notes app kept in git

Added on 2026-09-14, from the owner's question of why anyone would choose Cairn over Obsidian with its vault in a GitHub repository. Obsidian wins on its editor, plugins, graph view, price, and plain files under git. Cairn wins when agents do most of the writing: it is reachable over MCP from anywhere, refuses a stale write instead of overwriting it, keeps a revision with an actor and a note for every write, and has typed tables, sources and freshness. These items close the gaps that matter most, in the order the owner listed them, followed by the owner's later direction that a wiki can be published as a free knowledge source. None has an ADR yet; each needs one before code, and several push against a limit an existing ADR or the PRD sets, named in its notes.

| Item | Status | Notes |
|---|---|---|
| Obsidian bridge: import a vault, and export back to one | later | Removes the switching cost, the main objection. Wiki links, front matter, folders and tags map onto pages, tags and the page tree; the export already writes Markdown in folders (ADR-016), so exporting in a vault's shape is mostly naming. Was PRD P2 and Phase 3; this moves the Obsidian half forward |
| Git mirror: the export pushed to a repository on a schedule | later | Keeps git's reassurance on top of Cairn: plain files, diffs, a copy on GitHub. Could run from the job `cairn sync install` sets up (ADR-029). The CLI would need git, which hard rule 16 does not allow yet |
| Agent activity digest and approvals | later | What agents changed today, from the changes feed (ADR-013) and the review console (ADR-009), with optional sign-off before an agent's write goes live. Sign-off means a pending state for writes, which the core does not have |
| Stale-page reviews | later | A regular list of the pages verified longest ago (ADR-028), with a re-check drafted by an agent for the owner to confirm |
| Quick capture: a web clipper and share-to-Cairn from a phone | later | Capture a page or a note in one step, and let an agent file it into the right collection with its source. Needs a small capture endpoint and a way to sign in from a phone share sheet |
| Graph view of links and relations | later | The edges already exist (hard rule 9). A picture in the console goes past ADR-009's limits and needs an ADR that amends them |
| Templates, daily notes, attachments and images | later | Templates and daily notes are pages with a shape; attachments are PRD P1 item 4, up to 25 MB through the blob adapter |
| A console that works on a phone | next | ADR-056, part of `docs/specs/console-and-search-polish.md`. The PRD already asks that the web UI work on phones (non-goal 5). A review on 2026-09-16 measured it: Cairn's own CSS has one layout breakpoint, at 1,100 pixels, below which the page tree keeps a fixed 200 pixel column all the way down, so at 375 pixels the body gets about 120 pixels and the search field forces the page to scroll sideways. A second breakpoint below 700 pixels stacks the three columns, collapses the tree into the same native `details` element its branches already use, and gives links a thumb-sized target. CSS and native elements only, so it stays inside ADR-009's limits |
| Public wiki: read-only and indexable by search engines | done | 2026-09-14. ADR-032. The owner publishes a page in the console or with `cairn publish`, and it and every page under it are served at `/w` with no sign-in, with a title, description, canonical address, `sitemap.xml` and `robots.txt`. Private by default; an unpublished page is 404 to a stranger, private children are never listed, a link to a private page is not a link, and no actor is named. Publication never travels with sync, export or import, and MCP cannot publish at all, so an agent cannot publish what it wrote. The content's licence comes from `CAIRN_CONTENT_LICENCE` |
| Static site export: share the wiki with no server running | done | 2026-09-14. ADR-035. `cairn export --format site` writes a folder of plain HTML: wiki links rewritten to relative paths between pages, a breadcrumb trail and child list per page, sources kept as visible, clickable citations, an `index.html` per export, and `sitemap.xml` when `--site-url` is given. Rendering is a small, self-written Markdown subset in the CLI (`packages/cli/src/site-format.ts`), not `markdown-it`, to stay inside hard rule 16. Table rendering is not part of this format yet; use the default `cairn` format's `--tables` for that |
| Sharing with other people, each with their own permissions | later | PRD P2 item 6. Today a Cairn has one owner and the agents they approve; this changes the auth model (ADR-007, ADR-017) |
| A published search-quality number from the eval set | done | 2026-09-14. recall@5 0.97 hybrid, 0.88 keyword, 9 of 9 no-answer, on the 104-page peptide wiki with SQLite and FTS5. In the README, with the cautions in PRD section 11 |

## Bridges between Cairns

Added on 2026-09-14, from the owner's direction: "always keep citations correct and links to original content. this is the key for semantic internet across cairns. we are not going to be islands with no bridges". PRD principle 6.

What holds today: every page and row keeps its sources (ADR-027), and they travel unchanged through export, import and sync, and show in history. What does not: Cairn never checks a source (ADR-027 consequence 5), and a page knows nothing about Cairns other than its own. Each item below needs an ADR; the first one supersedes that consequence.

| Item | Status | Notes |
|---|---|---|
| Citations kept correct | done | 2026-09-15. ADR-036. `cairn check-sources [--root PAGE]` checks each linked source once (HEAD, GET fallback), reports which are dead, and looks up an archived copy on the Wayback Machine for each dead `http(s)` one. Report only: nothing is written. A DOI or PubMed id is now recognised as a link (`sourceHref` in `packages/core/src/sources.ts`, duplicated in the CLI for `cairn export --format site`), everywhere a source is shown: console, published wiki, static site export. The instructions and the skill ask agents to cite the original, not a summary of it |
| Links to the original, across Cairns | done | 2026-09-15. ADR-038. A canonical address (ADR-032) and unconditional source propagation through publishing (ADR-027) already covered the first two parts. New: an ordinary Markdown link shaped `<origin>/w/<page-id>` becomes a `cairn_link` edge, so `get_backlinks`, `get_neighbours` and `cairn links` see it alongside local links. Structural only, nothing fetched: it does not check the ADR-037 trusted list or that the address is live |
| Machine-readable citations on public pages | done | 2026-09-15. ADR-039. Every published page (`/w/<id>`) and every page in `cairn export --format site` carries a `<script type="application/ld+json">` block: every source as schema.org `citation` (a `CreativeWork` when it resolves to an address, plain text when it does not), and any source shaped like another Cairn's page as `isBasedOn`. Computed from data the page already has, nothing fetched |
| "Cited by", across Cairns | done | 2026-09-15. ADR-040. `POST /webmention`, Webmention-shaped: verifies the sender's page really links to the cited one (an SSRF-safe fetch, private and loopback addresses refused at every redirect hop), then upserts a row in a new, lazily-created "Citations" table. An origin in "Trusted cairns" (ADR-037) is accepted at once; any other is `pending` for the owner to accept through the same generic table tools ADR-037 already relies on. A published page (`/w/<id>`) shows a "Cited by" section for its accepted rows. `cairn export --format site` is unchanged: a static export cannot receive the notice at all |
| A public Cairn describes itself | done | 2026-09-14. ADR-034. `/.well-known/cairn.json`, no sign-in: name, description, language and topics from settings (`CAIRN_NAME` and the like), the licence, the published collections and their addresses, the sitemap, and `cites`: the origins its published pages cite, filled in by ADR-041 |
| Tell search engines when publishing changes something | later | Split out of the item above when it landed. On a publish or unpublish, notify through IndexNow so a search engine recrawls without waiting for its own schedule |
| A registry of public Cairns on GitHub | rejected | 2026-09-15. The owner's direction: "avoid the registry. not my place." Running or curating a shared registry, even a CC0 one on GitHub, is not a role this project takes on. See "A local trusted friends catalog" below for what replaces it |
| A local trusted friends catalog | done | 2026-09-15. ADR-037. `cairn trust <url>` confirms the address answers with a Cairn self-description (ADR-034), then adds or updates a row for it in an ordinary table, "Trusted cairns", created on first use. No new storage or schema: `cairn tables`, `rows`, `row` and `upsert`, and the equivalent MCP tools and REST endpoints, already read and manage it like any other table. The list stays local unless the owner publishes it like any other collection |
| Discovery by following citations | done | 2026-09-15. ADR-041. `cairn discover [--from URL]... [--depth N] [--limit N]` walks outward, breadth first, from every url in "Trusted cairns" plus any `--from`, following each Cairn's `cites` field. Newly found Cairns land in a new "Discovered cairns" table, a lead to review, never auto-trusted; a Cairn already trusted is never reported as newly found |

## Launch checklist

Before publishing on GitHub and posting to Hacker News. From the review of 2026-09-12.

| Item | Status | Notes |
|---|---|---|
| Eval set: 30 real queries with expected pages, and a recall@5 number | done | 2026-09-14. 32 queries, recall@5 0.97 hybrid and 0.88 keyword, published in the README |
| Two weeks of daily use, against the PRD kill criterion | next | The review of 2026-09-16 found the criterion was being measured against an instrument that was switched off. Both fixes it was waiting on, presence (ADR-053) and the sign-in fix (ADR-054), landed 2026-09-17: the clock can now start, since a failure to reach for Cairn can be told apart from a failure to reach Cairn |
| Export (P0.7) | done | ADR-016. Markdown and JSON, whole or by root, lossless round trip |
| One cloud target deployed, with a month of real cost | in progress | ADR-018. Deployed 2026-09-13; the month of cost runs from then. Cold start measured, about 30 s. Still to measure: the write-loss window (ADR-020) |
| First release tag, so the image and CLI builds are published | done | `v0.1.0` on 2026-09-13, then `v0.1.1`, `v0.1.2` and `v0.1.3` the same day. Images `0.1.0`, `0.1` and `latest` pull anonymously, amd64 and arm64; five CLI executables and `SHA256SUMS` on the GitHub release |
| OAuth, so claude.ai can connect | done | ADR-017. Needs one real connection to call it proven |
| Licence decided | done | ADR-015, PolyForm Noncommercial 1.0.0 |
| Contributor terms decided | next | Before accepting outside pull requests, so commercial licences can cover contributed code (ADR-015 consequence 4) |
| How to ask for a commercial licence | next | A contact route in the README better than "ask through GitHub" |
| Name decided | done | ADR-044. Cairn, no dedicated domain: the short obvious ones are all already registered, and the repository, npm package and container images already carry the name |
| Repository public | done | https://github.com/vespassassina/cairn |
| Online and offline model decided | done | ADR-023: a local Cairn and a cloud one, kept in step by `cairn sync` |
| Search over-matching fixed | done | ADR-021. Questions with no answer now return nothing |
| README leads with the tagline and a console screenshot | next | |
| CI green on Linux, macOS and Windows | done | Tests, CLI build and smoke test pass on Linux x64, Linux Arm, macOS and Windows (run 34703011030) |
| Sign the macOS and Windows executables | later | ADR-014 rule 7. Costs an Apple developer account and a Windows certificate |

## Phase 2: editor

BlockNote editor, table editing, export UI. Gated on Phase 1.

| Item | Status | Notes |
|---|---|---|
| More kinds of content: notes, blog posts, diagrams, pictures | later | The owner's direction of 2026-09-14. Today a Cairn holds wiki pages and tables. Add: **notes**, short and quick, linked from wiki pages and shown in their backlinks; **blog posts**, dated, with a published state, feeding the public wiki and static site with a feed; **diagrams**, kept as text (Mermaid) so an agent can write them and history, search and the sync merge (ADR-030) work on them, drawn in the console; **pictures and other files**, as attachments through the blob adapter (PRD P1 item 4), shown inline and carried by export and sync. Other formats as they are asked for. Agents write every kind through the CLI, REST and MCP alike (hard rule 14); a person writes through their agent or in the editor, which offers a starting shape for each kind and a preview. Overlaps "Templates, daily notes, attachments and images" above. Needs an ADR: probably a `kind` on pages rather than new stores, and a blob adapter |
| Reskin the wiki: a theme setting | later | The owner's direction of 2026-09-14. The console takes every colour, font size, width and density from artifactkit's theme tokens (ADR-009 rule 3: Cairn's own CSS defines no colour), so a theme is a handful of token values: ground, ink, accent, density, text size, page width, and dark mode. The editor edits them with a live preview and keeps them in the workspace's settings, and the public wiki and static site use the same theme. Custom CSS on top, for people who want more, served from its own stylesheet and never able to run script. Needs an ADR |

## Phase 3: options

A multilingual or bring-your-own embedding model, AWS adapters, Desktop extension, import from Notion. Import from Obsidian moved to "Against a notes app kept in git" above.

## Open questions that block work

See PRD section 13. Currently blocking: Q7 (free tier facts, now for Azure Container Apps and cloud VMs on AWS and GCP, ADR-043; a managed AWS/GCP container service is still a future option, not a current target). Q1 and Q8 wait for the optional Cosmos adapter (ADR-020).
