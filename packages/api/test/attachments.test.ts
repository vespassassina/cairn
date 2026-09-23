import { NotFoundError, ValidationError } from "@cairn/core";
import { eventually } from "@cairn/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encode as encodePng } from "@jsquash/png";
import { encode as encodeJpeg } from "@jsquash/jpeg";
import { encode as encodeWebp } from "@jsquash/webp";
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

/**
 * In-memory blob store. `_land` stands in for the PUT a real caller would
 * make straight to the signed upload URL; it takes either a byte count (the
 * original tests, which only ever care about size) or real bytes (the
 * thumbnail tests below, which need something a codec can actually decode).
 * `put`/`get` back the thumbnail's own server-side write and read.
 */
function fakeStore(initial: Record<string, number> = {}): AttachmentBlobStore {
  const blobs = new Map<string, Uint8Array>();
  for (const [key, bytes] of Object.entries(initial)) blobs.set(key, new Uint8Array(bytes));
  return {
    async head(key) {
      const found = blobs.get(key);
      return found === undefined ? null : { bytes: found.length };
    },
    async uploadUrl(key) {
      return `https://blob.example/${key}?upload`;
    },
    async downloadUrl(key, _expires, filename) {
      return `https://blob.example/${key}?download&filename=${encodeURIComponent(filename)}`;
    },
    async put(key, bytes) {
      blobs.set(key, bytes);
    },
    async get(key) {
      return blobs.get(key) ?? null;
    },
    _land(key: string, bytes: number | Uint8Array) {
      blobs.set(key, typeof bytes === "number" ? new Uint8Array(bytes) : bytes);
    },
  } as AttachmentBlobStore & { _land(key: string, bytes: number | Uint8Array): void };
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

  describe("thumbnails (ADR-064 decision 6, ADR-068)", () => {
    /** A tiny solid-colour image, real pixels through the real codec — not a stub. */
    function pixels(width: number, height: number): Uint8ClampedArray {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 200;
        data[i + 1] = 40;
        data[i + 2] = 40;
        data[i + 3] = 255;
      }
      return data;
    }

    // Larger than the 320px target on both edges, so a real resize happens,
    // not just a re-encode.
    const WIDTH = 400;
    const HEIGHT = 300;

    async function fixture(contentType: "image/png" | "image/jpeg" | "image/webp"): Promise<Uint8Array> {
      const data = pixels(WIDTH, HEIGHT);
      const encoded =
        contentType === "image/png"
          ? await encodePng({ data, width: WIDTH, height: HEIGHT })
          : contentType === "image/jpeg"
            ? await encodeJpeg({ data, width: WIDTH, height: HEIGHT })
            : await encodeWebp({ data, width: WIDTH, height: HEIGHT });
      return new Uint8Array(encoded);
    }

    for (const contentType of ["image/png", "image/jpeg", "image/webp"] as const) {
      it(`generates a thumbnail for a committed ${contentType} attachment`, async () => {
        const store = fakeStore() as ReturnType<typeof fakeStore> & { _land(key: string, bytes: number | Uint8Array): void };
        context.attachmentsStore = store;
        await page("pg_a");
        const bytes = await fixture(contentType);
        const { row } = await createAttachment(
          context,
          { pageId: "pg_a", filename: `photo.${contentType.split("/")[1]}`, altText: null, sha256: SHA, contentType, bytes: bytes.length },
          { actor: OWNER },
        );
        store._land(row.blobKey, bytes);
        const confirmed = await confirmAttachmentUpload(context, row.id, { actor: OWNER });
        // Thumbnail generation is queued after confirm and never awaited by
        // it (decision 6), so the confirm response itself never carries one.
        expect(confirmed.thumbnailKey).toBeNull();

        const withThumbnail = await eventually(async () => {
          const { row: current } = await getAttachment(context, row.id);
          if (current.thumbnailKey === null) throw new Error("thumbnail not generated yet");
          return current;
        });
        expect(withThumbnail.thumbnailKey).toBe(`${row.blobKey}-thumb`);
        const stored = await store.get(withThumbnail.thumbnailKey!);
        expect(stored).not.toBeNull();
        expect(stored!.length).toBeGreaterThan(0);
      });
    }

    it("leaves thumbnailKey null, and does not throw, when the uploaded bytes are corrupt", async () => {
      const store = fakeStore() as ReturnType<typeof fakeStore> & { _land(key: string, bytes: number | Uint8Array): void };
      context.attachmentsStore = store;
      await page("pg_a");
      const corrupt = new Uint8Array([1, 2, 3, 4, 5]);
      const { row } = await createAttachment(
        context,
        { pageId: "pg_a", filename: "broken.png", altText: null, sha256: SHA, contentType: "image/png", bytes: corrupt.length },
        { actor: OWNER },
      );
      store._land(row.blobKey, corrupt);
      const confirmed = await confirmAttachmentUpload(context, row.id, { actor: OWNER });
      expect(confirmed.status).toBe("committed");
      expect(confirmed.thumbnailKey).toBeNull();

      // The background attempt runs and fails fast on corrupt bytes; give it
      // a moment, then confirm it never set the field rather than merely
      // that it had not yet, the way a bare `eventually` on a positive
      // condition could not.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const { row: after } = await getAttachment(context, row.id);
      expect(after.thumbnailKey).toBeNull();
    });

    it("leaves thumbnailKey null for a GIF: ADR-068's @jsquash/gif does not exist on npm (see docs/LESSONS.md)", async () => {
      const store = fakeStore() as ReturnType<typeof fakeStore> & { _land(key: string, bytes: number | Uint8Array): void };
      context.attachmentsStore = store;
      await page("pg_a");
      // GIF89a header plus a minimal trailer is enough to prove this is about
      // the missing decoder, not about the bytes being unparsable.
      const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x3b]);
      const { row } = await createAttachment(
        context,
        { pageId: "pg_a", filename: "a.gif", altText: null, sha256: SHA, contentType: "image/gif", bytes: gif.length },
        { actor: OWNER },
      );
      store._land(row.blobKey, gif);
      const confirmed = await confirmAttachmentUpload(context, row.id, { actor: OWNER });
      expect(confirmed.status).toBe("committed");

      await new Promise((resolve) => setTimeout(resolve, 200));
      const { row: after } = await getAttachment(context, row.id);
      expect(after.thumbnailKey).toBeNull();
    });

    it("does not generate a thumbnail for a non-raster attachment type", async () => {
      const store = fakeStore() as ReturnType<typeof fakeStore> & { _land(key: string, bytes: number | Uint8Array): void };
      context.attachmentsStore = store;
      await page("pg_a");
      const bytes = new Uint8Array([1, 2, 3]);
      const { row } = await createAttachment(
        context,
        { pageId: "pg_a", filename: "a.zip", altText: null, sha256: SHA, contentType: "application/zip", bytes: bytes.length },
        { actor: OWNER },
      );
      store._land(row.blobKey, bytes);
      const confirmed = await confirmAttachmentUpload(context, row.id, { actor: OWNER });
      expect(confirmed.thumbnailKey).toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 200));
      const { row: after } = await getAttachment(context, row.id);
      expect(after.thumbnailKey).toBeNull();
    });
  });
});
