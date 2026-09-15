# Installing Cairn: instructions for an agent

You are a coding agent, and the person you work with wants Cairn installed or deployed. Follow this page from the top. Once it runs, `docs/AGENT-OPERATE.md` covers everything after: settings, health, updates, sync, backups, access and troubleshooting. It is written for you; the person-facing guides it links to (`docs/LOCAL.md`, `docs/CLI.md`, `docs/DEPLOY-DOCKER.md`, `docs/DEPLOY-PROXMOX.md`, `docs/DEPLOY-AZURE.md`, `docs/DEPLOY-AWS.md`, `docs/DEPLOY-GCP.md`) have more detail on each step. Why it works this way: ADR-019.

## Rules

1. **Ask before you act.** Cairn can run on this computer, on the person's own server (including Proxmox), on a VM on AWS or GCP, or on Azure. Never choose for the person.
2. **Credentials stay with the person.** Never ask for a password, client secret or token in the chat, never print one, and never write one into a file git tracks. Signing in to Azure and creating the OAuth app are the person's steps; you tell them exactly what to click and type.
3. **Never read `deploy/azure/.cairn-deploy.env` or `deploy/docker/.env`.** They hold secrets. The deploy script and Docker read them; you do not. Do not `cat`, open, grep or print them.
4. **Check every step** with the command given, and stop on a failure. Read the matching section of the person's guide and `docs/LESSONS.md` before trying anything else. Do not improvise cloud resources.
5. **Change nothing else.** Do not edit Cairn's code, commit, push, or delete Azure resources unless the person asks.
6. **Say what costs money** before running anything that creates cloud resources, and get a yes.

## 1. Ask

Ask these together, in one message:

1. **Where should Cairn run?**
   1. **On this computer.** Free, private, set up in five minutes. Only agents on this machine can use it, and only while it runs.
   2. **On their own server,** such as a Proxmox VM or container, or a NAS, with Docker. The database stays on that machine's disk. Needs an HTTPS address in front of it: a reverse proxy, Cloudflare Tunnel or Tailscale. About twenty minutes.
   3. **On Azure.** Reachable from anywhere, including Claude on the web and phone. Needs an Azure subscription; costs nothing to a few cents a month within the free grants. About fifteen minutes, with two steps the person does in a browser.
   4. **On a small VM on AWS or GCP,** the same Docker setup as their own server, just on a cloud machine (ADR-043). Reachable from anywhere. The person provisions the VM themselves, in their own account, following `docs/DEPLOY-AWS.md` or `docs/DEPLOY-GCP.md`; check current free-tier terms with them before they do, since these move over time. About twenty minutes on top of that, the same as 3b once Docker is running.
2. **Which Claude do you use?** Claude Code, Claude Desktop, Claude on the web, or several.
3. **Anything to bring in?** A folder of Markdown notes, or a folder from `cairn export`.

## 2. Check the prerequisites

Run these and report what is missing. Installing system software is the person's decision: offer the official link, and install only if they ask.

```
node --version
git --version
```

1. Node must be 22 or later: https://nodejs.org
2. Then enable pnpm, which Cairn uses: `corepack enable` (on some systems it needs an administrator shell).
3. For their own server: `docker compose version`, run on that server; if it is missing, give them https://docs.docker.com/engine/install/. The server itself needs neither Node nor pnpm: it runs the published image. For Azure: `az --version`; if it is missing, give them https://learn.microsoft.com/cli/azure/install-azure-cli.
4. On Windows, run every command in Git Bash.

On the computer you are running on, from the repository's root folder:

```
pnpm install
pnpm build
pnpm test
```

All three must pass. If `pnpm test` fails, stop and report the failing test names.

## 3a. On this computer

Human guide: `docs/LOCAL.md`.

1. **Bring content in, if they have some.** A Markdown folder: `pnpm import:markdown <folder>`. A Cairn export: do it after step 2, with `cairn import <folder>`.
2. **Start the server.** `pnpm dev` runs it in the foreground. Explain that Cairn is only available while this runs. Start it in the background for this session, and tell the person how to start it themselves next time.

   Say first: the first start downloads a 34 MB embedding model from Hugging Face into `~/.cache/cairn/models`, for search by meaning, which works for English text only (ADR-022). If they would rather not, start it with `CAIRN_EMBEDDINGS=off` for keyword search only.
