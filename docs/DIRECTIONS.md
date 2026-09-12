# Owner directions

The instructions and design directions the project owner has given, in the order they were given, with where each one landed. Newest first.

Why this exists: most of Cairn is built with an AI agent, working from short instructions. The ADRs record the decisions that came out of them and the changelog records the work, but neither keeps the original ask. Without it, a reader cannot tell a choice the owner made from one the agent made while filling in the gaps. This log keeps that line visible.

Rules:

1. One entry per direction, logged in the same commit as the work it started. A direction that changed nothing yet still gets an entry.
2. Quote the owner's words where they carry the intent, lightly cleaned for typos. Otherwise summarise, and say it is a summary.
3. Every entry says where it landed: an ADR, a doc, a commit, or "not yet".
4. A later direction that reverses an earlier one does not edit it. Add the new one and point back.

## 2026-09-12

### Use Cairn from every session, and advertise what it holds

> "can we amend the main claude guide to use cairn when available? is cairn advertising the topics/projects it holds?"

Landed in:

1. The owner's global Claude Code instructions (outside this repo): a short section saying to check Cairn before answering on topics with history, save what lasts, never store secrets, and carry on without it when the server is down.
2. Advertising topics: not yet. Cairn's instructions are fixed text today, so Claude does not know what Cairn holds until it searches. Proposed next, pending the owner's go-ahead.

### Keep logs of instructions, failures, lessons and decisions

> "we need to keep a log of instructions, failures and lessons learned. we need to keep a log of decisions. this will be open source so it needs to be properly documented"

Landed in:

1. This file, for instructions.
2. `docs/LESSONS.md`, for failures and lessons, backfilled from the start of the project.
3. `docs/decisions/`, which already held the decisions.
4. `docs/README.md`, a map of which document answers which question.
5. CLAUDE.md, whose documentation discipline now names all four logs.

### Tell Claude when to use Cairn, and make it run

> "add server instructions then check why i cannot run it, i tried it returns an error and adding mcp returns no mcp"

Landed in: ADR-011 (server instructions), and fixes logged in `docs/LESSONS.md` (port in use, IPv6 loopback, MCP added mid-session).

### What next, and is the MCP use automatic?

Summary: the owner asked whether to add the MCP server and whether Claude would use it on its own. The answer was that tools are available but not required, which led to the server instructions above.

Landed in: ADR-011.

### No token on localhost

> "when in localhost, can we skip the token? if domain is localhost or anything local (can be added to a config file) not auth required"

Landed in: ADR-010, `cairn.config.json`, commit `5d52bb8`.

### The console does not work at localhost

> "not working at localhost"

Landed in: launcher and database path fixes, `docs/LESSONS.md`, commit `5d52bb8`.

### Commit the work

> "Commit the working tree changes with a sensible message."

Landed in: commits from `1519596` onwards. Commits are made when the owner asks, not automatically.

### Track every change, decision and design direction

> "track all changes, decisions and design directions we take. let's never forget the what and the why. also keep the docs (blueprints, prd, roadmap etc) updated and aligned"

Landed in: `docs/CHANGELOG.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, and the documentation discipline section of CLAUDE.md. Commit `1519596`.

### Agents write without approval, and the console uses artifactkit

> "auto write, we are safe with versioning. we also add a small review screen. also the html on the server side should/could use my artifactkit for styling"

Landed in: ADR-008 (agents write directly, every write is a revision) and ADR-009 (review console, styled with artifactkit).

### A small server-side interface, wiki-like, versioned

> "it would be nice to have a small interface serverside to review, navigate, edit and add content. what would be the ideal UI here? wikilike? always in read mode and a button to edit. versioned records (applies to agents too)."

Landed in: ADR-008 (revisions for pages and rows, for every actor) and ADR-009 (read mode by default, Edit button, no rich editor).

## 2026-09-11

### Seed with the peptide wiki

Summary: the owner named their peptide wiki folder as the real content to test with.

Landed in: `examples/peptide-wiki`, a seed script that reads the wiki's source JSON rather than its HTML, because the HTML pages are filled in by JavaScript and carry little static text. Commit `ed2f1f3`.

### A quick local PoC

> "plan for a quick PoC version to run locally and start testing features"

The owner chose Claude Code as the first client, and content imported from a real folder of Markdown.

Landed in: the local PoC (commit `d9419b6`) and `docs/LOCAL.md`.

### The adapter architecture: six directions

The owner asked whether an adapter architecture could deploy to AWS, Azure or local while keeping the free tiers, then settled it:

> "1 - split adapters. search and storage. 2 - ok - derived data can always be rebuilt 3 - agreed no transaction across docs, imply eventual consistency 4 - agreed, collections queries in core and a flag to pushdown to the database. 5 - we need to settle for the lowest common denominator of the 2. if hono solves and is available for both, let's use it? 6 - yes, but let's keep it small. update the docs then start building"

Landed in:

1. Directions 1 to 4: ADR-005 (adapter boundary).
2. Direction 5: ADR-006 (Hono, stateless MCP transport, lowest common denominator).
3. Direction 6: ADR-007 (one small OAuth server in front of any OIDC provider).

### Project Cairn: memory for the agents

> "Project Cairn - memory for the agents"

The first build session, working from the PRD below. The owner then pointed the session at this repository's folder.

Landed in: the repository.

## 2026-09-10

### Design discussion: PRD v0.1

Summary: before the build sessions, the owner framed Cairn as memory for AI agents: a self-hosted document and collection store with Claude as the primary client over MCP, deployable to Azure, AWS or a single container while staying within free tiers. The original wording of that discussion was not kept; the PRD is the record.

Landed in: `docs/PRD.md` v0.1 and ADR-001 to ADR-004.
