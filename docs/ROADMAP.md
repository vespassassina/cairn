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
| Review console | done | ADR-009. 24 contract tests, checked visually |
| Console: a new page starts under the page being read | done | The owner's direction of 2026-09-14. The header button carries the page you are on, the form says it chose that parent, and a parent that is gone falls back to the top level with a banner |
| No sign-in on localhost | done | ADR-010. `cairn.config.json` |
| MCP server instructions | done | ADR-011. Read first, write back, change notes |
| Live workspace summary in the instructions | done | ADR-012. Tables, collections (top-level pages), tags, within the budget |
| Daily use from Claude Code | in progress | Server added with `--scope user`. Watch agent writes in the console (ADR-011 consequence 4) |
| Semantic search: sqlite-vec and a model in the container | done | ADR-022. English only. Hybrid recall@5 1.00 against keyword 0.83, no-answer 9 of 9 in both |
| Search precision: OR matching over-matches | done | ADR-021. Most of the words, stemmed, one chunk per page first. No-answer queries 0 of 6 to 6 of 6, recall@5 unchanged at 1.00 |
| Search does not know direction | later | Found while finishing the eval set on 2026-09-14. "Which peptide makes you really hungry" returns the appetite suppressants: 18 pages talk about appetite and nothing in the text says which way. Both modes miss it, and it is the only miss in the set. A fix probably means the model seeing more of the sentence around a match, not another weight |
| Cosmos adapter | later, on a trigger | ADR-020: only if more than one instance, a slow cold restore, or the write-loss window matters |
| Own-server deploy (Proxmox, NAS, Docker) | done | ADR-020. `deploy/docker/`, database on a mounted local volume. CI starts it with one; not yet run on Proxmox |
| OAuth server | done | ADR-017. GitHub or any OpenID Connect provider, consent page, CLI login. 23 end-to-end tests. Proven with claude.ai after a deploy |
| Azure deploy | done | ADR-018. Running in Sweden Central since 2026-09-13, holding the owner's wiki. The first deployment found three bugs, all fixed. Cold start about 30 s, mostly the image pull |
| Agent-first install guide | done | ADR-019. `docs/AGENT-INSTALL.md`, `AGENTS.md` |
| Agent-first configuration and operation guide | done | ADR-031. `docs/AGENT-OPERATE.md`: every setting, health, updates, sync, backups, access, cost and troubleshooting. A test fails when a setting the code reads is missing from it, or when either agent guide names a setting or `cairn` command that does not exist |
| Peptide wiki reseeded from the updated wiki | done | 96 pages, 79 peptides, 8 stacks, 2 tables |

Gate: usage and recall targets from PRD section 10 met for two weeks. If not, stop or rethink.

## Surfaces and what sets Cairn apart

Added after the project review of 2026-09-12. Done in this order, before the cloud work, because each one is small and sharpens the pitch.

| Item | Status | Notes |
|---|---|---|
| REST API at `/api/v1` | done | ADR-013. Same core, auth and errors as MCP. ETag and If-Match. 20 contract tests |
| Changes feed | done | ADR-013. `GET /api/v1/changes?since=` |
| `cairn` CLI and skill file | done | ADR-013. About 115 tokens per session against about 3,100 for MCP (2,725 before the `move` tool, ADR-024; 2,931 before sources, ADR-027; 3,091 before freshness, ADR-028). 9 tests, checked live |
| CLI for Windows, macOS and Linux | done | ADR-014. Five standalone executables and npm. Each smoke-tested on its own OS in CI |
| Publish the CLI to npm | later | Needs the name decided |
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
| A console that works on a phone | later | The PRD already asks that the web UI work on phones (non-goal 5). The public read-only wiki is now two items of its own, below |
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
| Links to the original, across Cairns | later | Every published page has one stable, canonical address. A page copied or quoted from another Cairn keeps a source pointing at the original page there, and publishing never drops it. A link to a page in another Cairn is an edge like a local link |
| Machine-readable citations on public pages | later | Public pages and the static site carry their sources as visible citations and as structured data (schema.org `citation` and `isBasedOn`), so search engines and agents can follow them from one Cairn to the next |
| "Cited by", across Cairns | later | An optional notice, in the manner of Webmention, telling a Cairn that another has cited one of its pages, so it can show who builds on it. Off by default; a Cairn accepts notices only from addresses in its trusted list, below, or on review |
| A public Cairn describes itself | done | 2026-09-14. ADR-034. `/.well-known/cairn.json`, no sign-in: name, description, language and topics from settings (`CAIRN_NAME` and the like), the licence, the published collections and their addresses, the sitemap, and `cites`, always empty until citation tracking exists |
| Tell search engines when publishing changes something | later | Split out of the item above when it landed. On a publish or unpublish, notify through IndexNow so a search engine recrawls without waiting for its own schedule |
| A registry of public Cairns on GitHub | rejected | 2026-09-15. The owner's direction: "avoid the registry. not my place." Running or curating a shared registry, even a CC0 one on GitHub, is not a role this project takes on. See "A local trusted friends catalog" below for what replaces it |
| A local trusted friends catalog | done | 2026-09-15. ADR-037. `cairn trust <url>` confirms the address answers with a Cairn self-description (ADR-034), then adds or updates a row for it in an ordinary table, "Trusted cairns", created on first use. No new storage or schema: `cairn tables`, `rows`, `row` and `upsert`, and the equivalent MCP tools and REST endpoints, already read and manage it like any other table. The list stays local unless the owner publishes it like any other collection |
| Discovery by following citations | later | Each self-description lists the Cairns it cites, so a reader can walk outward from any one Cairn by following them, starting from whichever Cairns are already in its own or a trusted friend's list. Rejected: a registry server that Cairns contact on their own, which someone must run and pay for, attracts spam, and makes the network depend on one place. Reddit, Hacker News and "awesome" lists announce a Cairn; they are not a registry of them |

## Launch checklist

Before publishing on GitHub and posting to Hacker News. From the review of 2026-09-12.

| Item | Status | Notes |
|---|---|---|
| Eval set: 30 real queries with expected pages, and a recall@5 number | done | 2026-09-14. 32 queries, recall@5 0.97 hybrid and 0.88 keyword, published in the README |
| Two weeks of daily use, against the PRD kill criterion | in progress | |
| Export (P0.7) | done | ADR-016. Markdown and JSON, whole or by root, lossless round trip |
| One cloud target deployed, with a month of real cost | in progress | ADR-018. Deployed 2026-09-13; the month of cost runs from then. Cold start measured, about 30 s. Still to measure: the write-loss window (ADR-020) |
| First release tag, so the image and CLI builds are published | done | `v0.1.0` on 2026-09-13, then `v0.1.1`, `v0.1.2` and `v0.1.3` the same day. Images `0.1.0`, `0.1` and `latest` pull anonymously, amd64 and arm64; five CLI executables and `SHA256SUMS` on the GitHub release |
| OAuth, so claude.ai can connect | done | ADR-017. Needs one real connection to call it proven |
| Licence decided | done | ADR-015, PolyForm Noncommercial 1.0.0 |
| Contributor terms decided | next | Before accepting outside pull requests, so commercial licences can cover contributed code (ADR-015 consequence 4) |
| How to ask for a commercial licence | next | A contact route in the README better than "ask through GitHub" |
| Name decided | next | PRD Q5. The repository is `vespassassina/cairn`; check npm before publishing the CLI |
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

See PRD section 13. Currently blocking: Q7 (free tier facts, now for Azure Container Apps and a future AWS container target). Q1 and Q8 wait for the optional Cosmos adapter (ADR-020).
