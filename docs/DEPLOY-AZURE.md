# Deploying Cairn to Azure

This puts Cairn on the internet at its own HTTPS address, so Claude on the web, Claude Desktop, Claude Code on any machine and the `cairn` command can all reach it. People sign in with GitHub, or with Entra ID, Google or another OpenID Connect provider, and only the accounts you list get in.

It takes about fifteen minutes. If you would rather have your coding agent do it, open this repository in Claude Code and say "deploy Cairn to Azure": it follows `docs/AGENT-INSTALL.md` and asks you for what it needs.

## What you get, and what it costs

1. **Azure Container Apps** runs Cairn: one container, stopped when nobody uses it, started by the next request. The consumption plan includes 180,000 vCPU-seconds, 360,000 GiB-seconds and 2 million requests per subscription per month, which at Cairn's size is about 200 hours of activity a month, before any charge.
2. **Azure Blob Storage** keeps the database. Litestream copies every change there within about a second and restores it when a container starts. Storage for a personal wiki costs cents a month.
3. **Nothing else.** No database service, no key vault, no log workspace.

Expect nothing to a few cents a month for one person. This will be confirmed with a month of real billing (PRD Q7).

Search matches meaning as well as keywords, with a small English model inside the container: **English only**, text in other languages gets keyword search (ADR-022). It fits the container's 0.5 GiB: 347 MB measured with a 96-page wiki embedded. To turn it off, run the script with `CAIRN_EMBEDDINGS=off`.

Trade-offs, all fine for personal use and recorded in ADR-018:

1. A cold start: the first request after Cairn has been idle waits while the container starts, about 25 seconds, most of it Azure assigning a machine and creating the container. Later requests are fast. See "Cold starts" below to have fewer of them, or none.
2. Changes in the last second before a container stops can be lost.
3. One region, no failover.

## Cold starts

Cairn stops after 30 minutes without a request, and the next request starts it again. Three settings, all passed to `deploy/azure/deploy.sh` and kept for later runs:

1. **`CAIRN_IDLE_MINUTES`** (default 30). Longer means fewer cold starts, since a working session keeps it awake; the waiting time comes out of the free grant, which covers about 200 hours of running a month.
2. **`CAIRN_ALWAYS_ON=true`**: never stop, so no cold starts. Azure bills a running copy that is not busy at its lower idle rate, and a month of that goes beyond the free grant: about $4 a month for Cairn's size at Sweden Central's published rates in September 2026. Check the rates for your region before choosing it.
3. **Keep the image small.** Every cold start pulls it. Nothing to set: it is how the image is built.

`cairn sync --every` counts as use. Syncing more often than every `CAIRN_IDLE_MINUTES` keeps Cairn awake all the time, billed at the full rate rather than the idle one, so either sync less often than that, or turn on `CAIRN_ALWAYS_ON`.

## Before you start

1. An Azure subscription with pay-as-you-go billing. The free grants apply to it.
2. The Azure CLI, installed and signed in: https://learn.microsoft.com/cli/azure/install-azure-cli, then `az login`.
3. A GitHub account, or another sign-in provider (see "Other sign-in providers" below).
4. This repository, cloned.
5. On Windows, run the commands in Git Bash, which comes with Git for Windows.

## 1. First pass: storage and the address

From the repository folder:

```
deploy/azure/deploy.sh
```

It creates a resource group called `cairn` in Sweden Central, a storage account, and the Container Apps environment, and prints the address Cairn will have, such as:

```
First pass done. Cairn will live at:
  https://cairn.happyhill-1a2b3c4d.swedencentral.azurecontainerapps.io

Next: create an OAuth app with this callback URL:
  https://cairn.happyhill-1a2b3c4d.swedencentral.azurecontainerapps.io/oauth/callback
```

To use another region, resource group or name, set them first, for example `CAIRN_LOCATION=northeurope CAIRN_NAME=notes deploy/azure/deploy.sh`.

