# Running Cairn on your own server

This runs Cairn as one container on a machine you own: a Proxmox VM or container, a NAS, a small server, anything with Docker. The database lives in a folder on that machine's disk. Nothing else runs beside it (ADR-020).

It takes about twenty minutes. If you would rather have your coding agent do it, open this repository in Claude Code and say "set Cairn up on my server": it follows `docs/AGENT-INSTALL.md`.

## What you need

1. A Linux machine with Docker and the Compose plugin: https://docs.docker.com/engine/install/
2. An HTTPS address that reaches it. Cairn only accepts sign-in over HTTPS; see "The HTTPS address" below.
3. A GitHub account, or another sign-in provider (see "Other sign-in providers" in `docs/DEPLOY-AZURE.md`).

## The HTTPS address

Cairn listens on plain HTTP on port 8787. Something in front of it has to give it an HTTPS address. Pick one; you may already run it:

1. **A reverse proxy you already have**, such as Caddy, Nginx Proxy Manager or Traefik, with a certificate for a name like `cairn.example.com`. Point it at port 8787.
2. **Cloudflare Tunnel.** A public HTTPS address without opening a port on your router. See https://www.cloudflare.com/products/tunnel/
3. **Tailscale.** `tailscale serve` gives an HTTPS address that only your own devices can reach: enough for Claude Code and the CLI. Claude on the web and Claude Desktop connectors are called from Anthropic's servers, so they need a public address: Tailscale Funnel or one of the options above.

Whichever you choose, that address is your `CAIRN_PUBLIC_URL`.

## 1. The folder and the settings

On the server:

```
git clone https://github.com/vespassassina/cairn.git
cd cairn/deploy/docker
mkdir data
sudo chown 1000:1000 data
cp env.example .env
chmod 600 .env
```

The container runs as user 1000, so the `data` folder must belong to that user. The database goes there, on the server's own disk. **Do not put it on an NFS or SMB share:** SQLite's locking is unreliable on network file systems.

To keep the database somewhere else on the machine, set `CAIRN_DATA=/path/to/folder` in `.env`, and give that folder to user 1000 the same way.

## 2. Create the GitHub OAuth app

1. Open https://github.com/settings/applications/new.
2. **Application name:** Cairn.
3. **Homepage URL:** your HTTPS address.
4. **Authorization callback URL:** your HTTPS address followed by `/oauth/callback`, for example `https://cairn.example.com/oauth/callback`.
5. Select **Register application**, copy the **Client ID**, then **Generate a new client secret** and copy it.

## 3. Fill in `.env`

Open `.env` in an editor on the server and set:

1. `CAIRN_PUBLIC_URL`: your HTTPS address.
2. `CAIRN_OAUTH_CLIENT_ID` and `CAIRN_OAUTH_CLIENT_SECRET`: from step 2.
3. `CAIRN_ALLOWED_USERS`: `github:yourlogin`, comma-separated for more people.
4. `CAIRN_AUTH_SECRET`: the output of `openssl rand -hex 32`. Keep it: changing it signs everyone out.

`.env` holds secrets. Git ignores it; do not copy it anywhere public.

By default the port is published on `127.0.0.1` only, for a reverse proxy or tunnel on the same machine. If the proxy runs on another machine, add `CAIRN_BIND=0.0.0.0` to `.env`.

## 4. Start it

```
docker compose up -d
docker compose logs
```

The log says `database: /data/cairn.sqlite, on a mounted volume`. Check it:

```
curl -s http://127.0.0.1:8787/health
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/mcp
```

The first prints `"status":"ok"`. The second prints `401`: Cairn refuses anyone not signed in. Then open your HTTPS address, select **Sign in with GitHub**, and you are in.

It starts again by itself after a reboot (`restart: unless-stopped`).

## 5. Connect Claude and the CLI

The same as on Azure: `docs/DEPLOY-AZURE.md`, section 4, with your HTTPS address.

## On Proxmox

1. **A VM is the simplest:** Debian or Ubuntu, Docker installed, and the steps above. The `data` folder is on the VM's disk, so Proxmox backups of the VM include it.
2. **A Linux container (LXC) works too,** with nesting enabled for Docker (Options, Features, Nesting).
3. **To keep the database on a host disk,** mount a host folder into the LXC, for example `pct set <id> -mp0 /tank/cairn,mp=/srv/cairn`, and set `CAIRN_DATA=/srv/cairn` in `.env`. In an unprivileged LXC, user 1000 inside appears as 101000 on the host, so on the host run `chown 101000:101000 /tank/cairn`.
4. **Proxmox does not back up bind mounts.** A folder mounted from the host is left out of the LXC's backups; back it up on the host, or use a replica (below).

## Backups

1. **The folder.** Back up the `data` folder with the rest of the machine. SQLite survives a crash-consistent snapshot, such as a VM backup.
2. **A copy off the machine,** if you want one: set `CAIRN_REPLICA_URL` in `.env` to an S3 bucket, with its credentials, and Litestream streams every change there. If the folder is ever empty, Cairn restores from the replica on start. Litestream's guides cover S3 and S3-compatible stores: https://litestream.io/guides/
3. **An export you can read:** `cairn export <folder>` now and then (`docs/CLI.md`).

## Day to day

**Update:**

```
docker compose pull
docker compose up -d
```

To pin a version, set `CAIRN_IMAGE=ghcr.io/vespassassina/cairn:0.2.0` in `.env`.

**Logs:** `docker compose logs --follow`.

**Moving from your computer or from Azure:** `cairn export <folder>` against the old one, then `CAIRN_URL=<your address> cairn login` and `cairn import <folder>`. Page ids are kept, so links still work.

## When something goes wrong

1. **"is not writable by user 1000".** The data folder belongs to someone else. `sudo chown 1000:1000 data`, or `101000:101000` on the host for an unprivileged LXC.
2. **"OAuth is partly configured. Also set: ..."** A setting in `.env` is empty. The message names each one.
3. **"CAIRN_PUBLIC_URL must be https".** Use the HTTPS address from your proxy or tunnel, not the server's IP address.
4. **GitHub says the redirect URI is not associated with the application.** The callback URL in the OAuth app must be exactly your address followed by `/oauth/callback`.
5. **Anything else:** `docker compose logs`, and `docs/LESSONS.md`.

## What is not tested yet

CI checks the compose file and starts the image with a mounted folder on every push. It has not been run on Proxmox yet; the first run will be recorded in `docs/CHANGELOG.md`.
