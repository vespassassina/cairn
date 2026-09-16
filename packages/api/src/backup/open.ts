import { FolderArchive, type Archive } from "./archive.js";
import { AzureBlobArchive } from "./azure.js";
import { S3Archive } from "./s3.js";

/**
 * Turn `CAIRN_BACKUP_TO` into somewhere to put backups (ADR-050).
 *
 * One setting, and the scheme decides. The owner's direction was "on azure the
 * backup must go to blob, on aws on s3 and so on", and the shape that gives is
 * the same one `CAIRN_REPLICA_URL` already has: a URL that names the platform's
 * own object storage, and a plain path when it is a folder on a disk.
 */

export interface ArchiveSettings {
  /** Only for s3. Defaults to the usual AWS environment variables. */
  region?: string;
  /** Only for s3. A store that speaks S3 but is not AWS. */
  endpoint?: string;
}

export class ArchiveError extends Error {}

export function openArchive(destination: string, settings: ArchiveSettings = {}): Archive {
  if (destination.startsWith("abs://")) return azure(destination);
  if (destination.startsWith("s3://")) return s3(destination, settings);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(destination)) {
    throw new ArchiveError(
      `CAIRN_BACKUP_TO is "${destination}", and Cairn does not know that kind of address. ` +
        "Use abs://<account>@<container>/<prefix> for Azure Blob Storage, s3://<bucket>/<prefix> " +
        "for S3 or anything that speaks S3, a plain folder path for a disk, or off for no backups.",
    );
  }
  return new FolderArchive(destination);
}

/**
 * `abs://<account>@<container>/<prefix>`, the same shape Litestream uses for
 * `CAIRN_REPLICA_URL`, so the two settings read alike and neither has to be
 * learned separately.
 */
function azure(destination: string): Archive {
  const match = /^abs:\/\/([^@/]+)@([^/]+)(?:\/(.*))?$/.exec(destination);
  if (match === null) {
    throw new ArchiveError(
      `CAIRN_BACKUP_TO is "${destination}", which is not a complete Azure address. ` +
        "It should be abs://<account>@<container>/<prefix>, for example " +
        "abs://cairnstore@cairn-backups/backups.",
    );
  }
  const [, account, container, prefix = ""] = match;
  return new AzureBlobArchive({ account: account!, container: container!, prefix });
}

/** `s3://<bucket>/<prefix>`, with the region from a setting or the environment. */
function s3(destination: string, settings: ArchiveSettings): Archive {
  const match = /^s3:\/\/([^/]+)(?:\/(.*))?$/.exec(destination);
  if (match === null) {
    throw new ArchiveError(
      `CAIRN_BACKUP_TO is "${destination}", which is not a complete S3 address. ` +
        "It should be s3://<bucket>/<prefix>, for example s3://cairn-backups/backups.",
    );
  }
  const [, bucket, prefix = ""] = match;
  const region =
    settings.region ?? process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "";
  if (region === "") {
    throw new ArchiveError(
      `CAIRN_BACKUP_TO is "${destination}", but no region was given and S3 requires one for ` +
        "signing. Set CAIRN_BACKUP_REGION, or AWS_REGION, to the bucket's region such as eu-west-1.",
    );
  }
  return new S3Archive({
    bucket: bucket!,
    prefix,
    region,
    ...(settings.endpoint === undefined ? {} : { endpoint: settings.endpoint }),
  });
}
