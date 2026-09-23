import { AzureBlobArchive } from "./backup/azure.js";
import { S3Archive } from "./backup/s3.js";
import type { AttachmentsConfig } from "./config.js";

/**
 * Turns `AttachmentsConfig` into somewhere to put attachment blobs (ADR-064).
 *
 * Same shape as `backup/open.ts`, but the interface it returns is signed-URL
 * shaped rather than file-path shaped: attachments are many small objects an
 * agent or a browser puts and gets directly, not one archive Cairn streams
 * itself. `S3Archive` and `AzureBlobArchive` already speak both languages, so
 * this file is a thin adapter over each rather than a new HTTP client.
 */

export class AttachmentsConfigError extends Error {}

export interface AttachmentBlobStore {
  /** The size of the object at `key`, or null if nothing is there yet. */
  head(key: string): Promise<{ bytes: number } | null>;
  /** A short-lived URL to PUT the bytes straight to, no header of its own needed. */
  uploadUrl(key: string, expiresInSeconds: number): Promise<string>;
  /** A short-lived URL to GET the bytes from, downloading under `filename`. */
  downloadUrl(key: string, expiresInSeconds: number, filename: string): Promise<string>;
}

/** `attachment; filename="..."`, the same convention decision 5 asks every download to carry. */
function dispositionFor(filename: string): string {
  return `attachment; filename="${filename.replace(/"/g, "")}"`;
}

class S3AttachmentStore implements AttachmentBlobStore {
  constructor(private readonly archive: S3Archive) {}

  head(key: string) {
    return this.archive.head(key);
  }

  uploadUrl(key: string, expiresInSeconds: number) {
    return this.archive.presignedUrl(key, { method: "PUT", expiresInSeconds });
  }

  downloadUrl(key: string, expiresInSeconds: number, filename: string) {
    return this.archive.presignedUrl(key, {
      method: "GET",
      expiresInSeconds,
      responseContentDisposition: dispositionFor(filename),
    });
  }
}

class AzureAttachmentStore implements AttachmentBlobStore {
  constructor(private readonly archive: AzureBlobArchive) {}

  head(key: string) {
    return this.archive.head(key);
  }

  uploadUrl(key: string, expiresInSeconds: number) {
    // "cw": create and write, enough to PUT a new blob, no more.
    return this.archive.sasUrl(key, { permissions: "cw", expiresInSeconds });
  }

  downloadUrl(key: string, expiresInSeconds: number, filename: string) {
    return this.archive.sasUrl(key, { permissions: "r", expiresInSeconds, contentDisposition: dispositionFor(filename) });
  }
}

/**
 * Null when attachments are off (`config.to === null`, checked and logged by
 * `config.ts`'s `loadAttachments`). The address's scheme was already
 * validated there, so this only dispatches on it.
 */
export function openAttachmentsStore(config: AttachmentsConfig): AttachmentBlobStore | null {
  if (config.to === null) return null;
  if (config.to.startsWith("abs://")) {
    const match = /^abs:\/\/([^@/]+)@([^/]+)(?:\/(.*))?$/.exec(config.to);
    if (match === null) {
      throw new AttachmentsConfigError(
        `CAIRN_ATTACHMENTS_TO is "${config.to}", which is not a complete Azure address. ` +
          "It should be abs://<account>@<container>/<prefix>, for example abs://cairnstore@cairn-attachments/attachments.",
      );
    }
    const [, account, container, prefix = ""] = match;
    return new AzureAttachmentStore(new AzureBlobArchive({ account: account!, container: container!, prefix }));
  }
  const match = /^s3:\/\/([^/]+)(?:\/(.*))?$/.exec(config.to);
  if (match === null) {
    throw new AttachmentsConfigError(
      `CAIRN_ATTACHMENTS_TO is "${config.to}", which is not a complete S3 address. ` +
        "It should be s3://<bucket>/<prefix>, for example s3://cairn-attachments/attachments.",
    );
  }
  const [, bucket, prefix = ""] = match;
  if (config.region === null) {
    throw new AttachmentsConfigError(
      `CAIRN_ATTACHMENTS_TO is "${config.to}", but no region was given and S3 requires one for signing. ` +
        "Set CAIRN_BACKUP_REGION (shared with backups), or AWS_REGION, to the bucket's region such as eu-west-1.",
    );
  }
  return new S3AttachmentStore(
    new S3Archive({
      bucket: bucket!,
      prefix,
      region: config.region,
      ...(config.endpoint === null ? {} : { endpoint: config.endpoint }),
    }),
  );
}
