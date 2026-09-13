# Decisions

Architecture decision records. One file per decision, numbered, never renumbered.

A decision that changes is not edited away. Add a new ADR that supersedes it, and mark the old one `Status: superseded by ADR-NNN` with a line saying why. The history of why we changed our minds is worth as much as the current answer.

## Index

| ADR | Decision | Status | Date |
|---|---|---|---|
| [001](ADR-001.md) | MCP server is the primary interface | accepted, refined by 013 | 2026-09-10 |
| [002](ADR-002.md) | Graph as edge documents, no Gremlin | accepted | 2026-09-10 |
| [003](ADR-003.md) | Bring-your-own embeddings endpoint | superseded as the default by 022 | 2026-09-10 |
| [004](ADR-004.md) | Separate chunks store, vector container created on enable | accepted, model change amended by 022 | 2026-09-10 |
| [005](ADR-005.md) | Adapter boundary: search separate, derived data rebuildable, no cross-document transactions | accepted | 2026-09-11 |
| [006](ADR-006.md) | Hono plus stateless MCP transport, lowest common denominator | accepted, runtime targets superseded by 020 | 2026-09-11 |
| [007](ADR-007.md) | Auth is one small OAuth server in front of any OIDC provider | accepted, amended by 017 | 2026-09-11 |
| [008](ADR-008.md) | Every write is a revision, and agents write directly | accepted | 2026-09-12 |
| [009](ADR-009.md) | A server-rendered review console, styled with artifactkit | accepted, rule 5 amended by 010 | 2026-09-12 |
| [010](ADR-010.md) | No sign-in for trusted local requests | accepted | 2026-09-12 |
| [011](ADR-011.md) | Cairn tells clients when to use it | accepted, extended by 012 | 2026-09-12 |
| [012](ADR-012.md) | The server instructions carry a live summary of the workspace | accepted | 2026-09-12 |
| [013](ADR-013.md) | One core, three surfaces: MCP, REST and a CLI | accepted | 2026-09-12 |
| [014](ADR-014.md) | The CLI ships as an npm package and as standalone executables | accepted | 2026-09-12 |
| [015](ADR-015.md) | Source-available under PolyForm Noncommercial 1.0.0 | accepted | 2026-09-12 |
| [016](ADR-016.md) | Export is a folder of Markdown and JSON that imports back without loss | accepted | 2026-09-12 |
| [017](ADR-017.md) | The OAuth server as built | accepted, amends 007 | 2026-09-12 |
| [018](ADR-018.md) | The first Azure deployment: Container Apps with Litestream | accepted, decision 6 superseded by 020 | 2026-09-12 |
| [019](ADR-019.md) | Installation is written for an agent to follow, with the person at the checkpoints | accepted | 2026-09-12 |
| [020](ADR-020.md) | One container everywhere, as small as it can be, with SQLite on a mounted volume or a replica | accepted, supersedes parts of 006 and 018 | 2026-09-12 |
| [021](ADR-021.md) | Keyword search returns pages that hold most of the query's words, stemmed | accepted | 2026-09-12 |
| [022](ADR-022.md) | Vector search in SQLite with sqlite-vec, and a small English model inside the container | accepted, supersedes 003 as the default | 2026-09-13 |

## Writing one

1. Copy the shape of an existing ADR: context, decision, consequences.
2. Context says what forced the decision and what the options were.
3. Decision says what we chose, specifically enough to check code against.
4. Consequences says what this makes easier, harder, or still open.
5. Add it to the index above and to `docs/CHANGELOG.md` in the same commit.
