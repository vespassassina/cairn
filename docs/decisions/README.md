# Decisions

Architecture decision records. One file per decision, numbered, never renumbered.

A decision that changes is not edited away. Add a new ADR that supersedes it, and mark the old one `Status: superseded by ADR-NNN` with a line saying why. The history of why we changed our minds is worth as much as the current answer.

## Index

| ADR | Decision | Status | Date |
|---|---|---|---|
| [001](ADR-001.md) | MCP server is the primary interface | accepted | 2026-09-10 |
| [002](ADR-002.md) | Graph as edge documents, no Gremlin | accepted | 2026-09-10 |
| [003](ADR-003.md) | Bring-your-own embeddings endpoint | accepted | 2026-09-10 |
| [004](ADR-004.md) | Separate chunks store, vector container created on enable | accepted | 2026-09-10 |
| [005](ADR-005.md) | Adapter boundary: search separate, derived data rebuildable, no cross-document transactions | accepted | 2026-09-11 |
| [006](ADR-006.md) | Hono plus stateless MCP transport, lowest common denominator | accepted | 2026-09-11 |
| [007](ADR-007.md) | Auth is one small OAuth server in front of any OIDC provider | accepted | 2026-09-11 |
| [008](ADR-008.md) | Every write is a revision, and agents write directly | accepted | 2026-09-12 |
| [009](ADR-009.md) | A server-rendered review console, styled with artifactkit | accepted, rule 5 amended by 010 | 2026-09-12 |
| [010](ADR-010.md) | No sign-in for trusted local requests | accepted | 2026-09-12 |
| [011](ADR-011.md) | Cairn tells clients when to use it | accepted | 2026-09-12 |

## Writing one

1. Copy the shape of an existing ADR: context, decision, consequences.
2. Context says what forced the decision and what the options were.
3. Decision says what we chose, specifically enough to check code against.
4. Consequences says what this makes easier, harder, or still open.
5. Add it to the index above and to `docs/CHANGELOG.md` in the same commit.
