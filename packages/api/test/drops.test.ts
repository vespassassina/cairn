import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeContext, createContext, OWNER, type AppContext } from "../src/context.js";
import type { AttachmentBlobStore } from "../src/attachments-blob.js";
import { AttachmentsDisabledError, listAttachmentsForPage } from "../src/attachments.js";
import { eventually } from "@cairn/core/testing";
import { createDrop, dropTitle, listDrops, moveRecord, searchPages } from "../src/operations.js";
import { INBOX_COLLECTION_NAME } from "../src/templates.js";

const AGENT = { kind: "agent", id: "claude", label: "Claude" } as const;

/**
 * The dropbox (ADR-079 decisions 1 and 2): a drop is an ordinary page under
 * the well-known Inbox collection, titled by fixed rules, its files uploaded
 * server-side and linked from the body. Sprint 2 task 1 of `docs/PLAN.md`,
 * against `docs/specs/dropbox.md` "The Inbox".
 */

/** In-memory blob store, the same stand-in attachments.test.ts uses. */
function fakeStore(): AttachmentBlobStore {
  const blobs = new Map<string, Uint8Array>();
  return {
    async head(key) {
      const found = blobs.get(key);
      return found ? { bytes: found.byteLength } : null;
    },
    async uploadUrl(key) {
      return `https://blob.example/${key}?upload`;
    },
    async downloadUrl(key, _seconds, filename) {
      return `https://blob.example/${key}?download&filename=${encodeURIComponent(filename)}`;
    },
    async put(key, bytes) {
      blobs.set(key, bytes);
    },
    async get(key) {
      return blobs.get(key) ?? null;
    },
  } as AttachmentBlobStore;
}

describe("dropTitle", () => {
  const now = new Date("2026-09-24T19:31:07Z");

  it("takes the title field first, then the first line of the text cut at 80, then the first filename, then the timestamp", () => {
    expect(dropTitle({ title: "Call Anna", text: "something else", filenames: ["a.pdf"], now })).toBe("Call Anna");
    expect(dropTitle({ text: "call Anna re: NAS\nsecond line", filenames: ["a.pdf"], now })).toBe("call Anna re: NAS");
    const long = "x".repeat(100);
    expect(dropTitle({ text: `${long}\nmore`, filenames: [], now })).toBe("x".repeat(80));
    expect(dropTitle({ text: "  \n\n", filenames: ["IMG_0042.jpeg", "b.pdf"], now })).toBe("IMG_0042.jpeg");
    expect(dropTitle({ filenames: [], now })).toBe("2026-09-24 19:31");
    // A blank title field is no title.
    expect(dropTitle({ title: "   ", text: "the text", filenames: [], now })).toBe("the text");
  });
});

