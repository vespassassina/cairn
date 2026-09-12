# Running Cairn locally

The PoC: one Node process, one SQLite file, the MCP server on loopback with a
static bearer token. No cloud account, no OAuth, no tunnel.

## 1. Install

Node 22 or later.

```
corepack enable
pnpm install
```

## 2. Configure

Cairn reads its configuration from the environment and refuses to start if
anything is unsafe. Put this in a `.env` you source, or export it in your
shell.

```
export CAIRN_TOKEN=$(openssl rand -hex 24)
export CAIRN_DB=$HOME/cairn/cairn.sqlite
```

Optional: `CAIRN_PORT` (default 8787), `CAIRN_HOST` (default 127.0.0.1),
`CAIRN_WORKSPACE` (default ws_default).

Two rules are enforced at startup rather than documented and hoped for.

1. `CAIRN_TOKEN` must be at least 16 characters.
2. `CAIRN_HOST` must be loopback. Dev mode has no real auth, so binding it to a
   public interface would put an unauthenticated write API on the network.

## 3. Load content

Search quality only means something against real pages. Point the import at a
folder of Markdown: one page per file, folders becoming the page hierarchy.

```
pnpm import ~/notes
```

Re-running it updates the same pages rather than duplicating them, because the
page id is derived from the file path.

## 4. Start

```
pnpm dev
```

Check it:

```
curl http://127.0.0.1:8787/health
```

## 5. Connect Claude Code

```
claude mcp add --transport http cairn http://127.0.0.1:8787/mcp --header "Authorization: Bearer $CAIRN_TOKEN"
```

Then ask Claude to search for something you know is in your notes. The tools
available are the nine in PRD section 8, plus `create_collection`,
`get_history` and `get_revision`.

Every write is kept as a revision with who made it and why (ADR-008), so an
agent edit can always be undone.

## Other commands

```
pnpm rebuild   regenerate every edge and chunk, and sweep stray revisions
pnpm eval      run eval/queries.yaml and report recall@5
pnpm test      unit, conformance and MCP contract tests
```

Run `pnpm rebuild` after changing chunking, and `pnpm eval` before and after
any search change (CLAUDE.md hard rule 7).

## What is not here yet

OAuth, Cosmos, AWS, the web editor, embeddings, attachments and export. None of
them is needed to answer the question this PoC exists for: do you actually
reach for this from Claude four days a week (PRD section 10).
