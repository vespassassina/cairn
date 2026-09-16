# Specs

What a piece of work is, before it is built. An ADR in `docs/decisions/` says what was decided and why. A spec here says what has to exist for that decision to be true, and how anyone can tell whether it is.

One file per piece of work, named for the work rather than for a ticket. A spec is written before the code, kept current while the work is in flight, and left in place afterwards as the record of what was agreed. Scope changes go in the spec, not only in the conversation that caused them.

Each spec carries the same sections:

1. Goal and success test. One sentence each. The success test is something that can be run or looked at.
2. Scope and non-goals. What is in, and what is deliberately left out.
3. Constraints. The hard rules from `CLAUDE.md` that bear on this work, named by number.
4. Design. What changes, file by file.
5. Acceptance criteria. A numbered list, each item checkable.
6. Risks and open questions.

## Index

| Spec | Covers | ADRs | Status |
|---|---|---|---|
| [presence.md](presence.md) | The session hook, keeping the local Cairn up, `cairn status` | 053 | agreed, not started |
| [sign-in-resilience.md](sign-in-resilience.md) | The refresh race and the credentials the CLI deletes | 054 | agreed, not started |
| [agent-navigation.md](agent-navigation.md) | The summary budget, walking the tree, MCP parity | 055, 058 | agreed, not started |
| [console-and-search-polish.md](console-and-search-polish.md) | The phone layout, results by page, and eight smaller faults | 056, 057 | agreed, not started |

All four come from the review of 2026-09-16, which is recorded in the owner's Cairn as "Cairn review 2026-09-16: fixes and improvements".
