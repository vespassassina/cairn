import { NotFoundError, ValidationError } from "@cairn/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeContext, createContext, OWNER, type AppContext } from "../src/context.js";
import type { AttachmentBlobStore } from "../src/attachments-blob.js";
import {
  confirmAttachmentUpload,
  createAttachment,
  deleteAttachment,
  getAttachment,
  listAttachmentsForPage,
  sweepAbandonedAttachments,
  AttachmentsDisabledError,
} from "../src/attachments.js";

/**
 * Attachments (ADR-064): the row lifecycle (pending -> committed), its
 * guards (size, content type, disabled), and the sweep. Exercised against a
 * fake `AttachmentBlobStore` rather than a real S3/Azure stub: the signed-URL
 * wiring itself, and that a real request reaches the right path and params,
 * is covered in attachments-blob.test.ts. This file is about the rules this
 * module enforces on its own, the same split publish-tokens.test.ts and
 * backup-remote.test.ts already use for their own modules.
 */

const SHA = "a".repeat(64);

/** In-memory blob store: `bytes` set by the test stands in for "the upload landed". */
function fakeStore(initial: Record<string, number> = {}): AttachmentBlobStore {
  const sizes = new Map(Object.entries(initial));
  return {
    async head(key) {
      const bytes = sizes.get(key);
      return bytes === undefined ? null : { bytes };
    },
    async uploadUrl(key) {
      return `https://blob.example/${key}?upload`;
    },
    async downloadUrl(key, _expires, filename) {
      return `https://blob.example/${key}?download&filename=${encodeURIComponent(filename)}`;
    },
    // Test-only: marks the blob as landed, standing in for the PUT a real
    // caller would make straight to the signed upload URL.
    _land(key: string, bytes: number) {
      sizes.set(key, bytes);
    },
  } as AttachmentBlobStore & { _land(key: string, bytes: number): void };
}

