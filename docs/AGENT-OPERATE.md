# Configuring and running Cairn: instructions for an agent

You are a coding agent, and the person you work with has a Cairn running: on this computer, on their own server, or on Azure. They want it changed, checked, updated, backed up, synced or fixed. This page is written for you. To install Cairn in the first place, follow `docs/AGENT-INSTALL.md` instead. The person-facing guides (`docs/LOCAL.md`, `docs/CLI.md`, `docs/DEPLOY-DOCKER.md`, `docs/DEPLOY-AZURE.md`) have more detail on each task. Why it works this way: ADR-019 and ADR-031.

A test checks this page against the code (`packages/cli/test/agent-guides.test.ts`): every setting the server, the CLI or the deploy files read is listed here, and every setting and `cairn` command named here exists. If it fails, the page is out of date.

## Rules

The rules of `docs/AGENT-INSTALL.md` apply here too. In short:

1. **Ask before you change anything.** Reading is fine: health checks, logs, `--dry-run`, `cairn` read commands. A change to settings, a deploy, a sync, an import, a restore or anything that costs money needs the person's yes first.
2. **Credentials stay with the person.** Never ask for a secret in the chat, never print one, never write one into a tracked file.
3. **Never read `deploy/azure/.cairn-deploy.env` or `deploy/docker/.env`.** When a secret in them must change, tell the person which line to edit, and they edit it.
4. **Find out which Cairn first.** Run `cairn instances`. If it lists instances, use their names with `--instance`. If not, ask for the address, and remember that without `CAIRN_URL` or `--instance` the CLI talks to `http://localhost:8787`.
5. **Check after every change,** with the check given for it, and stop on a failure. Read the matching "When something goes wrong" section of the person's guide and `docs/LESSONS.md` before improvising.
6. **Say what you deployed.** On Azure, `deploy/azure/deploy.sh` resolves whatever tag it is given to the digest that tag points at now, and deploys the digest, so a moved tag deploys and an unmoved one reports "no change to deploy" rather than pretending (ADR-047). Still name a version rather than `latest`, so the command records what you deployed, and read the script's output: it prints the digest, the image it replaced, and whether anything changed. On Docker there is no such resolution, so pin a version or a digest in `.env`.

## 1. Find out what is running

```
cairn instances
curl -s <address>/health
```

`/health` answers with `"status":"ok"`, the server's version, whether local trust or OAuth is on, and `semantic_search`: `ready`, `failed` with a reason, or `off`. A Cairn on Azure that was idle may take about 30 seconds to answer: wait, it is starting, not failing.

Where each kind runs, and where its settings live:

| Where | Settings | Logs | Started by |
|---|---|---|---|
| This computer | `cairn.config.json` at the repository root, then environment variables | the terminal running `pnpm dev` | the person, `pnpm dev` in the repository |
| Their own server | `deploy/docker/.env` (private), `deploy/docker/compose.yaml` | `docker compose logs --follow`, in `deploy/docker` | Docker, restarted on boot |
| Azure | `deploy/azure/.cairn-deploy.env` (private), given to `deploy/azure/deploy.sh` | `az containerapp logs show -g <group> -n <name> --follow` | Azure, on the first request after idle |

## 2. Settings

Environment variables override `cairn.config.json`. On Azure, settings are environment variables for `deploy/azure/deploy.sh`, which keeps the secret ones in its private file; running it again applies a change. On Docker, they go in `.env`, and `docker compose up -d` applies a change.

A setting that is wrong stops the server with a message naming the setting and the fix. Read it before anything else.

### The server

