# CLAUDE.md

Project context for Claude Code. Read this first, then `docs/PRD.md`.

## Asked to install, deploy, configure or run Cairn?

To install or deploy it, follow `docs/AGENT-INSTALL.md`; for anything with a Cairn already running (settings, health, updates, sync, backups, access, troubleshooting), follow `docs/AGENT-OPERATE.md`. Use them instead of the rest of this file. Ask the person before changing anything, keep their credentials out of the chat, and never read `deploy/azure/.cairn-deploy.env` or `deploy/docker/.env` (ADR-019, ADR-031). The rest of this file is for working on Cairn's code.

## What this is

Cairn (working name): a source-available, self-hosted wiki and table store where Claude is the primary client through MCP. Web editor comes second. Runs as one small container: on the person's own server, or within a cloud's free grants (ADR-020).

## Current phase

Phase 0 is done apart from the eval set (spike S1 was dropped by ADR-020). Phase 1 (MCP only, used daily) is under way locally. Live status is in `docs/ROADMAP.md`.

Do not write editor code until Phase 1 passes its gate (see PRD section 14). The one exception is the review console (ADR-009), a server-rendered screen for reviewing, navigating, editing and restoring. Keep it inside the scope limits that ADR sets: no rich editor, no table views beyond a plain table, no client-side application.

## Documentation discipline

Track every change, decision and design direction. Never lose the what or the why. Cairn is public and source-available (ADR-015), so write for a reader who was not in the conversation. `docs/README.md` maps the docs.

The four logs, each updated in the same commit as the work:

