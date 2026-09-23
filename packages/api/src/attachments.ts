import { NotFoundError, ValidationError } from "@cairn/core";
import type { WriteContext } from "@cairn/core";
import type { AppContext } from "./context.js";
import { ownerVia } from "./context.js";

/**
 * Attachments (ADR-064): binary files, uploaded direct to blob storage and
 * referenced from a page body as `attachment:<row-id>`. Metadata is a row in
 * a built-in table, same shape as `publish-tokens.ts` and `citations.ts`:
 * created lazily on first use, since there is no eager workspace-init
 * mechanism anywhere in this codebase.
 *
 * The bytes never pass through this module, or through the API process at
 * all (decision 3): this only issues signed URLs and checks what landed.
 */

export const ATTACHMENTS_TABLE_NAME = "Attachments";

/** ADR-064's 25 MB ceiling, checked before an upload URL is even issued. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Refused outright (decision 5): an SVG can carry a script, and HTML is HTML. */
const NEVER_SERVED_TYPES = new Set(["text/html", "image/svg+xml"]);

/** Long enough for a slow upload, short enough that a leaked URL is not a standing hole. */
const UPLOAD_URL_SECONDS = 15 * 60;
const DOWNLOAD_URL_SECONDS = 10 * 60;

/** A pending row older than this with no matching blob is abandoned (decision 3.4). */
const PENDING_TIMEOUT_MS = 60 * 60 * 1000;

export class AttachmentsDisabledError extends ValidationError {
  constructor() {
    super([
      {
        field: "attachments",
        message:
          "attachments are off. Set CAIRN_ATTACHMENTS_TO to abs://<account>@<container>/<prefix> or " +
          "s3://<bucket>/<prefix> and restart. See docs/AGENT-OPERATE.md.",
      },
    ]);
  }
}

async function findOrCreateTable(context: AppContext) {
  const existing = (await context.tables.list(context.workspaceId)).find((t) => t.name === ATTACHMENTS_TABLE_NAME);
  if (existing) return existing;
  return context.tables.create(
    context.workspaceId,
    {
      name: ATTACHMENTS_TABLE_NAME,
      fields: [
        { name: "page", type: "relation", target: "pages", required: true },
        { name: "filename", type: "text", required: true },
        { name: "altText", type: "text" },
        { name: "blobKey", type: "text", required: true },
        { name: "sha256", type: "text", required: true },
        { name: "contentType", type: "text", required: true },
        { name: "bytes", type: "number", required: true },
        // Not in the ADR's table: the ADR describes the pending->committed
        // upload lifecycle in decision 3 but its field table omits the field
        // that tracks it. Added here to close that gap (resolved inline per
        // the owner's direction, no addendum ADR).
        { name: "status", type: "select", options: ["pending", "committed"], required: true },
      ],
    },
    { actor: ownerVia("attachment") },
  );
}

async function table(context: AppContext) {
  const found = (await context.tables.list(context.workspaceId)).find((t) => t.name === ATTACHMENTS_TABLE_NAME);
  if (!found) throw new NotFoundError("attachment", "(no attachments uploaded yet)");
  return found;
}

export interface AttachmentSummary {
  id: string;
  page: string;
  filename: string;
  altText: string | null;
  blobKey: string;
  sha256: string;
  contentType: string;
  bytes: number;
  status: "pending" | "committed";
  version: string;
  createdAt: string;
}

function summarize(row: { id: string; values: Record<string, unknown>; version: string; createdAt: string }): AttachmentSummary {
  return {
    id: row.id,
    page: String(row.values["page"] ?? ""),
    filename: String(row.values["filename"] ?? ""),
    altText: typeof row.values["altText"] === "string" ? (row.values["altText"] as string) : null,
    blobKey: String(row.values["blobKey"] ?? ""),
    sha256: String(row.values["sha256"] ?? ""),
    contentType: String(row.values["contentType"] ?? ""),
    bytes: Number(row.values["bytes"] ?? 0),
    status: row.values["status"] === "committed" ? "committed" : "pending",
    version: row.version,
    createdAt: row.createdAt,
  };
}

function requireBlobStore(context: AppContext): NonNullable<AppContext["attachmentsStore"]> {
  if (!context.attachmentsStore) throw new AttachmentsDisabledError();
  return context.attachmentsStore;
}

/**
 * Creates a `pending` row and mints a signed upload URL for its blob key.
 * The caller PUTs the bytes there directly, then calls `confirmAttachmentUpload`.
 */
export async function createAttachment(
  context: AppContext,
  params: { pageId: string; filename: string; altText: string | null | undefined; sha256: string; contentType: string; bytes: number },
  by: WriteContext,
): Promise<{ row: AttachmentSummary; uploadUrl: string }> {
  const store = requireBlobStore(context);

  const page = await context.store.getPage(context.workspaceId, params.pageId);
  if (!page) throw new NotFoundError("page", params.pageId);

  if (NEVER_SERVED_TYPES.has(params.contentType.toLowerCase())) {
    throw new ValidationError([
      {
        field: "contentType",
        message: `${params.contentType} is refused outright: it can carry a script a browser would run (ADR-064 decision 5).`,
      },
    ]);
  }
  if (params.bytes <= 0 || params.bytes > MAX_ATTACHMENT_BYTES) {
    throw new ValidationError([
      { field: "bytes", message: `must be greater than 0 and at most ${MAX_ATTACHMENT_BYTES} (25 MB), got ${params.bytes}` },
    ]);
  }
  if (!/^[0-9a-f]{64}$/i.test(params.sha256)) {
    throw new ValidationError([{ field: "sha256", message: "must be 64 hex characters, the SHA-256 of the file's bytes" }]);
  }

  const blobKey = `sha256/${params.sha256.toLowerCase()}`;
  const tbl = await findOrCreateTable(context);
  const row = await context.tables.upsertRow(
    context.workspaceId,
    tbl.id,
    {
      values: {
        page: params.pageId,
        filename: params.filename,
        altText: params.altText ?? null,
        blobKey,
        sha256: params.sha256.toLowerCase(),
        contentType: params.contentType,
        bytes: params.bytes,
        status: "pending",
      },
    },
    by,
  );
  const uploadUrl = await store.uploadUrl(blobKey, UPLOAD_URL_SECONDS);
  return { row: summarize(row), uploadUrl };
}

