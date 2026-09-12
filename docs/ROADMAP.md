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
| Spike S1: Hono on Azure Functions | next | Blocks Phase 1 deploy, not local use |
| Eval query set, 30 real queries | in progress | 2 of 30 written, none with expected pages |

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
| Live workspace summary in the instructions | done | ADR-012. Collections, top-level pages, tags, within the budget |
| Daily use from Claude Code | in progress | Server added with `--scope user`. Watch agent writes in the console (ADR-011 consequence 4) |
| Search precision: OR matching over-matches | later | Tune against the eval set once expected pages exist |
| Cosmos adapter | later | Needs Q1, Q7, Q8 answered |
| OAuth server | later | ADR-007, time-boxed to 3 days (R1) |
| Azure deploy | later | Needs S1 |

Gate: usage and recall targets from PRD section 10 met for two weeks. If not, stop or rethink.

## Surfaces and what sets Cairn apart

Added after the project review of 2026-09-12. Done in this order, before the cloud work, because each one is small and sharpens the pitch.

| Item | Status | Notes |
|---|---|---|
| REST API at `/api/v1` | done | ADR-013. Same core, auth and errors as MCP. ETag and If-Match. 20 contract tests |
| Changes feed | done | ADR-013. `GET /api/v1/changes?since=` |
| `cairn` CLI and skill file | done | ADR-013. About 115 tokens per session against about 2,700 for MCP. 9 tests, checked live |
| CLI for Windows, macOS and Linux | done | ADR-014. Five standalone executables and npm. Each smoke-tested on its own OS in CI |
| Publish the CLI to npm | later | Needs the name decided |
| Provenance: `sources` on every write | next | Where a fact came from, shown in the console |
| Freshness: `verified_at` on pages | later | When a fact was last confirmed, separate from last edited |
| Sync design on the revision log | later | An ADR only. Local and cloud as one workspace |

## Launch checklist

Before publishing on GitHub and posting to Hacker News. From the review of 2026-09-12.

| Item | Status | Notes |
|---|---|---|
| Eval set: 30 real queries with expected pages, and a recall@5 number | next | Blocks any claim about search |
| Two weeks of daily use, against the PRD kill criterion | in progress | |
| Export (P0.7) | next | "Your data leaves easily" is a principle, and the first question HN will ask |
| One cloud target deployed, with a month of real cost | later | Needs S1. The cost table must hold measured numbers |
| OAuth, so claude.ai can connect | later | ADR-007, time-boxed to 3 days |
| Licence decided | done | ADR-015, PolyForm Noncommercial 1.0.0 |
| Contributor terms decided | next | Before accepting outside pull requests, so commercial licences can cover contributed code (ADR-015 consequence 4) |
| How to ask for a commercial licence | next | A contact route in the README better than "ask through GitHub" |
| Name decided | next | PRD Q5. The repository is `vespassassina/cairn`; check npm before publishing the CLI |
| Repository public | done | https://github.com/vespassassina/cairn |
| Online and offline model decided | later | The sync design above |
| Search over-matching fixed | later | Visible in the first demo |
| README leads with the tagline and a console screenshot | next | |
| CI green on Linux, macOS and Windows | in progress | First run: tests pass on all four, smoke test fixed for Windows cleanup |
| Sign the macOS and Windows executables | later | ADR-014 rule 7. Costs an Apple developer account and a Windows certificate |

## Phase 2: editor

BlockNote editor, collection table editing, export UI. Gated on Phase 1.

## Phase 3: options

Bring-your-own embeddings, AWS adapters, Desktop extension, import from Notion and Obsidian.

## Open questions that block work

See PRD section 13. Currently blocking: Q1 (Cosmos full-text languages), Q7 (free tier facts), Q8 (emulator full-text support).
