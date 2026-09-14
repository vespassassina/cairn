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
| Named instances, kept in sync: backup and a hybrid service | next | The owner's direction of 2026-09-14. Register several Cairns in the CLI by name (the laptop, Azure, later a Proxmox server) and keep them all in sync on a schedule, as a background job, so the same container runs in several places at once as one Cairn: work on the local copy, sync to the cloud every so many minutes, or every few hours to let a scale-to-zero copy sleep and cost less. Each copy is then a backup of the others, and any one can serve if another is down. The CLI knows every instance and sends each command to the best one reachable, and on starting it first brings the local copy up to date with anything changed in the cloud. Builds on ADR-023, which leaves out more than two Cairns; needs an ADR on the topology (the machine running the job syncs each instance with its own copy, not a ring), how the job runs on each OS, and what it costs to wake a sleeping cloud copy |

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

A multilingual or bring-your-own embedding model, AWS adapters, Desktop extension, import from Notion and Obsidian.

## Open questions that block work

See PRD section 13. Currently blocking: Q7 (free tier facts, now for Azure Container Apps and a future AWS container target). Q1 and Q8 wait for the optional Cosmos adapter (ADR-020).
