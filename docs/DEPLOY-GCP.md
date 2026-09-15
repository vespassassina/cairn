# Running Cairn on Google Cloud

This puts Cairn on a small Compute Engine virtual machine running Docker: the same image and the same `deploy/docker/compose.yaml` as `docs/DEPLOY-DOCKER.md`, just provisioned on GCP instead of hardware you own (ADR-043). This guide covers only what is GCP-specific: launching the VM, its firewall rule, and backups. Do everything else, from cloning the repository onward, in `docs/DEPLOY-DOCKER.md`.

It takes about twenty minutes, plus whatever `docs/DEPLOY-DOCKER.md` takes on top.

## Before you start

1. A Google Cloud account and project, and the `gcloud` CLI installed and signed in: https://cloud.google.com/sdk/docs/install, then `gcloud init`.
2. **Check current free-tier terms before relying on this costing nothing.** As of this writing, GCP's Always Free tier includes one `e2-micro` instance a month in `us-west1`, `us-central1` or `us-east1`, with 30 GB-month of standard persistent disk and some free egress from North America. Confirm the current terms at https://cloud.google.com/free before choosing a region or instance size; outside those three regions, or above `e2-micro`, the instance is billed normally.

## 1. Launch the VM

```
gcloud compute instances create cairn \
  --zone=us-central1-a \
  --machine-type=e2-micro \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --tags=cairn
```

Cairn's image is published for both amd64 and arm64 (ADR-018); `e2-micro` is amd64, and GCP's Tau T2A family is the arm64 equivalent if you would rather use that instead (outside the Always Free tier).

**A firewall rule** for SSH, scoped to your own IP address rather than the world:

```
gcloud compute firewall-rules create cairn-ssh \
  --allow=tcp:22 \
  --source-ranges=<your IP address>/32 \
  --target-tags=cairn
```

If you plan to terminate TLS directly on this VM rather than use a tunnel (see "The HTTPS address" below), also open 443:

```
gcloud compute firewall-rules create cairn-https \
  --allow=tcp:443 \
  --source-ranges=0.0.0.0/0 \
  --target-tags=cairn
```

**A static external IP** keeps the address stable across a stop and restart, which an ephemeral GCP IP does not:

```
gcloud compute addresses create cairn-ip --region=us-central1
gcloud compute instances delete-access-config cairn --zone=us-central1-a --access-config-name="External NAT"
gcloud compute instances add-access-config cairn --zone=us-central1-a --access-config-name="External NAT" --address=$(gcloud compute addresses describe cairn-ip --region=us-central1 --format='get(address)')
```

**Enable deletion protection**, so the VM (and the database on its disk) cannot be deleted by mistake:

```
gcloud compute instances update cairn --zone=us-central1-a --deletion-protection
```

The instance's own root persistent disk already survives a stop and restart; nothing extra is needed to keep the database folder alive as long as you do not delete the instance.

## 2. Install Docker

SSH in (`gcloud compute ssh cairn --zone=us-central1-a`) and follow https://docs.docker.com/engine/install/debian/, then `sudo usermod -aG docker $USER` and reconnect.

## 3. The rest

Follow `docs/DEPLOY-DOCKER.md` from "The HTTPS address" onward, on this VM: pick how the HTTPS address reaches it (a reverse proxy with a certificate, Cloudflare Tunnel, or Tailscale all work unchanged; a GCP external HTTPS load balancer with a Google-managed certificate is a fourth option if you would rather stay inside GCP, pointed at the VM's port 8787), clone the repository, fill in `.env`, create the OAuth app, and start it.

## Backups

1. **Persistent disk snapshots**, the primary way to back this up, the same shape as a Proxmox VM backup:

   ```
   gcloud compute disks snapshot cairn --zone=us-central1-a --snapshot-names=cairn-backup
   ```

   `gcloud compute resource-policies create snapshot-schedule` turns this into a recurring schedule if you want it automatic.

2. **A Litestream replica off the machine is not documented as supported here.** Litestream's S3 replica type can, in principle, reach Google Cloud Storage through its S3-compatible interoperability endpoint, but this has not been tried against this project's `CAIRN_REPLICA_URL`, which passes a single URL straight to Litestream with no config file for a custom endpoint (ADR-043). Disk snapshots are the tested path; treat a GCS replica as something to prove out yourself before relying on it, following Litestream's own guide at https://litestream.io/guides/.
3. **An export you can read:** `cairn export <folder>` now and then (`docs/CLI.md`), the same as any other target.

## Day to day

Same as `docs/DEPLOY-DOCKER.md`, "Day to day": `docker compose pull && docker compose up -d` to update, `docker compose logs --follow` for logs.

**To remove everything:** export first, then `docker compose down`, and `gcloud compute instances delete cairn --zone=us-central1-a` (after `gcloud compute instances update cairn --zone=us-central1-a --no-deletion-protection` if you turned deletion protection on).

## When something goes wrong

Everything in `docs/DEPLOY-DOCKER.md`'s "When something goes wrong" applies unchanged. GCP-specific cases:

1. **Cannot SSH in.** Check the firewall rule actually allows port 22 from your current IP address; it changes if you are not on a static one. `gcloud compute firewall-rules update cairn-ssh --source-ranges=<new IP>/32` fixes it without recreating the rule.
2. **The external IP changes after a stop and restart.** Only happens if you skipped the static IP step above; attach one with `gcloud compute instances add-access-config`.
3. **Billed even though the guide says `e2-micro` should be free.** Check the zone is one of the three Always Free regions, and that only one such instance is running in the project; a second one is billed normally.

## What is not tested yet

CI checks the compose file and starts the image with a mounted folder on every push, on a plain Linux runner. It has not been run on an actual Compute Engine instance from this repository yet; the first real run will be recorded in `docs/CHANGELOG.md`.
