# Installing Cairn: instructions for an agent

You are a coding agent, and the person you work with wants Cairn installed or deployed. Follow this page from the top. It is written for you; the person-facing guides it links to (`docs/LOCAL.md`, `docs/CLI.md`, `docs/DEPLOY-AZURE.md`) have more detail on each step. Why it works this way: ADR-019.

## Rules

1. **Ask before you act.** Cairn can run on this computer or on Azure. Never choose for the person.
2. **Credentials stay with the person.** Never ask for a password, client secret or token in the chat, never print one, and never write one into a file git tracks. Signing in to Azure and creating the OAuth app are the person's steps; you tell them exactly what to click and type.
3. **Never read `deploy/azure/.cairn-deploy.env`.** It holds secrets. The deploy script reads it; you do not. Do not `cat`, open, grep or print it.
4. **Check every step** with the command given, and stop on a failure. Read the matching section of the person's guide and `docs/LESSONS.md` before trying anything else. Do not improvise cloud resources.
5. **Change nothing else.** Do not edit Cairn's code, commit, push, or delete Azure resources unless the person asks.
6. **Say what costs money** before running anything that creates cloud resources, and get a yes.

## 1. Ask

Ask these together, in one message:

1. **Where should Cairn run?**
   1. **On this computer.** Free, private, set up in five minutes. Only agents on this machine can use it, and only while it runs.
   2. **On Azure.** Reachable from anywhere, including Claude on the web and phone. Needs an Azure subscription; costs nothing to a few cents a month within the free grants. About fifteen minutes, with two steps the person does in a browser.
   3. **AWS** is not available yet. Say so, and offer one of the two above.
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
3. For Azure, also: `az --version`. If it is missing, give them https://learn.microsoft.com/cli/azure/install-azure-cli.
4. On Windows, run every command in Git Bash.

From the repository's root folder:

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
3. **Check it:** `curl -s http://localhost:8787/health` must print `"status":"ok"`.
4. **Connect their Claude.**
   1. **Claude Code: use the CLI and skill** (about 115 tokens per session, against about 2,700 for MCP). Steps in `docs/CLI.md`: `pnpm build:cli host`, put the executable on the PATH, copy `skills/cairn` to `~/.claude/skills/`. Check with `cairn overview`.
   2. **Or MCP:** `claude mcp add --transport http --scope user cairn http://localhost:8787/mcp`, then a new session.
   3. **Claude Desktop or on the web** cannot reach a server on this computer. Suggest Azure if they need those.
5. **Prove it end to end,** with their permission: `cairn create --title "Cairn is connected" --note "Install check" --text "Written during setup."`. Ask them to open http://localhost:8787 and find it under recent changes.

## 3b. On Azure

Human guide: `docs/DEPLOY-AZURE.md`. Say first: this creates a resource group, a storage account and a container app in their subscription; within the free grants it costs nothing to a few cents a month; they can remove it all with one command.

1. **Sign in to Azure.** Ask the person to run `az login` themselves, in their own terminal. It opens a browser. Then check which subscription is active, and confirm it with them: `az account show --query "{name:name, id:id}" --output table`
2. **Choose a name and region.** Defaults: name `cairn`, region `westeurope`, resource group `cairn`. The name becomes part of the address. Ask if they want different ones.
3. **Check the image is published.** Should print `200`:

   ```
   token=$(curl -s "https://ghcr.io/token?scope=repository:vespassassina/cairn:pull" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
   curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $token" -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json" https://ghcr.io/v2/vespassassina/cairn/manifests/latest
   ```

   If it prints anything else, try `edge` in place of `latest`, and use that as `CAIRN_IMAGE` below. If neither is `200`, stop: the image is not public yet.
4. **First pass.** Run `deploy/azure/deploy.sh`, with `CAIRN_NAME`, `CAIRN_LOCATION` and `CAIRN_RG` set if they chose other values, and `CAIRN_IMAGE` if you are using `edge`. It prints the address and the callback URL. Give both to the person.
5. **The person creates the OAuth app.** For GitHub, tell them to open https://github.com/settings/applications/new and fill in:
   1. Application name: Cairn
   2. Homepage URL: the address from step 4
   3. Authorization callback URL: the callback URL from step 4, exactly
   4. Register, then "Generate a new client secret".

   Ask them to tell you the **Client ID** (not secret) and their **GitHub login**. For the **client secret**, ask them to open `deploy/azure/.cairn-deploy.env` in their own editor and set the line `CAIRN_OAUTH_CLIENT_SECRET='...'`, then tell you when it is saved. You do not open that file.

   For Entra ID or Google instead, follow "Other sign-in providers" in `docs/DEPLOY-AZURE.md`, the same way: ids through the chat, secrets through the file.
6. **Second pass:**

   ```
   CAIRN_OAUTH_CLIENT_ID=<client id> CAIRN_ALLOWED_USERS=github:<login> deploy/azure/deploy.sh
   ```

   It waits for Cairn to answer and prints the addresses.
7. **Check it:** `curl -s <address>/health` must print `"status":"ok"`, and `curl -s -o /dev/null -w '%{http_code}\n' -X POST <address>/mcp` must print `401`. That proves it refuses anyone not signed in.
8. **The person signs in** to the console at the address, with GitHub. If the page says they are not on the list, it shows the exact entry; add it with step 6 again.
9. **Connect their Claude,** with the steps in `docs/DEPLOY-AZURE.md` section 4:
   1. Claude on the web or Desktop: they add a custom connector with `<address>/mcp`.
   2. Claude Code: `claude mcp add --transport http --scope user cairn <address>/mcp`, then `/mcp` in a new session to sign in. Or the CLI: `CAIRN_URL=<address> cairn login`, which opens their browser; the skill as in 3a.
10. **Moving a local Cairn up**, if they have one: `cairn export <folder>` against the local server, then `CAIRN_URL=<address> cairn import <folder>` after `cairn login`.
11. **Prove it end to end,** with their permission: create a page with `cairn create` or through Claude, and have them find it in the console's recent changes.

## 4. Hand over

Finish with a short summary for the person:

1. Where Cairn runs, and its console and MCP addresses.
2. How they connected, and how to connect another device.
3. **On this computer:** how to start it (`pnpm dev` in the repository folder). **On Azure:** that it starts by itself, where the settings file is (`deploy/azure/.cairn-deploy.env`, to keep private and back up), what it costs, how to update (`docs/DEPLOY-AZURE.md`, "Day to day") and how to remove it (`az group delete --name <resource group>`, after an export).
4. What you did not do, or what failed.

If anything in this guide was wrong or unclear, say so, so the owner can fix it.