describe("attachments (ADR-064)", () => {
  let context: AppContext;

  beforeEach(async () => {
    context = await createContext({ database: ":memory:", workspaceId: "ws_attachments" });
  });

  afterEach(async () => {
    await closeContext(context);
  });

  async function page(id: string) {
    return context.pages.create(context.workspaceId, { title: id, body: "", public: false }, { actor: OWNER }, id);
  }

  it("refuses to create an attachment when no attachment storage is configured", async () => {
    await page("pg_a");
    await expect(
      createAttachment(context, { pageId: "pg_a", filename: "a.png", altText: null, sha256: SHA, contentType: "image/png", bytes: 100 }, { actor: OWNER }),
    ).rejects.toThrow(AttachmentsDisabledError);
  });

  it("refuses to issue an upload for a page that does not exist", async () => {
    context.attachmentsStore = fakeStore();
    await expect(
      createAttachment(context, { pageId: "gone", filename: "a.png", altText: null, sha256: SHA, contentType: "image/png", bytes: 100 }, { actor: OWNER }),
    ).rejects.toThrow(NotFoundError);
  });

  it("refuses text/html and image/svg+xml outright", async () => {
    context.attachmentsStore = fakeStore();
    await page("pg_a");
    for (const contentType of ["text/html", "image/svg+xml"]) {
      await expect(
        createAttachment(context, { pageId: "pg_a", filename: "a", altText: null, sha256: SHA, contentType, bytes: 10 }, { actor: OWNER }),
      ).rejects.toThrow(ValidationError);
    }
  });

  it("refuses more than 25 MB", async () => {
    context.attachmentsStore = fakeStore();
    await page("pg_a");
    await expect(
      createAttachment(context, { pageId: "pg_a", filename: "a.zip", altText: null, sha256: SHA, contentType: "application/zip", bytes: 26 * 1024 * 1024 }, { actor: OWNER }),
    ).rejects.toThrow(ValidationError);
  });

  it("creates a pending row and an upload URL for its sha256 key", async () => {
    context.attachmentsStore = fakeStore();
    await page("pg_a");
    const { row, uploadUrl } = await createAttachment(
      context,
      { pageId: "pg_a", filename: "photo.png", altText: "a photo", sha256: SHA, contentType: "image/png", bytes: 5 },
      { actor: OWNER },
    );
    expect(row.status).toBe("pending");
    expect(row.blobKey).toBe(`sha256/${SHA}`);
    expect(uploadUrl).toContain(row.blobKey);
  });

  it("confirm refuses clearly when nothing was uploaded yet", async () => {
    const store = fakeStore();
    context.attachmentsStore = store;
    await page("pg_a");
    const { row } = await createAttachment(
      context,
      { pageId: "pg_a", filename: "photo.png", altText: null, sha256: SHA, contentType: "image/png", bytes: 5 },
      { actor: OWNER },
    );
    await expect(confirmAttachmentUpload(context, row.id, { actor: OWNER })).rejects.toThrow(ValidationError);
  });

  it("confirm refuses when the uploaded size does not match what was declared", async () => {
    const store = fakeStore() as ReturnType<typeof fakeStore> & { _land(key: string, bytes: number): void };
    context.attachmentsStore = store;
    await page("pg_a");
    const { row } = await createAttachment(
      context,
      { pageId: "pg_a", filename: "photo.png", altText: null, sha256: SHA, contentType: "image/png", bytes: 5 },
      { actor: OWNER },
    );
    store._land(row.blobKey, 999);
    await expect(confirmAttachmentUpload(context, row.id, { actor: OWNER })).rejects.toThrow(ValidationError);
  });

  it("confirms a matching upload, and it then appears in the page's list and get_attachment", async () => {
    const store = fakeStore() as ReturnType<typeof fakeStore> & { _land(key: string, bytes: number): void };
    context.attachmentsStore = store;
    await page("pg_a");
    const { row } = await createAttachment(
      context,
      { pageId: "pg_a", filename: "photo.png", altText: "a photo", sha256: SHA, contentType: "image/png", bytes: 5 },
      { actor: OWNER },
    );
    store._land(row.blobKey, 5);
    const confirmed = await confirmAttachmentUpload(context, row.id, { actor: OWNER });
    expect(confirmed.status).toBe("committed");

    const listed = await listAttachmentsForPage(context, "pg_a");
    expect(listed.map((a) => a.id)).toEqual([row.id]);

    const { row: fetched, downloadUrl } = await getAttachment(context, row.id);
    expect(fetched.status).toBe("committed");
    expect(downloadUrl).toContain("photo.png");
  });

  it("get_attachment on a pending row returns no download URL", async () => {
    context.attachmentsStore = fakeStore();
    await page("pg_a");
    const { row } = await createAttachment(
      context,
      { pageId: "pg_a", filename: "photo.png", altText: null, sha256: SHA, contentType: "image/png", bytes: 5 },
      { actor: OWNER },
    );
    const { downloadUrl } = await getAttachment(context, row.id);
    expect(downloadUrl).toBeNull();
  });

  it("a pending attachment does not appear in the page's list", async () => {
    context.attachmentsStore = fakeStore();
    await page("pg_a");
    await createAttachment(
      context,
      { pageId: "pg_a", filename: "photo.png", altText: null, sha256: SHA, contentType: "image/png", bytes: 5 },
      { actor: OWNER },
    );
    expect(await listAttachmentsForPage(context, "pg_a")).toEqual([]);
  });

  it("deletes the row but never the blob: head still finds it after delete", async () => {
    const store = fakeStore() as ReturnType<typeof fakeStore> & { _land(key: string, bytes: number): void };
    context.attachmentsStore = store;
    await page("pg_a");
    const { row } = await createAttachment(
      context,
      { pageId: "pg_a", filename: "photo.png", altText: null, sha256: SHA, contentType: "image/png", bytes: 5 },
      { actor: OWNER },
    );
    store._land(row.blobKey, 5);
    const confirmed = await confirmAttachmentUpload(context, row.id, { actor: OWNER });

    await deleteAttachment(context, row.id, confirmed.version, { actor: OWNER });
    await expect(getAttachment(context, row.id)).rejects.toThrow(NotFoundError);
    expect(await store.head(row.blobKey)).toEqual({ bytes: 5 });
  });

  it("sweeps a pending row past the cutoff with no matching blob", async () => {
    context.attachmentsStore = fakeStore();
    await page("pg_a");
    const { row: old } = await createAttachment(
      context,
      { pageId: "pg_a", filename: "old.png", altText: null, sha256: SHA, contentType: "image/png", bytes: 5 },
      { actor: OWNER },
    );

    // Everything created in this test is "now", so a cutoff of 0ms treats it
    // as already past the timeout: the same shape as a real row created over
    // an hour ago, without needing to fake the clock or the store's write path.
    const swept = await sweepAbandonedAttachments(context, 0);
    expect(swept.removed).toBe(1);
    await expect(getAttachment(context, old.id)).rejects.toThrow(NotFoundError);
  });

  it("leaves a pending row alone while it is within the sweep's age cutoff", async () => {
    context.attachmentsStore = fakeStore();
    await page("pg_a");
    const { row: recent } = await createAttachment(
      context,
      { pageId: "pg_a", filename: "recent.png", altText: null, sha256: SHA, contentType: "image/png", bytes: 5 },
      { actor: OWNER },
    );
    const swept = await sweepAbandonedAttachments(context);
    expect(swept.removed).toBe(0);
    expect((await getAttachment(context, recent.id)).row.id).toBe(recent.id);
  });

  it("leaves a pending row alone once its blob has landed, even past the cutoff", async () => {
    const store = fakeStore() as ReturnType<typeof fakeStore> & { _land(key: string, bytes: number): void };
    context.attachmentsStore = store;
    await page("pg_a");
    const { row } = await createAttachment(
      context,
      { pageId: "pg_a", filename: "landed.png", altText: null, sha256: SHA, contentType: "image/png", bytes: 5 },
      { actor: OWNER },
    );
    store._land(row.blobKey, 5);
    const swept = await sweepAbandonedAttachments(context, 0);
    expect(swept.removed).toBe(0);
    expect((await getAttachment(context, row.id)).row.id).toBe(row.id);
  });
});