/**
 * Confirms an upload landed: HEADs the blob, checks its size against what was
 * declared, then flips the row to `committed`. Refuses clearly when nothing
 * is there yet, or when the size does not match (ADR-064 decision 3.4).
 */
export async function confirmAttachmentUpload(context: AppContext, rowId: string, by: WriteContext): Promise<AttachmentSummary> {
  const store = requireBlobStore(context);
  const tbl = await table(context);
  const row = await context.tables.getRow(context.workspaceId, tbl.id, rowId);
  const current = summarize(row);
  if (current.status === "committed") return current;

  const found = await store.head(current.blobKey);
  if (!found) {
    throw new ValidationError([
      { field: "upload", message: `nothing was uploaded yet for ${current.filename}. PUT the bytes to the upload URL from create_attachment first, then confirm again.` },
    ]);
  }
  if (found.bytes !== current.bytes) {
    throw new ValidationError([
      { field: "bytes", message: `the uploaded object is ${found.bytes} bytes, but ${current.bytes} was declared when the upload URL was issued. Re-upload the exact file, or create a new attachment with the right size.` },
    ]);
  }

  const updated = await context.tables.upsertRow(
    context.workspaceId,
    tbl.id,
    { values: { ...row.values, status: "committed" } },
    by,
    { id: row.id, expectedVersion: row.version },
  );
  return summarize(updated);
}

/**
 * The row plus a signed download URL, only once committed: a caller asking
 * before confirming should retry after `confirm_attachment_upload`, not be
 * handed a URL to a blob that may not exist.
 */
export async function getAttachment(context: AppContext, rowId: string): Promise<{ row: AttachmentSummary; downloadUrl: string | null }> {
  const tbl = await table(context);
  const row = summarize(await context.tables.getRow(context.workspaceId, tbl.id, rowId));
  if (row.status !== "committed") return { row, downloadUrl: null };
  const store = requireBlobStore(context);
  const downloadUrl = await store.downloadUrl(row.blobKey, DOWNLOAD_URL_SECONDS, row.filename);
  return { row, downloadUrl };
}

/** Every committed attachment on a page, for a page's attachment list or export. */
export async function listAttachmentsForPage(context: AppContext, pageId: string): Promise<AttachmentSummary[]> {
  const found = (await context.tables.list(context.workspaceId)).find((t) => t.name === ATTACHMENTS_TABLE_NAME);
  if (!found) return [];
  const summaries: AttachmentSummary[] = [];
  let cursor: string | null = null;
  do {
    const batch = await context.tables.queryRows(context.workspaceId, found.id, {
      where: [
        { field: "page", op: "eq", value: pageId },
        { field: "status", op: "eq", value: "committed" },
      ],
      limit: 500,
      cursor,
    });
    for (const row of batch.items) summaries.push(summarize(row));
    cursor = batch.cursor;
  } while (cursor !== null);
  return summaries;
}

/**
 * Deletes the row. The blob is never touched here (decision 2/7: content is
 * immutable and shared by hash, and the row is the source of truth for what
 * is live), so a delete is cheap and instant; blob garbage collection is a
 * later maintenance pass, per the ADR's consequence 3.
 */
export async function deleteAttachment(context: AppContext, rowId: string, expectedVersion: string, by: WriteContext): Promise<void> {
  const tbl = await table(context);
  await context.tables.deleteRow(context.workspaceId, tbl.id, rowId, expectedVersion, by);
}

/**
 * Deletes `pending` rows older than an hour with no matching committed blob:
 * an abandoned upload (the caller never PUT the bytes, or never confirmed)
 * leaves no orphan row behind (ADR-064 decision 3.4). Best-effort maintenance
 * work, not on any write path. Not wired into a periodic runner: this
 * codebase has none today (checked, none of `packages/api/src` schedules
 * anything). Whoever adds one should call this from it; until then it can be
 * run by hand or from a cron-like job outside the process.
 */
export async function sweepAbandonedAttachments(context: AppContext, olderThanMs = PENDING_TIMEOUT_MS): Promise<{ removed: number }> {
  const found = (await context.tables.list(context.workspaceId)).find((t) => t.name === ATTACHMENTS_TABLE_NAME);
  if (!found) return { removed: 0 };
  const store = context.attachmentsStore;
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  let cursor: string | null = null;
  do {
    const batch = await context.tables.queryRows(context.workspaceId, found.id, {
      where: [{ field: "status", op: "eq", value: "pending" }],
      limit: 500,
      cursor,
    });
    for (const row of batch.items) {
      if (Date.parse(row.createdAt) > cutoff) continue;
      // A store already committed by a race that landed between this list and
      // now is left alone; only a row with no blob at all is abandoned.
      const found2 = store ? await store.head(String(row.values["blobKey"] ?? "")) : null;
      if (found2) continue;
      await context.tables.deleteRow(context.workspaceId, found.id, row.id, row.version, { actor: ownerVia("attachment-sweep") });
      removed += 1;
    }
    cursor = batch.cursor;
  } while (cursor !== null);
  return { removed };
}