3. **Check it:** `curl -s http://localhost:8787/health` must print `"status":"ok"`. Its `semantic_search` field says `ready` once the model has loaded, `failed` with a reason if it could not (keyword search still works), or `off`.
4. **Connect their Claude.**
   1. **Claude Code: use the CLI and skill** (about 115 tokens per session, against about 3,100 for MCP). Steps in `docs/CLI.md`: `pnpm build:cli host`, put the executable on the PATH, copy `skills/cairn` to `~/.claude/skills/`. Check with `cairn overview`.
   2. **Or MCP:** `claude mcp add --transport http --scope user cairn http://localhost:8787/mcp`, then a new session.
   3. **Claude Desktop or on the web** cannot reach a server on this computer. Suggest Azure if they need those.
5. **Prove it end to end,** with their permission: `cairn create --title "Cairn is connected" --note "Install check" --text "Written during setup."`. Ask them to open http://localhost:8787 and find it under recent changes.

## 3b. On their own server

Human guide: `docs/DEPLOY-DOCKER.md`. The steps run on the server. If you are not running on it, give the person each command to run there, and ask them to paste back the output (never the contents of `.env`).

1. **Ask how the HTTPS address will be provided:** a reverse proxy they already run, Cloudflare Tunnel, or Tailscale. Explain that Claude on the web and Desktop need an address reachable from the internet; Claude Code and the CLI on their own devices do not. Setting up the proxy or tunnel is theirs; point them to the guide's "The HTTPS address".
2. **Ask where the database should live.** Default: `deploy/docker/data`. On Proxmox, a folder on the VM's disk, or a host folder mounted into the container (guide, "On Proxmox"). Never an NFS or SMB share.
3. **Prepare the folder:** in `deploy/docker`, `mkdir data && sudo chown 1000:1000 data`, then `cp env.example .env && chmod 600 .env`. For an unprivileged Proxmox LXC with a host folder, the owner on the host is `101000:101000`.
4. **The person creates the OAuth app,** as in 3c step 6, with their HTTPS address as the homepage and that address plus `/oauth/callback` as the callback URL.
5. **The person fills in `.env`** in their own editor: `CAIRN_PUBLIC_URL`, the client id and secret, `CAIRN_ALLOWED_USERS=github:<login>`, and `CAIRN_AUTH_SECRET` from `openssl rand -hex 32`. You do not open the file. If the proxy is on another machine, they also add `CAIRN_BIND=0.0.0.0`.
6. **Start it:** `docker compose up -d`, then `docker compose logs`. The log must say `on a mounted volume`. If it says a setting is missing or a folder is not writable, the message names the fix.
7. **Check it,** on the server: `curl -s http://127.0.0.1:8787/health` must print `"status":"ok"`, and `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/mcp` must print `401`. Then the same health check through their HTTPS address.
8. **Connect, move content and prove it** as in 3c steps 9 to 12.

## 3d. On AWS or GCP

Human guide: `docs/DEPLOY-AWS.md` or `docs/DEPLOY-GCP.md` for the VM, then `docs/DEPLOY-DOCKER.md` for everything after Docker is running, the same as 3b.

1. **Provisioning the VM is the person's own step,** run from their own machine with their own cloud credentials, never yours to run for them. Say plainly what it will cost before they run anything: check current free-tier terms with them, since AWS and GCP have both changed theirs over time (the guides link to each cloud's current free-tier page). Give them the exact commands from the guide, one section at a time, and ask them to paste back the output.
2. **Once Docker is installed on the VM,** everything is exactly 3b: the HTTPS address, the folder and `.env`, the OAuth app, starting it, checking it, connecting, and proving it end to end. The only difference is which machine the commands run on.

## 3c. On Azure

Human guide: `docs/DEPLOY-AZURE.md`. Say first: this creates a resource group, a storage account and a container app in their subscription; within the free grants it costs nothing to a few cents a month; they can remove it all with one command.

1. **Sign in to Azure.** Ask the person to run `az login` themselves, in their own terminal. It opens a browser. Then check which subscription is active, and confirm it with them: `az account show --query "{name:name, id:id}" --output table`
2. **Ask about cold starts.** By default Cairn stops after 30 minutes idle, and the next request waits for it to start, up to half a minute. `CAIRN_IDLE_MINUTES` changes the wait; `CAIRN_ALWAYS_ON=true` removes cold starts for a few dollars a month (`docs/DEPLOY-AZURE.md`, "Cold starts"). If they will run `cairn sync --every`, tell them it keeps Cairn awake unless the interval is longer than the idle time.
3. **Choose a name and region.** Defaults: name `cairn`, region `swedencentral`, resource group `cairn`. The name and region become part of the address, and so of the OAuth callback URL, so they are awkward to change later. Ask if they want different ones. West Europe refused new subscriptions in September 2026; to check a region before deploying, run `az deployment group validate -g <any existing group> --template-file deploy/azure/main.bicep --parameters location=<region>`, which fails with "not accepting new customers" if it is closed to them.
4. **Check the image is published.** Should print `200`:

   ```
   token=$(curl -s "https://ghcr.io/token?scope=repository:vespassassina/cairn:pull" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
   curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $token" -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json" https://ghcr.io/v2/vespassassina/cairn/manifests/latest
   ```

   If it prints anything else, stop and tell the person: the image cannot be pulled, so the deployment would not start. `latest` is the newest release; `edge` follows `main` and is only for testing unreleased work.
