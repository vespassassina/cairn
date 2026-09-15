# Running Cairn on AWS

This puts Cairn on a small EC2 virtual machine running Docker: the same image and the same `deploy/docker/compose.yaml` as `docs/DEPLOY-DOCKER.md`, just provisioned on AWS instead of hardware you own (ADR-043). This guide covers only what is AWS-specific: launching the VM, its firewall rule, and an optional S3 backup. Do everything else, from cloning the repository onward, in `docs/DEPLOY-DOCKER.md`.

It takes about twenty minutes, plus whatever `docs/DEPLOY-DOCKER.md` takes on top.

## Before you start

1. An AWS account, and the AWS CLI installed and configured: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html, then `aws configure`.
2. **Check current free-tier terms before relying on this costing nothing.** AWS has changed its free tier more than once; as of this writing new accounts get a time-limited credit rather than always-free EC2 hours, and the details vary by account age and region. See https://aws.amazon.com/free and your own account's Billing console, "Free tier", before choosing an instance size.
3. A default VPC in the region you plan to use. Almost every AWS account has one; `aws ec2 describe-vpcs --filters Name=is-default,Values=true` confirms it.

## 1. Launch the VM

Pick a region and an instance size within what your account's free tier actually covers (see above); `t3.micro` or the ARM-based `t4g.micro` are the usual small choices, and Cairn's image is published for both amd64 and arm64 (ADR-018), so either architecture works.

```
aws ec2 run-instances \
  --image-id <a current Debian or Ubuntu AMI id for your region and architecture> \
  --instance-type t3.micro \
  --key-name <an EC2 key pair you already have, or create one first> \
  --security-groups cairn \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=cairn}]'
```

Find a current AMI id for your region at https://cloud-images.ubuntu.com/locator/ec2/ or https://wiki.debian.org/Cloud/AmazonEC2Image, matching the instance architecture you chose.

**The security group** needs SSH from you and nothing else open to the world; the HTTPS address in front of Cairn (below) handles the public side:

```
aws ec2 create-security-group --group-name cairn --description "Cairn VM"
aws ec2 authorize-security-group-ingress --group-name cairn --protocol tcp --port 22 --cidr <your IP address>/32
```

If you plan to terminate TLS directly on this VM rather than use a tunnel (see "The HTTPS address" below), also open 443:

```
aws ec2 authorize-security-group-ingress --group-name cairn --protocol tcp --port 443 --cidr 0.0.0.0/0
```

**An Elastic IP** keeps the address stable across a stop and restart, which a plain EC2 public IP does not:

```
aws ec2 allocate-address
aws ec2 associate-address --instance-id <the instance id from run-instances> --allocation-id <from allocate-address>
```

**Enable termination protection**, so the VM (and the database on its disk) cannot be deleted by mistake:

```
aws ec2 modify-instance-attribute --instance-id <instance id> --disable-api-termination
```

The instance's own root EBS volume already persists across a stop and restart; nothing extra is needed to keep the database folder alive as long as you do not terminate the instance.

## 2. Install Docker

SSH in (`ssh -i <your key> admin@<elastic ip>`, `admin` on Debian AMIs or `ubuntu` on Ubuntu ones) and follow https://docs.docker.com/engine/install/ for your distribution, then `sudo usermod -aG docker $USER` and reconnect.

## 3. The rest

Follow `docs/DEPLOY-DOCKER.md` from "The HTTPS address" onward, on this VM: pick how the HTTPS address reaches it (a reverse proxy with a certificate, Cloudflare Tunnel, or Tailscale all work unchanged; an AWS Application Load Balancer with an ACM certificate is a fourth option if you would rather stay inside AWS, pointed at the VM's port 8787), clone the repository, fill in `.env`, create the OAuth app, and start it.

## Backups

1. **EBS snapshots.** The database folder lives on the instance's root volume, so a snapshot of that volume backs it up, the same shape as a Proxmox VM backup:

   ```
   aws ec2 create-snapshot --volume-id <the root volume id> --description "cairn backup"
   ```

   Schedule this with AWS Backup or a cron job calling the CLI, if you want it automatic.

2. **A Litestream replica to S3**, for a copy that survives losing the whole instance. This is exactly the example already in `deploy/docker/env.example`:

   ```
   aws s3 mb s3://<a bucket name you choose>
   ```

   Create an IAM user (or, better, attach an instance profile role instead of long-lived keys) with a policy scoped to that one bucket, for example:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
       "Resource": ["arn:aws:s3:::<bucket>", "arn:aws:s3:::<bucket>/*"]
     }]
   }
   ```

   Then in `.env`:

   ```
   CAIRN_REPLICA_URL=s3://<bucket>/cairn.sqlite
   AWS_ACCESS_KEY_ID=...
   AWS_SECRET_ACCESS_KEY=...
   ```

   With an empty `data` folder, Cairn restores from this replica on start.

3. **An export you can read:** `cairn export <folder>` now and then (`docs/CLI.md`), the same as any other target.

## Day to day

Same as `docs/DEPLOY-DOCKER.md`, "Day to day": `docker compose pull && docker compose up -d` to update, `docker compose logs --follow` for logs.

**To remove everything:** export first, then `docker compose down`, release the Elastic IP, and `aws ec2 terminate-instances` (after `aws ec2 modify-instance-attribute --disable-api-termination-value false` if you turned termination protection on).

## When something goes wrong

Everything in `docs/DEPLOY-DOCKER.md`'s "When something goes wrong" applies unchanged. AWS-specific cases:

1. **Cannot SSH in.** Check the security group actually allows port 22 from your current IP address; it changes if you are not on a static one.
2. **The Elastic IP stops working after a stop and restart.** Elastic IPs stay associated with a stopped instance; if you disassociated it, reassociate with `aws ec2 associate-address`.
3. **Litestream cannot reach S3.** Check the bucket region matches where you created it, and that the IAM policy's resource ARNs match the bucket name exactly.

## What is not tested yet

CI checks the compose file and starts the image with a mounted folder on every push, on a plain Linux runner. It has not been run on an actual EC2 instance from this repository yet; the first real run will be recorded in `docs/CHANGELOG.md`.
