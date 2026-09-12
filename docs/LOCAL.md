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

Nothing is required. On localhost Cairn needs no token (ADR-010).

Settings live in `cairn.config.json` at the repo root, which is committed and holds no secrets:

```
{
  "database": "cairn.sqlite",
  "port": 8787,
  "auth": {
    "trustLocal": true,
    "localHosts": []
  }
}
```

1. `database` is resolved relative to the config file.
2. `auth.localHosts` adds host names to trust, such as a name you mapped to 127.0.0.1 in `/etc/hosts`. Only add names that always point at this machine.
3. `auth.trustLocal: false` requires `CAIRN_TOKEN` for every request, even on localhost.

Environment variables override the file: `CAIRN_DB`, `CAIRN_PORT`, `CAIRN_WORKSPACE`, `CAIRN_TRUST_LOCAL`, `CAIRN_TOKEN`, and `CAIRN_CONFIG` for a different config file.

Dev mode still refuses to bind anything but loopback, whatever the settings say.

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
curl http://localhost:8787/health
```

## 5. Connect Claude Code

```
claude mcp add --transport http cairn http://localhost:8787/mcp
```

No header is needed on localhost. If you turned local trust off, add
`--header "Authorization: Bearer $CAIRN_TOKEN"`.

Then ask Claude to search for something you know is in your notes. The tools
available are the nine in PRD section 8, plus `create_collection`,
`get_history` and `get_revision`.

Every write is kept as a revision with who made it and why (ADR-008), so an
agent edit can always be undone.

## 6. Review in the console

Open http://localhost:8787. There is no sign-in on localhost. The home page lists recent changes, newest first; "Agents only" shows what Claude wrote. Every page has Edit and History, and any version can be restored.

## Other commands

```
pnpm rebuild   regenerate every edge and chunk, and sweep stray revisions
pnpm eval      run eval/queries.yaml and report recall@5
pnpm test      unit, conformance, MCP and console contract tests
pnpm sync:artifactkit   re-embed artifactkit after changing it, then commit
```

Run `pnpm rebuild` after changing chunking, and `pnpm eval` before and after
any search change (CLAUDE.md hard rule 7).

## What is not here yet

OAuth, Cosmos, AWS, the web editor, embeddings, attachments and export. None of
them is needed to answer the question this PoC exists for: do you actually
reach for this from Claude four days a week (PRD section 10).