The script generates a signing secret and keeps it, with your other settings, in `deploy/azure/.cairn-deploy.env`. Only you can read it, and git ignores it. Keep it: without it, a redeploy signs everyone out.

## 2. Create the GitHub OAuth app

1. Open https://github.com/settings/applications/new.
2. **Application name:** Cairn.
3. **Homepage URL:** the address from step 1.
4. **Authorization callback URL:** the callback URL from step 1, exactly.
5. Select **Register application**.
6. Copy the **Client ID**.
7. Select **Generate a new client secret** and copy it. GitHub shows it once.

## 3. Second pass: the app

Run the script again with the OAuth app's details and your GitHub login:

```
CAIRN_OAUTH_CLIENT_ID=Ov23li... \
CAIRN_OAUTH_CLIENT_SECRET=... \
CAIRN_ALLOWED_USERS=github:yourlogin \
deploy/azure/deploy.sh
```

Paste the secret into your own terminal; do not put it in a file you commit or a chat. To let several people in, separate them with commas: `github:you,github:partner`.

When it finishes it prints:

```
Cairn is running at https://cairn.happyhill-1a2b3c4d.swedencentral.azurecontainerapps.io
  console      .../  (sign in with github)
  MCP          .../mcp
  Claude Code  claude mcp add --transport http --scope user cairn .../mcp
  CLI          CAIRN_URL=... cairn login
```

Open the console address, select **Sign in with GitHub**, and you are in.

## 4. Connect Claude and the CLI

**Claude on the web and Claude Desktop.** Settings, Connectors, **Add custom connector**. Name it Cairn, give it the MCP address (`.../mcp`), and select **Connect**. Sign in with GitHub, then select **Allow** on Cairn's consent page. Desktop picks up connectors from your account.

**Claude Code:**

```
claude mcp add --transport http --scope user cairn https://your-address/mcp
```

Start a new session, run `/mcp`, choose cairn, and sign in when the browser opens.

**The `cairn` command** (install it with `docs/CLI.md`):

```
export CAIRN_URL=https://your-address
cairn login
cairn whoami
```

**Scripts that cannot sign in** can use a service token: set `CAIRN_SERVICE_TOKEN` to the output of `openssl rand -hex 32` and run the script again. Give the script `CAIRN_TOKEN` with the same value.

## Moving your local Cairn to Azure

Export from your machine and import into the deployed one:

```
cairn export ~/cairn-backup
CAIRN_URL=https://your-address cairn login
CAIRN_URL=https://your-address cairn import ~/cairn-backup
```

The import keeps every page's id, so links still work. Running it again changes nothing.

To keep your local Cairn as well, and the two in step, use sync instead (ADR-023, `docs/CLI.md`). The first run copies everything across, like an import:

```
CAIRN_URL=https://your-address cairn login
cairn sync http://localhost:8787 https://your-address
```

## Day to day

**Update to a new version.** Releases are published as images. Run the script again with the version you want:

```
CAIRN_IMAGE=ghcr.io/vespassassina/cairn:0.2.0 deploy/azure/deploy.sh
```

Any of these work: a version, `latest` for the newest release, `edge` for the newest commit on `main`, or `@sha256:<digest>` for one exact build. The script asks the registry what the tag points at right now and deploys that digest, so a tag that has moved really does deploy, and one that has not says "no change to deploy" instead of pretending (ADR-047). Naming a version is still the clearest thing to do, because then the command itself records what you deployed.

**Watch the logs:**

```
az containerapp logs show -g cairn -n cairn --follow
```

**Two copies, and they are not the same thing.** Litestream is a replica: it copies SQLite's pages continuously, so a new container starts from a copy seconds old, but damage to the database reaches it just as quickly. That is how this Cairn was lost for four days in September 2026. So Cairn also takes its own backups: whole copies of the database, each one read back and checked before it is kept (ADR-049). The template puts them in a second blob container, `cairn-backups`, separate from the replica on purpose, and the app's managed identity is what reaches it, so no storage key exists here either (ADR-050). To see them:

