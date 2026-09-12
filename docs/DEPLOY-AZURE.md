# Deploying Cairn to Azure

This puts Cairn on the internet at its own HTTPS address, so Claude on the web, Claude Desktop, Claude Code on any machine and the `cairn` command can all reach it. People sign in with GitHub, or with Entra ID, Google or another OpenID Connect provider, and only the accounts you list get in.

It takes about fifteen minutes. If you would rather have your coding agent do it, open this repository in Claude Code and say "deploy Cairn to Azure": it follows `docs/AGENT-INSTALL.md` and asks you for what it needs.

## What you get, and what it costs

1. **Azure Container Apps** runs Cairn: one container, stopped when nobody uses it, started by the next request. The consumption plan includes 180,000 vCPU-seconds, 360,000 GiB-seconds and 2 million requests per subscription per month, which at Cairn's size is about 200 hours of activity a month, before any charge.
2. **Azure Blob Storage** keeps the database. Litestream copies every change there within about a second and restores it when a container starts. Storage for a personal wiki costs cents a month.
3. **Nothing else.** No database service, no key vault, no log workspace.

Expect nothing to a few cents a month for one person. This will be confirmed with a month of real billing (PRD Q7).

Trade-offs, all fine for personal use and recorded in ADR-018:

1. A cold start takes a few seconds while the container starts and restores the database.
2. Changes in the last second before a container stops can be lost.
3. One region, no failover.

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

It creates a resource group called `cairn` in West Europe, a storage account, and the Container Apps environment, and prints the address Cairn will have, such as:

```
First pass done. Cairn will live at:
  https://cairn.happyhill-1a2b3c4d.westeurope.azurecontainerapps.io

Next: create an OAuth app with this callback URL:
  https://cairn.happyhill-1a2b3c4d.westeurope.azurecontainerapps.io/oauth/callback
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
Cairn is running at https://cairn.happyhill-1a2b3c4d.westeurope.azurecontainerapps.io
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

## Day to day

**Update to a new version.** Releases are published as images. Run the script again with the version you want:

```
CAIRN_IMAGE=ghcr.io/vespassassina/cairn:0.2.0 deploy/azure/deploy.sh
```

**Watch the logs:**

```
az containerapp logs show -g cairn -n cairn --follow
```

**Keep your own copy.** Litestream is a continuous backup, but an export is one you can read: run `cairn export` now and then.

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
3. **The app does not start, and the logs say the image cannot be pulled.** The image must be public. On GitHub: your profile, Packages, cairn, Package settings, Change visibility, Public. Until the first release, use `CAIRN_IMAGE=ghcr.io/vespassassina/cairn:edge`.
4. **The logs show restore attempts failing right after the first deploy.** Azure takes a minute or two to give the app access to storage. The container retries for two minutes, and Container Apps restarts it after that.
5. **Anything else:** `az containerapp logs show -g cairn -n cairn --follow`, and the notes in `docs/LESSONS.md`.

## What is not tested yet

The template compiles, the scripts pass shellcheck, and the image is built and started in CI on every push. A full deployment from this guide has not been run yet. The first one will be recorded in `docs/CHANGELOG.md`, and this line removed.
