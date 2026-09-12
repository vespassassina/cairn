# Running Cairn locally

The PoC: one Node process, one SQLite file, the MCP server on loopback. No
token on localhost, no cloud account, no OAuth, no tunnel.

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

It listens on 127.0.0.1 and ::1, so `localhost` works whichever one a client picks.

If it says port 8787 is already in use, Cairn is probably running already, perhaps started by an agent or another terminal. Open the health URL above to check, or find the process with `lsof -nP -iTCP:8787 -sTCP:LISTEN`. To use another port, set `port` in `cairn.config.json`.

## 5. Connect Claude Code

```
claude mcp add --transport http --scope user cairn http://localhost:8787/mcp
```

1. `--scope user` makes Cairn available in every project, which is what memory needs. Without it, the server is added for the current folder only.
2. No header is needed on localhost. If you turned local trust off, add `--header "Authorization: Bearer $CAIRN_TOKEN"`.
3. Start a new Claude session. A session loads MCP servers when it starts, so one that was already open will not see Cairn.
4. `claude mcp list` shows whether the server is reachable. It needs `pnpm dev` running; without it, Claude carries on without Cairn.

Then ask Claude to search for something you know is in your notes. The tools
available are the nine in PRD section 8, plus `create_collection`,
`get_history` and `get_revision`.

You do not have to ask Claude to use Cairn every time. Cairn sends short server instructions when a session connects: search before answering, save lasting findings without being asked, prefer updating an existing page, and give every write a change note (ADR-011). They end with a summary of what Cairn holds, such as its collections, top-level pages and common tags, so Claude knows which topics to look for there (ADR-012). The summary is built when a session connects, so restart the session to see new top-level pages in it. To point Claude at specific topics, add a line to your own CLAUDE.md, for example "the peptide wiki lives in Cairn".

The first time Claude calls each tool, Claude Code asks for permission. To allow them all, add `mcp__cairn__*` to the allow list in your Claude Code settings.

Every write is kept as a revision with who made it and why (ADR-008), so an
agent edit can always be undone.

## 5b. Or connect a coding agent with the CLI

Agents with a shell, such as Claude Code, can use the `cairn` command instead of MCP. It costs about 115 tokens per session instead of about 2,700, because nothing loads until the agent runs it (ADR-013; `pnpm context-cost` measures it).

Build it and put it on your PATH:

```
pnpm build
npm install -g ./packages/cli
```

Install the skill, which tells Claude Code when and how to use it:

```
mkdir -p ~/.claude/skills && cp -r skills/cairn ~/.claude/skills/
```

Then try it:

```
cairn overview
cairn search tendon healing
cairn --help
```

1. `CAIRN_URL` points it at another server; the default is http://localhost:8787. `CAIRN_TOKEN` is sent as a bearer token when set.
2. Writes are attributed to `cairn-cli/0.1.0`, with `(claude-code)` added when run from Claude Code, so the console shows them as agent writes.
3. Without installing it, `pnpm cairn <command>` runs it from the repo.
4. Use one door per agent, not both: an agent with both the MCP server and the skill pays for both.

The same operations are on the REST API at `/api/v1`, with version tokens as `ETag` and `If-Match`. `GET /api/v1/changes?since=<time>` lists what changed since a given time, for scripts and other agents.

## 6. Review in the console

Open http://localhost:8787. There is no sign-in on localhost. The home page lists recent changes, newest first; "Agents only" shows what Claude wrote. Every page has Edit and History, and any version can be restored.

## Other commands

```
pnpm rebuild   regenerate every edge and chunk, and sweep stray revisions
pnpm eval      run eval/queries.yaml and report recall@5
pnpm test      unit, conformance, MCP, REST, CLI and console contract tests
pnpm cairn     run the CLI from the repo, for example: pnpm cairn search firmware
pnpm context-cost   what MCP and the CLI cost an agent's context, per session
pnpm sync:artifactkit   re-embed artifactkit after changing it, then commit
```

Run `pnpm rebuild` after changing chunking, and `pnpm eval` before and after
any search change (CLAUDE.md hard rule 7).

## What is not here yet

OAuth, Cosmos, AWS, the web editor, embeddings, attachments and export. None of
them is needed to answer the question this PoC exists for: do you actually
reach for this from Claude four days a week (PRD section 10).