| Setting | Default | What it does |
|---|---|---|
| `CAIRN_CONFIG` | `cairn.config.json`, found from the working folder | Another config file |
| `CAIRN_DB` | `cairn.sqlite` beside the config; `/data/cairn.sqlite` in the image | The database file |
| `CAIRN_HOST` | `127.0.0.1`; `0.0.0.0` in the image | Where it listens. Anything but loopback requires OAuth, and turns local trust off |
| `CAIRN_PORT` | `8787` | The port |
| `CAIRN_WORKSPACE` | `ws_default` | The workspace id. Leave it alone: ids in exports and sync state depend on it |
| `CAIRN_TRUST_LOCAL` | `true` | On loopback, requests from this machine need no sign-in (ADR-010). `false` requires `CAIRN_TOKEN` even here |
| `CAIRN_TOKEN` | none | A service token, at least 16 characters on loopback and 32 elsewhere, for scripts that cannot sign in |
| `CAIRN_PUBLIC_URL` | none | The HTTPS address people reach it at. Needed for OAuth |
| `CAIRN_AUTH_PROVIDER` | `github` | `github`, or `oidc` for Entra ID, Google and others |
| `CAIRN_OIDC_ISSUER` | none | The OpenID Connect issuer, for `oidc` |
| `CAIRN_OAUTH_CLIENT_ID` | none | From the OAuth app. The person tells you; it is not secret |
| `CAIRN_OAUTH_CLIENT_SECRET` | none | Secret. The person puts it in the private file |
| `CAIRN_ALLOWED_USERS` | none | Who may sign in, comma-separated: `github:login`, `email:you@example.com`, `oidc:<subject>` |
| `CAIRN_AUTH_SECRET` | generated by `deploy.sh` | Secret. Signs tokens; changing it signs everyone out |
| `CAIRN_AUTH_SECRET_PREVIOUS` | none | The old signing secret during a rotation (section 8) |
| `CAIRN_EMBEDDINGS` | `local` | `off` for keyword search only, saving about 300 MB of memory (ADR-022) |
| `CAIRN_MODELS` | `~/.cache/cairn/models`; in the image, the model it ships | Where the embedding model is kept |
| `CAIRN_MODEL_DOWNLOAD` | `true`; `false` in the image, which ships the model | `false` never downloads the model; search by meaning then stays off unless it is already there |
| `CAIRN_VECTOR_MARGIN` | `0.065` | How far a match by meaning must stand out from its neighbours to count (ADR-022). Change it only with `pnpm eval` before and after |
| `CAIRN_CONTENT_LICENCE` | none | The licence shown on published pages, such as `CC BY 4.0` (ADR-032). It covers the owner's text, not Cairn's code |
| `CAIRN_NAME` | `Cairn` | The name this Cairn gives itself at `/.well-known/cairn.json` (ADR-034) |
| `CAIRN_DESCRIPTION` | none | A sentence describing this Cairn, at `/.well-known/cairn.json` |
| `CAIRN_LANGUAGE` | `en` | The language tag it reports at `/.well-known/cairn.json` |
| `CAIRN_TOPICS` | none | What it is about, comma-separated, at `/.well-known/cairn.json` |
| `CAIRN_REPLICA_URL` | set by the Azure template; none on Docker | Where Litestream streams the database: `abs://` on Azure, `s3://` elsewhere. With an empty data folder, Cairn restores from it on start |

### Docker only

| Setting | Default | What it does |
|---|---|---|
| `CAIRN_BIND` | `127.0.0.1` | The host address the port is published on. `0.0.0.0` when the proxy runs on another machine |
| `CAIRN_DATA` | `./data` | The host folder holding the database |
| `CAIRN_IMAGE` | `ghcr.io/vespassassina/cairn:latest` | The image. Pin a version |

### Azure only, read by `deploy/azure/deploy.sh`

| Setting | Default | What it does |
|---|---|---|
| `CAIRN_RG` | `cairn` | The resource group |
| `CAIRN_LOCATION` | `swedencentral` | The region. Part of the address, so awkward to change later |
| `CAIRN_NAME` | `cairn` | The app's name. Part of the address too |
| `CAIRN_IMAGE` | `ghcr.io/vespassassina/cairn:latest` | The image. A tag is resolved to its current digest before deploying (ADR-047); `latest` is the newest release, `edge` the newest commit on `main` |
| `CAIRN_SERVICE_TOKEN` | none | Secret. Becomes the server's `CAIRN_TOKEN` |
| `CAIRN_IDLE_MINUTES` | `30` | Minutes without a request before it stops; the next request waits for it to start |
| `CAIRN_ALWAYS_ON` | `false` | `true` never stops, so no cold starts, for a few dollars a month |

### The CLI

