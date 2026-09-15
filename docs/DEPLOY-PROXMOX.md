# Running Cairn on Proxmox

This runs Cairn as one container inside a VM or LXC container on your Proxmox host. Proxmox itself is just the machine: Cairn's own container, the database and everything else works exactly as in `docs/DEPLOY-DOCKER.md`. This guide covers only what is specific to Proxmox: which guest type to use, where the disk lives, and how backups behave there. Do the rest, from "What you need" onward, in that guide.

It takes about twenty minutes on top of a Proxmox host you already have.

## 1. Choose a guest type

**A VM is the simplest, and the default.** Debian or Ubuntu, with Docker installed inside it as normal. The `data` folder Cairn's database lives in sits on the VM's own virtual disk, so it moves, snapshots and restores with the VM as one thing. Nothing about it is Proxmox-specific once Docker is installed.

**A Linux container (LXC) also works**, and starts faster and uses less memory, at the cost of a little more setup:

1. **Enable nesting**, so Docker can run inside it: in the Proxmox UI, the LXC's **Options**, **Features**, tick **Nesting**.
2. Install Docker inside the LXC the same way as inside a VM.
3. An **unprivileged** LXC (the default, and the one to prefer) maps its internal uid 1000, the user Cairn's container runs as, to uid 101000 on the Proxmox host. This matters for step 3 below.

If you are not sure which to pick, use a VM. Come back to an LXC later if you want the smaller footprint; nothing about the database or the compose file changes.

## 2. Where the database lives

By default the database folder (`deploy/docker/data` from `docs/DEPLOY-DOCKER.md`) is just a folder inside the guest's own disk, VM or LXC. Proxmox's normal backup of that guest (`vzdump`, or Proxmox Backup Server) includes it, with no extra steps. This is the simplest choice, and the one to use unless you specifically want the database on a separate disk Proxmox manages independently of the guest.

**To keep the database on a host-managed disk instead** (a ZFS pool, for example), mount it into the guest rather than putting it on the guest's own virtual disk:

1. **Into a VM:** attach a second virtual disk backed by the host storage you want, format and mount it inside the VM, and point `CAIRN_DATA` in `.env` at that mount point.
2. **Into an LXC:** a host-path bind mount, for example:

   ```
   pct set <id> -mp0 /tank/cairn,mp=/srv/cairn
   ```

   then set `CAIRN_DATA=/srv/cairn` in `.env`. Because the LXC is unprivileged, uid 1000 inside it is uid 101000 on the host, so on the Proxmox host itself:

   ```
   chown 101000:101000 /tank/cairn
   ```

   Get this backwards and Cairn's own start script says so plainly: "is not writable by user 1000", with the fix.

**Proxmox does not back up bind mounts.** A folder mounted in from the host, as in the LXC case above, is left out of that guest's `vzdump` or PBS backup. Back up that host folder separately (it is a plain SQLite database file plus its WAL, so a filesystem snapshot or `rsync` while Cairn is stopped both work), or use a Litestream replica off the machine entirely (`docs/DEPLOY-DOCKER.md`, "Backups").

## 3. Everything else

Follow `docs/DEPLOY-DOCKER.md` from "What you need" onward, on the VM or inside the LXC: install Docker, decide how the HTTPS address reaches it, clone the repository, fill in `.env`, create the OAuth app, and start it. None of that differs on Proxmox.

## Networking notes

1. **A reverse proxy, Cloudflare Tunnel or Tailscale** (`docs/DEPLOY-DOCKER.md`, "The HTTPS address") can run inside the same guest as Cairn, in a separate guest on the same Proxmox host, or outside Proxmox entirely. None of the three cares which.
2. **If Cairn's guest is on Proxmox's own internal network** (a private vmbr with NAT, for example) rather than bridged onto your LAN, whatever provides the HTTPS address needs a route to it: either run the proxy or tunnel client on the same guest, or forward the port from your router or Proxmox host to the guest's internal address.

## When something goes wrong

Everything in `docs/DEPLOY-DOCKER.md`'s "When something goes wrong" applies unchanged. The one Proxmox-specific case:

1. **"is not writable by user 1000" with a host-path bind mount into an LXC.** The host folder must belong to uid 101000, not 1000: `chown 101000:101000` on the host, not inside the LXC.

## What is not tested yet

CI checks the compose file and starts the image with a mounted folder on every push, on a plain Linux runner. It has not been run inside an actual Proxmox VM or LXC from this repository yet; the first real run will be recorded in `docs/CHANGELOG.md`.