5. **First pass.** Run `deploy/azure/deploy.sh`, with `CAIRN_NAME`, `CAIRN_LOCATION` and `CAIRN_RG` set if they chose other values. It prints the address and the callback URL. Give both to the person.
6. **The person creates the OAuth app.** For GitHub, tell them to open https://github.com/settings/applications/new and fill in:
   1. Application name: Cairn
   2. Homepage URL: the address from step 5
   3. Authorization callback URL: the callback URL from step 5, exactly
   4. Register, then "Generate a new client secret".

   Ask them to tell you the **Client ID** (not secret) and their **GitHub login**. For the **client secret**, ask them to open `deploy/azure/.cairn-deploy.env` in their own editor and set the line `CAIRN_OAUTH_CLIENT_SECRET='...'`, then tell you when it is saved. You do not open that file.

   For Entra ID or Google instead, follow "Other sign-in providers" in `docs/DEPLOY-AZURE.md`, the same way: ids through the chat, secrets through the file.
7. **Second pass:**

   ```
   CAIRN_OAUTH_CLIENT_ID=<client id> CAIRN_ALLOWED_USERS=github:<login> deploy/azure/deploy.sh
   ```

   It waits for Cairn to answer and prints the addresses.
8. **Check it:** `curl -s <address>/health` must print `"status":"ok"`, and `curl -s -o /dev/null -w '%{http_code}\n' -X POST <address>/mcp` must print `401`. That proves it refuses anyone not signed in.
9. **The person signs in** to the console at the address, with GitHub. If the page says they are not on the list, it shows the exact entry; add it with step 7 again.
10. **Connect their Claude,** with the steps in `docs/DEPLOY-AZURE.md` section 4:
   1. Claude on the web or Desktop: they add a custom connector with `<address>/mcp`.
   2. Claude Code: `claude mcp add --transport http --scope user cairn <address>/mcp`, then `/mcp` in a new session to sign in. Or the CLI: register it with `cairn instances add azure <address>` and sign in with `cairn login --instance azure`, which opens their browser (a bare `cairn login` signs in to localhost, which needs none); the skill as in 3a.
11. **Moving a local Cairn up**, if they have one. Ask whether they want to keep the local one in step. If yes: register both (`cairn instances add laptop http://localhost:8787` first, then the Azure one from step 10), run `cairn sync --dry-run`, then `cairn sync` (ADR-023, ADR-029). Offer `cairn sync install --every 1h` to keep them in step, with an interval longer than the idle time from step 2, and `cairn start` for starting the day (`docs/AGENT-OPERATE.md` section 5). If not: `cairn export <folder>` against the local server, then `CAIRN_URL=<address> cairn import <folder> --dry-run`, then without `--dry-run`.
12. **Prove it end to end,** with their permission: create a page with `cairn create` or through Claude, and have them find it in the console's recent changes.

## 4. Hand over

Finish with a short summary for the person:

1. Where Cairn runs, and its console and MCP addresses.
2. How they connected, and how to connect another device.
3. **On this computer:** how to start it (`pnpm dev` in the repository folder). **On Azure:** that it starts by itself, where the settings file is (`deploy/azure/.cairn-deploy.env`, to keep private and back up), what it costs, how to update (`docs/DEPLOY-AZURE.md`, "Day to day") and how to remove it (`az group delete --name <resource group>`, after an export). **On their own server, or on an AWS or GCP VM:** that it restarts by itself, where the database folder and `deploy/docker/.env` are (both to back up, the file to keep private), how to update (`docker compose pull && docker compose up -d`), and, on a cloud VM, how to remove it (`docs/DEPLOY-AWS.md` or `docs/DEPLOY-GCP.md`, "Day to day": export first, then terminate the instance).
4. What you did not do, or what failed.
5. That for anything later, from changing a setting to updating, their agent follows `docs/AGENT-OPERATE.md`.

If anything in this guide was wrong or unclear, say so, so the owner can fix it.