1. `docs/DIRECTIONS.md`: every instruction or design direction the owner gives, in their words where they carry the intent, with where it landed.
2. `docs/decisions/`: the ADRs.
3. `docs/CHANGELOG.md`: what changed and why.
4. `docs/LESSONS.md`: every failure (bugs, broken tooling, wrong assumptions, the agent's own mistakes) with its cause, fix and lesson.

Rules:

1. Every meaningful change gets an entry in `docs/CHANGELOG.md` in the same commit: what changed, and why. A change of direction gets an entry even when no code changed.
2. A decision that constrains future work gets an ADR in `docs/decisions/`, added to the index in `docs/decisions/README.md`. A decision that changes is superseded by a new ADR, never edited away.
3. Keep the living docs aligned in the same commit as the code: `docs/PRD.md` (what and for whom), `docs/ROADMAP.md` (status), `docs/ARCHITECTURE.md` (the current shape), `docs/LOCAL.md` (how to run it), and this file.
4. When a doc and the code disagree, that is a bug. Fix whichever is wrong, and say which in the changelog.
5. Record findings as well as decisions: a spike result, a surprising library behaviour, a probe of search quality. They are the evidence decisions rest on.
6. When the owner gives a new instruction, log it in `docs/DIRECTIONS.md` before or with the work it starts.
7. When something fails and gets fixed, add a `docs/LESSONS.md` entry before committing. Read that file before repeating a kind of task it covers.
8. The MCP server instructions (`packages/api/src/mcp/instructions.ts`), the workspace summary that follows them (`summary.ts`) and the skill (`skills/cairn/SKILL.md`) change agent behaviour, and must say the same things. Changing any of them needs a changelog entry saying why (ADR-011, ADR-012, ADR-013), and a fresh `pnpm context-cost` if the README numbers move. Stored text in the summary is untrusted and must stay quoted and bounded.

## Workflow

Commit directly to `main` and push once a change is done and verified. No branches or pull requests: the owner's direction of 2026-09-13 ("disable PRs and just keep committing"). CI runs on every push, so the checks under "Verification before calling a task done" still come first. Tags and releases are outward-facing: ask before making one.

## Stack

1. TypeScript, Node 22, pnpm workspaces
2. Hono for the API and MCP server, on Node, shipped as one container (ADR-020). Functions and Lambda are not targets.
3. Official MCP TypeScript SDK, streamable HTTP transport
4. Vitest for tests
5. Later: React plus BlockNote for the editor

## Repo layout (target)

```
packages/
  core/          domain logic, adapter interfaces, no cloud SDKs
  adapter-sqlite/   documents, FTS5 search, sqlite-vec vectors (ADR-022)
  adapter-embeddings-local/  the in-process English embedding model (ADR-022)
  adapter-cosmos/   (optional, only on an ADR-020 trigger)
  adapter-dynamo/   (optional, same)
  api/           Hono app: MCP, REST at /api/v1, review console
  cli/           the `cairn` command, a thin HTTP client (ADR-013), with sync between Cairns (ADR-023, ADR-029)
  web/           (Phase 2)
deploy/
  docker/        compose file for your own server, database on a mounted volume (ADR-020)
  azure/         Bicep template and deploy.sh (ADR-018)
  aws/           (P1)
docker/          the container's start script (Litestream, ADR-018)
Dockerfile       the server image, published to ghcr.io by CI
skills/
  cairn/         the skill file that tells a coding agent how to use the CLI
scripts/         artifactkit sync, CLI build (build-cli.mjs) and smoke test
.github/
  workflows/     CI on Linux, macOS and Windows; CLI release on a tag
eval/
  queries.yaml
docs/
  PRD.md
  decisions/
```

## Hard rules

1. No cloud SDK imports outside `adapter-*` packages. `core` must build with zero cloud dependencies.
2. Every adapter passes the shared conformance suite in `core/test/conformance`. No adapter-specific branches in business logic.
3. Every write uses optimistic concurrency via version tokens.
4. The chunks store is separate from pages from day one. The vector container is created when embeddings are enabled, never at deploy.
5. Optional services (embeddings) degrade to keyword mode with a `mode` flag. They never throw into the core path, and never run on the write path: vectors are computed in the background (ADR-022).
6. Every MCP tool truncates to a token budget and returns a cursor when it does.
7. No search change merges without running `pnpm eval` and recording before and after recall@5 in the PR description, per search backend.
8. Search is a separate adapter from the document store. Never assume one backend provides both (ADR-005).
9. Pages and rows are the source of truth. Edges and chunks are derived, written only through an idempotent `replaceForSource`, and must survive a full rebuild unchanged.
10. No transactions across documents. Write the page, then its derived data, and make the gap recoverable.
11. Derived reads (backlinks, neighbours, search) are eventually consistent. Tests poll to the 10 second bound, they never read once straight after a write.
12. Table filtering runs in core. Pushdown is an optional adapter capability that must produce identical results.
13. Route handlers use web standard `Request` and `Response`. Platform-specific code lives only in `api/src/entry/*` (ADR-006).
14. MCP, REST and the CLI translate; they never decide (ADR-013). Logic two surfaces need, such as edit modes and error mapping, lives in `api/src/operations.ts`. A capability added to one surface is added to the others, or the ADR says why not.
15. The CLI talks HTTP only. It never opens the database.
16. The CLI runs on Node from npm and on Bun as a compiled executable (ADR-014). Its code uses only `fetch`, Web Crypto, `node:util` `parseArgs`, `node:fs/promises`, `node:path`, `node:os`, `node:http` (the `cairn login` listener), `node:child_process` (opening the browser) and `process`. Anything else needs checking on both, and `pnpm smoke:cli` must pass.
17. Never put a raw control character in a source file. Write separators and escapes so the file stays plain text (see `docs/LESSONS.md`).
18. Secrets come only from the environment, never from `cairn.config.json` or any tracked file. On a non-loopback bind, local trust is always off and OAuth is required (ADR-017).
19. An install, configuration or operation step changes in the person's guide and in `docs/AGENT-INSTALL.md` or `docs/AGENT-OPERATE.md` in the same commit (ADR-019, ADR-031). A new `CAIRN_` setting is described in `docs/AGENT-OPERATE.md`; `packages/cli/test/agent-guides.test.ts` fails until it is.

## Verification before calling a task done

1. `pnpm build` and `pnpm test` pass
2. Conformance suite passes for every adapter touched
3. New MCP tools, REST endpoints and CLI commands have a contract test with a realistic payload
4. PRD or an ADR updated if behaviour changed
5. `docs/CHANGELOG.md` has an entry saying what changed and why, and `docs/ROADMAP.md` reflects the new status
6. New owner directions are in `docs/DIRECTIONS.md`, and failures met along the way are in `docs/LESSONS.md`

## Coding style

Write like the surrounding code: its naming, comment density and idiom. Beyond that, one rule the owner set on 2026-09-14 (ADR-031): the code guides whoever uses it, as much as it can, "even when the user is an agent".

1. **Every error is the best one we can write.** It says what happened, why when that is not obvious, and the exact next step: the command, flag or setting that fixes it. "X failed" alone is a bug.
2. **Say when a default was used.** When the code acted on a default the person did not choose, such as the CLI talking to localhost because no server was named, the error that follows says so and how to choose.
3. **Sensible defaults over required settings.** Require a setting only when no default is safe, and then name it in the error.
4. **Write for agents too.** Exact setting names and commands they can run, stable fields in API errors, nothing that depends on seeing a screen.
5. **An error that misled someone is a bug:** fix it, test the message, and add a `docs/LESSONS.md` entry.

## Writing style for docs

Plain, direct, short paragraphs. No em dashes. Sentence case headings. Numbered lists over dash bullets.

## Open questions that block work

See PRD section 13. Q7 (free tier facts) must be verified with a real deployment. Q1 and Q8 matter only if the optional Cosmos adapter is built (ADR-020). Q2 and Q3 are answered by ADR-005 and ADR-007.

## Decisions

Read `docs/decisions/` before changing architecture. ADR-005 (adapter boundary), ADR-006 (runtime and transport) and ADR-007 (auth) define most of the constraints above.