```
az storage blob list --account-name <account> --container-name cairn-backups --auth-mode login -o table
```

**Keep one copy yourself as well.** Both of the above live in the same storage account, under the same subscription. `cairn export ~/cairn-backup` now and then gives you one that does not, and one you can read without Cairn.

**Rotate the signing secret.** Move the current value to `CAIRN_AUTH_SECRET_PREVIOUS` in `deploy/azure/.cairn-deploy.env`, delete `CAIRN_AUTH_SECRET`, and run the script. Tokens signed with the old secret keep working until they expire.

**Remove everything:**

```
az group delete --name cairn
```

This deletes the database as well. Export first.

## Other sign-in providers

Any OpenID Connect provider works. Set `CAIRN_AUTH_PROVIDER=oidc` and `CAIRN_OIDC_ISSUER`, and register the same callback URL with the provider.

**Microsoft Entra ID.** In the Azure portal: Microsoft Entra ID, App registrations, New registration. Add a Web redirect URI with the callback URL, then create a client secret under Certificates and secrets.

```
CAIRN_AUTH_PROVIDER=oidc \
CAIRN_OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0 \
CAIRN_OAUTH_CLIENT_ID=<application-id> \
CAIRN_OAUTH_CLIENT_SECRET=<secret> \
CAIRN_ALLOWED_USERS=oidc:<your-subject> \
deploy/azure/deploy.sh
```

Entra ID does not say whether an email address is verified, so list people by subject. You find yours by signing in once: the page that turns you away shows the exact entry to add.

**Google.** In Google Cloud: APIs and services, Credentials, Create OAuth client ID, type Web application, with the callback URL as an authorised redirect URI. Use `CAIRN_OIDC_ISSUER=https://accounts.google.com`. Google verifies email addresses, so `CAIRN_ALLOWED_USERS=email:you@gmail.com` works.

## When something goes wrong

1. **"is not on this Cairn's list of allowed users".** The page names the exact entry, such as `github:yourlogin`. Add it to `CAIRN_ALLOWED_USERS` and run the script again.
2. **GitHub says the redirect URI is not associated with the application.** The callback URL in the GitHub OAuth app must match the one the script printed, exactly.
3. **The app does not start, and the logs say the image cannot be pulled.** The image must be public. On GitHub: your profile, Packages, cairn, Package settings, Change visibility, Public. It has been public since 2026-09-13, so check the name in `CAIRN_IMAGE` if you set one.
4. **The first pass fails with "The selected region is currently not accepting new customers".** Some regions are closed to new subscriptions; West Europe was in September 2026. Run the script again with another region, for example `CAIRN_LOCATION=northeurope deploy/azure/deploy.sh`. The resource group the failed run created is reused.
5. **The logs show restore attempts failing right after the first deploy.** Azure takes a minute or two to give the app access to storage. The container retries for two minutes, and Container Apps restarts it after that.
6. **The logs say "certificate signed by unknown authority".** The image is `0.1.0`, which lacks the certificates Litestream needs to reach storage. Use `0.1.1` or later: run the script again, with `CAIRN_IMAGE` unset or set to a newer version.
7. **The app restarts with "out of memory" in the logs.** The embedding model needs about 300 MB. Run the script again with `CAIRN_EMBEDDINGS=off` for keyword search only.
8. **Anything else:** `az containerapp logs show -g cairn -n cairn --follow`, and the notes in `docs/LESSONS.md`.

## What has been tested

The first full deployment from this guide ran on 2026-09-13, in Sweden Central on a new pay-as-you-go subscription, and is recorded in `docs/CHANGELOG.md`: both passes, GitHub sign-in in the console and from the CLI, a 96-page wiki moved up with export and import and checked identical, the database restored from storage after scaling to zero, and sync with a local Cairn. It found three bugs, all fixed: missing certificates for Litestream, "database is locked" under load, and West Europe refusing new subscriptions.

Not measured yet: how many writes a stopped container can lose, and a month of real cost.
