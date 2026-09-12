# Roadmap

Where Cairn is, what is next, and what gates each step. The PRD (section 14) holds the original phasing. This file holds the live state, and is updated whenever work lands or plans change.

Status key: done, in progress, next, later, blocked.

## Phase 0: foundations

| Item | Status | Notes |
|---|---|---|
| Adapter interfaces (document store, search index) | done | ADR-005 |
| SQLite adapter | done | `node:sqlite`, FTS5 |
| Conformance suites | done | document store, search index, pushdown equivalence |
| Spike S2: MCP transport shape | done | Web-standard transport, one server per request. ADR-006 |
| Spike S1: Hono on Azure Functions | next | Blocks Phase 1 deploy, not local use |
| Eval query set, 30 real queries | in progress | 2 of 30 written, none with expected pages |

## Phase 1: MCP only, used daily

| Item | Status | Notes |
|---|---|---|
| Local PoC: API, MCP server, dev auth | done | Claude Code CLI, loopback only |
| Import, rebuild, eval commands | done | |
| Peptide wiki seed | done | `examples/peptide-wiki` |
| Revisions: history, actor, change notes | in progress | ADR-008 |
| Review console | in progress | ADR-009 |
| Search precision: OR matching over-matches | later | Tune against the eval set once expected pages exist |
| Cosmos adapter | later | Needs Q1, Q7, Q8 answered |
| OAuth server | later | ADR-007, time-boxed to 3 days (R1) |
| Azure deploy | later | Needs S1 |

Gate: usage and recall targets from PRD section 10 met for two weeks. If not, stop or rethink.

## Phase 2: editor

BlockNote editor, collection table editing, export UI. Gated on Phase 1.

## Phase 3: options

Bring-your-own embeddings, AWS adapters, Desktop extension, import from Notion and Obsidian.

## Open questions that block work

See PRD section 13. Currently blocking: Q1 (Cosmos full-text languages), Q7 (free tier facts), Q8 (emulator full-text support).
