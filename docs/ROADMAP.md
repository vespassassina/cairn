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
| Eval query set, 30 real queries | in progress | 16 of 30: 14 written by the agent from the wiki, recall@5 1.00 on them, plus 6 with no answer (ADR-021). 14 left for the owner, from real searches |

## Phase 1: MCP only, used daily

| Item | Status | Notes |
|---|---|---|
| Local PoC: API, MCP server, dev auth | done | Claude Code CLI, loopback only |
| Import, rebuild, eval commands | done | |
| Peptide wiki seed | done | `examples/peptide-wiki` |
| Revisions: history, actor, change notes | done | ADR-008. MCP `get_history`, `get_revision`, `change_note` |
| Review console | done | ADR-009. 24 contract tests, checked visually |
| No sign-in on localhost | done | ADR-010. `cairn.config.json` |
| MCP server instructions | done | ADR-011. Read first, write back, change notes |
| Live workspace summary in the instructions | done | ADR-012. Tables, collections (top-level pages), tags, within the budget |
| Daily use from Claude Code | in progress | Server added with `--scope user`. Watch agent writes in the console (ADR-011 consequence 4) |
| Semantic search: sqlite-vec and a model in the container | done | ADR-022. English only. Hybrid recall@5 1.00 against keyword 0.83, no-answer 9 of 9 in both |
| Search precision: OR matching over-matches | done | ADR-021. Most of the words, stemmed, one chunk per page first. No-answer queries 0 of 6 to 6 of 6, recall@5 unchanged at 1.00 |
| Cosmos adapter | later, on a trigger | ADR-020: only if more than one instance, a slow cold restore, or the write-loss window matters |
| Own-server deploy (Proxmox, NAS, Docker) | done | ADR-020. `deploy/docker/`, database on a mounted local volume. CI starts it with one; not yet run on Proxmox |
| OAuth server | done | ADR-017. GitHub or any OpenID Connect provider, consent page, CLI login. 23 end-to-end tests. Proven with claude.ai after a deploy |
| Azure deploy | done | ADR-018. Running in Sweden Central since 2026-09-13, holding the owner's wiki. The first deployment found three bugs, all fixed. Cold start about 30 s, mostly the image pull |
| Agent-first install guide | done | ADR-019. `docs/AGENT-INSTALL.md`, `AGENTS.md` |
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
| Ordered history and three-way merge in sync | next | The owner's direction of 2026-09-14: "no doc shall conflict and order should always be maintained". Today sync orders edits by each server's own millisecond clock, so a clock running fast on one machine can pick the wrong winner and a tie goes to the first server; a conflict keeps the whole newer record and the other in history. To do: a hybrid logical clock on every write (time, a counter and the instance's id), so every edit has one place in the order even on skewed clocks; each record's revisions linked to the one they replaced, so history is a chain across instances as in git; and a conflict merged three ways against the last version both sides agreed on, by section, taking both when they changed different sections. Only when both changed the same section does the newer win, with the other linked in history and flagged for review in the console. Needs an ADR |

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
| Public wiki: read-only and indexable by search engines | later | The owner's direction of 2026-09-14: Cairn as a knowledge manager and also a free knowledge source. The owner marks a collection public; its pages are then served as plain HTML with no sign-in, with a title, description and canonical address on each, a `sitemap.xml` and `robots.txt`, so search engines index them. Private by default, and nothing private leaks: search, backlinks and links from a public page to a private one show nothing of it. Every other request still needs sign-in, so this amends ADR-017 and needs its own ADR. The content's licence, such as CC BY, is the owner's choice and separate from Cairn's code licence |
| Static site export: share the wiki with no server running | later | The same direction. `cairn export` gains a site format: HTML pages with links rewritten to relative paths, an index per collection, and a sitemap, to put on GitHub Pages, an Azure Blob Storage static website, Amazon S3 static website hosting, Google Cloud Storage or Dropbox. It costs nothing to host and needs no Cairn online. Today's Markdown export can already go in a GitHub repository, which renders Markdown, but its wiki links point at ids and do not click through (ADR-016 consequence 4); rewriting them is the first step. Keeps every source as a visible citation with its link ("Bridges between Cairns" below). Pairs with the git mirror above |
| Sharing with other people, each with their own permissions | later | PRD P2 item 6. Today a Cairn has one owner and the agents they approve; this changes the auth model (ADR-007, ADR-017) |
| A published search-quality number from the eval set | next | The launch checklist's eval item, and the one claim about search Cairn can back with a number |

## Bridges between Cairns

Added on 2026-09-14, from the owner's direction: "always keep citations correct and links to original content. this is the key for semantic internet across cairns. we are not going to be islands with no bridges". PRD principle 6.

What holds today: every page and row keeps its sources (ADR-027), and they travel unchanged through export, import and sync, and show in history. What does not: Cairn never checks a source (ADR-027 consequence 5), and a page knows nothing about Cairns other than its own. Each item below needs an ADR; the first one supersedes that consequence.

| Item | Status | Notes |
|---|---|---|
| Citations kept correct | later | A job that checks each web source still answers, and lists dead ones beside the stale pages (ADR-028), offering an archived copy where one exists. Stable identifiers, such as a DOI or a PubMed id, are recognised and shown as links. The instructions and the skill ask agents to cite the original, not a summary of it |
| Links to the original, across Cairns | later | Every published page has one stable, canonical address. A page copied or quoted from another Cairn keeps a source pointing at the original page there, and publishing never drops it. A link to a page in another Cairn is an edge like a local link |
| Machine-readable citations on public pages | later | Public pages and the static site carry their sources as visible citations and as structured data (schema.org `citation` and `isBasedOn`), so search engines and agents can follow them from one Cairn to the next |
| "Cited by", across Cairns | later | An optional notice, in the manner of Webmention, telling a Cairn that another has cited one of its pages, so it can show who builds on it. Off by default; a Cairn accepts notices only from addresses it trusts or on review |
| A public Cairn describes itself | later | From the owner's question of 2026-09-14 about a registry of public Cairns. A file at `/.well-known/cairn.json`: name, description, topics, language, the licence of the content, its public collections, its sitemap, and the Cairns it cites. On publishing, Cairn tells search engines it changed through IndexNow. Needs the public wiki first; every other discovery item reads this file |
| A registry of public Cairns on GitHub | later | A separate repository, such as `cairn-registry`, with one JSON file per Cairn, added by pull request and its data under CC0, so the main repository's open contributor terms do not apply to entries. CI reads each Cairn's self-description, checks it is public and reachable, and checks again weekly, removing entries that keep failing. GitHub Pages renders it as a searchable list with its own sitemap, which search engines crawl and follow to each Cairn. `cairn publish --register` prints or opens the pull request. Listing is always the owner's explicit step, never a side effect of going public. Entries state their topic, content licence and whether facts are cited; moderation rules are written down, and removal is easy. Later the registry can itself be a public Cairn, with a table of Cairns |
| Discovery by following citations | later | Each self-description lists the Cairns it cites, so a crawler that starts from the registry finds the rest by following them, and the registry holds only the starting points. Rejected: a registry server that Cairns contact on their own, which someone must run and pay for, attracts spam, and makes the network depend on one place. Reddit, Hacker News and "awesome" lists announce the registry; they are not one |

## Launch checklist

Before publishing on GitHub and posting to Hacker News. From the review of 2026-09-12.

| Item | Status | Notes |
|---|---|---|
| Eval set: 30 real queries with expected pages, and a recall@5 number | next | Blocks any claim about search |
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

## Phase 3: options

A multilingual or bring-your-own embedding model, AWS adapters, Desktop extension, import from Notion. Import from Obsidian moved to "Against a notes app kept in git" above.

## Open questions that block work

See PRD section 13. Currently blocking: Q7 (free tier facts, now for Azure Container Apps and a future AWS container target). Q1 and Q8 wait for the optional Cosmos adapter (ADR-020).