describe("createDrop", () => {
  let context: AppContext;

  beforeEach(async () => {
    context = await createContext({ database: ":memory:", workspaceId: "ws_drops" });
  });

  afterEach(async () => {
    await closeContext(context);
  });

  async function inbox() {
    const roots = await context.store.listPages(context.workspaceId, { parentId: null, limit: 50 });
    return roots.items.find((page) => page.title === INBOX_COLLECTION_NAME) ?? null;
  }

  it("creates the Inbox on first use and files a text drop under it with tags, the drop tag and the url as a source", async () => {
    expect(await inbox()).toBeNull();

    const page = await createDrop(
      context,
      { text: "call Anna re: NAS\nshe has the disks", tags: ["todo", "drop"], url: "https://example.com/nas" },
      { actor: OWNER, note: 'Dropped via token "phone"' },
    );

    const root = await inbox();
    expect(root).not.toBeNull();
    expect(page.parentId).toBe(root?.id);
    expect(page.title).toBe("call Anna re: NAS");
    expect(page.body).toBe("call Anna re: NAS\nshe has the disks");
    // `drop` is added once, whatever the caller sent.
    expect(page.tags).toEqual(["todo", "drop"]);
    expect(page.sources).toEqual(["https://example.com/nas"]);

    const [latest] = await context.pages.history(context.workspaceId, page.id, { limit: 1 });
    expect(latest?.note).toBe('Dropped via token "phone"');

    // A second drop reuses the same Inbox.
    const second = await createDrop(context, { text: "two" }, { actor: OWNER });
    expect(second.parentId).toBe(root?.id);
    expect(second.tags).toEqual(["drop"]);
    expect(second.sources).toEqual([]);
    const roots = await context.store.listPages(context.workspaceId, { parentId: null, limit: 50 });
    expect(roots.items.filter((p) => p.title === INBOX_COLLECTION_NAME)).toHaveLength(1);
  });

  it("uploads each file server-side, commits it, and links it from the body after a blank line, images as image links", async () => {
    context.attachmentsStore = fakeStore();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 4, 5]);

    const page = await createDrop(
      context,
      {
        text: "the disks",
        files: [
          { filename: "IMG_0042.png", contentType: "image/png", bytes: png },
          { filename: "quote.pdf", contentType: "application/pdf", bytes: pdf },
        ],
      },
      { actor: OWNER },
    );

    const attachments = await listAttachmentsForPage(context, page.id);
    expect(attachments.map((a) => a.filename).sort()).toEqual(["IMG_0042.png", "quote.pdf"]);
    expect(attachments.every((a) => a.status === "committed")).toBe(true);
    const image = attachments.find((a) => a.filename === "IMG_0042.png");
    const doc = attachments.find((a) => a.filename === "quote.pdf");
    expect(page.body).toBe(`the disks\n\n![IMG_0042.png](attachment:${image?.id})\n[quote.pdf](attachment:${doc?.id})`);
    // The bytes landed under their hash, so the existing download path serves them.
    expect(await context.attachmentsStore.get(image!.blobKey)).toEqual(png);
  });

  it("titles a files-only drop after the first file and puts the links alone in the body", async () => {
    context.attachmentsStore = fakeStore();
    const page = await createDrop(
      context,
      { files: [{ filename: "quote.pdf", contentType: "application/pdf", bytes: new Uint8Array([1, 2, 3]) }] },
      { actor: OWNER },
    );
    expect(page.title).toBe("quote.pdf");
    expect(page.body).toMatch(/^\[quote\.pdf\]\(attachment:[A-Za-z0-9_-]+\)$/);
  });

  it("refuses a drop with files when attachments are off, naming the setting, and leaves nothing behind", async () => {
    await expect(
      createDrop(context, { text: "with a file", files: [{ filename: "a.txt", contentType: "text/plain", bytes: new Uint8Array([1]) }] }, { actor: OWNER }),
    ).rejects.toThrow(AttachmentsDisabledError);
    await expect(createDrop(context, { text: "x", files: [{ filename: "a.txt", contentType: "text/plain", bytes: new Uint8Array([1]) }] }, { actor: OWNER })).rejects.toThrow(
      /CAIRN_ATTACHMENTS_TO/,
    );
    // Checked before anything is written: no Inbox, no page.
    expect(await inbox()).toBeNull();
    // A text-only drop still works with attachments off.
    const page = await createDrop(context, { text: "just text" }, { actor: OWNER });
    expect(page.title).toBe("just text");
  });

  // Spec criterion 8: a drop is an ordinary page, so search finds it, and once
  // an agent has absorbed it (a link from the target page, then the move) the
  // drop's backlinks say where it went and the Inbox is empty again.
  it("is searchable like any page, and after filing the target page's link is a backlink and the Inbox is empty", async () => {
    const target = await context.pages.create(context.workspaceId, { title: "NAS", body: "The Synology in the cupboard.", tags: [] }, { actor: OWNER });
    const drop = await createDrop(context, { text: "call Anna about the NAS warranty renewal" }, { actor: OWNER });
    await eventually(async () => {
      const found = await searchPages(context, { query: "NAS warranty renewal" });
      expect(found.pages.map((p) => p.pageId)).toContain(drop.id);
    });
    expect((await listDrops(context)).map((p) => p.id)).toEqual([drop.id]);

    const linked = await context.pages.update(
      context.workspaceId,
      target.id,
      { title: target.title, tags: target.tags, body: `${target.body}\n\nWarranty: renew, see [[${drop.id}]].` },
      target.version,
      { actor: AGENT, changeNote: `from drop ${drop.id}` },
    );
    await moveRecord(context, drop.id, target.id, drop.version, { actor: AGENT, changeNote: "filed under NAS" });

    expect((await context.store.getPage(context.workspaceId, drop.id))?.parentId).toBe(target.id);
    expect(await listDrops(context)).toEqual([]);
    await eventually(async () => {
      const backlinks = await context.pages.backlinks(context.workspaceId, drop.id);
      expect(backlinks.map((edge) => edge.sourceId)).toContain(linked.id);
    });
  });
});