| Setting | Default | What it does |
|---|---|---|
| `CAIRN_URL` | the first registered instance that answers, else `http://localhost:8787` | Which Cairn. Wins over instances |
| `CAIRN_TOKEN` | none | A service token. Wins over `cairn login` |
| `CAIRN_CREDENTIALS` | `~/.config/cairn/credentials.json`, or `%APPDATA%\cairn\credentials.json` on Windows | Where sign-ins are kept. `instances.json`, sync state and logs live beside it |
| `CAIRN_AGENT` | `claude-code` inside Claude Code | The agent name shown on writes in history |

`XDG_CONFIG_HOME`, when set, moves the default credentials folder on Linux and macOS.

## 3. Check it is healthy

1. `curl -s <address>/health` prints `"status":"ok"`.
2. On a server with OAuth, `curl -s -o /dev/null -w '%{http_code}\n' -X POST <address>/mcp` prints `401`: it refuses anyone not signed in.
3. `cairn overview` (with `--instance` or `CAIRN_URL`) lists collections and tables. If it says to sign in, the person runs `cairn login --instance <name>` or `CAIRN_URL=<address> cairn login`; it opens their browser.
4. `cairn changes` shows recent writes, newest first, and who made them.
5. The logs, from section 1, show no restarts or errors.

## 4. Update

Ask first. Tell the person what the new version brings, from `docs/CHANGELOG.md`.

1. **This computer:** in the repository, `git pull`, `pnpm install`, `pnpm build`, then restart `pnpm dev`. The database migrates itself on start.
2. **Their own server:** set `CAIRN_IMAGE` to the version in `deploy/docker/.env` (the person edits it), then `docker compose pull && docker compose up -d`.
3. **Azure:** `CAIRN_IMAGE=ghcr.io/vespassassina/cairn:<version> deploy/azure/deploy.sh`, or `:edge` for the newest commit on `main`, or `@sha256:<digest>` for one exact build. The script prints the digest it resolved, the image it is replacing, and, when nothing changed, that nothing changed. Check with `az containerapp list --query "[].properties.template.containers[0].image" -o tsv`, which now answers with a digest.
4. **The CLI:** `docs/CLI.md`, "Update it". `cairn -V` says which version is installed.

Then run the checks in section 3. Keep server and CLI on the same release where you can; a newer CLI works with an older server, and where a feature needs the newer server (such as edit times in sync, ADR-030) it falls back to the older behaviour.

## 5. Several Cairns, kept in sync

Commands in `docs/CLI.md`, "Keep two Cairns the same" and "Several Cairns as one" (ADR-023, ADR-029, ADR-030).

1. **Register each copy once,** in the person's order, the one to use first first: `cairn instances add laptop http://localhost:8787 --start "pnpm --dir <repository> dev"`, then `cairn instances add azure <address>`. Then `cairn login --instance azure`.
2. **Sync, always dry run first:** `cairn sync --dry-run`, then `cairn sync`. With instances registered, it syncs them all through the first that answers. `cairn sync <a> <b>` syncs one pair.
3. **On a schedule:** `cairn sync install --every 1h`, after asking; it installs a launchd, systemd or Task Scheduler job. `cairn sync uninstall` removes it. Syncing more often than `CAIRN_IDLE_MINUTES` keeps a Cairn on Azure awake, which costs more.
4. **Starting the day:** `cairn start` starts the first instance if it is down and syncs.
5. **Reading a report.** `merged:` means both sides changed a record in different parts and both edits were kept. `conflict:` means both changed the same part, and the newer edit won; the other is in that record's history, and `cairn history <page-id>` shows it. Tell the person about every conflict.

## 6. Back up and restore

1. **An export anyone can read:** `cairn export <folder>` writes Markdown and JSON (ADR-016). Suggest one before any update, restore or removal.
2. **Azure:** Litestream streams every change to the storage account. Nothing to do; a new container restores from it.
3. **Their own server:** the `data` folder, with the machine's own backups, and optionally `CAIRN_REPLICA_URL` for a copy off the machine.
4. **Restore from an export:** `cairn import <folder> --dry-run`, then without `--dry-run`, into any Cairn. It keeps ids, and running it twice changes nothing.
5. **Undo one change:** every write is a revision (ADR-008). `cairn history <page-id>` lists them, and the person restores one in the console.

## 7. Publishing a wiki

Cairn is private by default. A page the owner publishes, and every page under it, is served read-only at `<address>/w/<page-id>` with no sign-in, along with `/sitemap.xml` and `/robots.txt` (ADR-032).

1. **You cannot publish.** MCP has no tool for it, by design. Tell the person to open the page in the console and use Publish, or to run `cairn publish <page-id> --version V` themselves.
2. **It publishes downwards.** Publishing a collection publishes the wiki beneath it. To take part of it down, make that page private, or move it out.
3. **It belongs to one server.** Publication never travels with `cairn sync`, export or import, so publishing on a laptop publishes nothing on Azure. Whoever wants it public on Azure publishes it there.
4. **The licence** shown on published pages comes from `CAIRN_CONTENT_LICENCE`. Without it, no licence is shown.
5. **Before suggesting it,** check what is under the page: everything below it becomes readable by anyone.

## 8. Access and secrets

The person edits the private files; you run the script or compose afterwards.

1. **Let someone in:** add their entry to `CAIRN_ALLOWED_USERS` and deploy again. The page that turns a person away shows the exact entry to add.
2. **A token for a script:** the person sets `CAIRN_SERVICE_TOKEN` (Azure) or `CAIRN_TOKEN` (Docker) to the output of `openssl rand -hex 32`, in the private file.
3. **Rotate the signing secret:** the person moves `CAIRN_AUTH_SECRET` to `CAIRN_AUTH_SECRET_PREVIOUS` and empties `CAIRN_AUTH_SECRET`; running `deploy.sh` generates a new one. Tokens signed with the old one work until they expire.
4. **Sign the CLI out:** `cairn logout --instance <name>`.

## 9. Cost, on Azure

1. It costs nothing to a few cents a month within the free grants while it sleeps most of the day.
2. Anything that wakes it counts: people, Claude, and `cairn sync`. A sync job every hour keeps it up about half the time; every 30 minutes or less, all the time.
3. `CAIRN_ALWAYS_ON=true` removes cold starts for a few dollars a month. Say so before setting it.
4. **Remove everything:** `az group delete --name <group>` deletes the database too. Only on the person's explicit request, after an export.

## 10. When something goes wrong

1. **Read the message.** Cairn's errors name the setting, command or step that fixes them. Do what it says before anything else.
2. **Then the person's guide:** "When something goes wrong" in `docs/DEPLOY-AZURE.md` or `docs/DEPLOY-DOCKER.md`, and `docs/LESSONS.md`.
3. **Common cases:**
   1. `cairn` says it cannot reach the server: it is not running (start it, or `cairn start`), or on Azure it is starting; try again in a minute. If it is still unreachable after that, go to case 6 rather than waiting longer.
   2. `cairn login` says the address needs no sign-in: it tried localhost because no Cairn was named. Use `--instance` or `CAIRN_URL`.
   3. A write fails with a version conflict: someone changed the record since it was read. Read it again, merge, and retry with the new version.
   4. `semantic_search` says `failed`: keyword search still works. The reason names the cause, usually memory or the model download.
   5. An MCP client or the CLI is suddenly asked to sign in again: the sign-in was revoked, not expired. A refresh token used twice ends the whole sign-in, and after a minute's grace that is what it means (ADR-033). Sign in again, and if it keeps happening say so: it points at something replaying tokens, or a database restored to an earlier point.
   6. The address answers 502, 503 or 504, or nothing at all, for more than a couple of minutes: the request is not reaching Cairn, so the reason is in the container's log and nowhere else. Read it: on Azure, `az containerapp logs show -n <app> -g <group> --tail 50`; with Docker, `docker compose logs --tail 50`. Do not trust the platform's own health here, because an Azure container app reports "Running" and "Healthy" whether or not the program inside it started (`docs/LESSONS.md`, 2026-09-16). If the log says the replica cannot be read back, Cairn has stopped on purpose rather than serve a database it could not verify (ADR-046); the log lists what the replica holds and the exact commands for the three ways out. Never redeploy from empty to clear it until you are certain no other Cairn holds a newer copy, because the first write overwrites the replica.
4. **If the fix is not in the docs,** tell the person what you saw, and do not change code or cloud resources unasked. Afterwards, suggest a `docs/LESSONS.md` entry, so the next agent finds it.

## 11. Hand over

Finish with what you checked, what you changed and how to undo it, anything that failed, and anything in this page that was wrong or unclear, so the owner can fix it.
