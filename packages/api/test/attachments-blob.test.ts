import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentsConfigError, openAttachmentsStore } from "../src/attachments-blob.js";
import type { AttachmentsConfig } from "../src/config.js";

/**
 * The dispatcher that turns `CAIRN_ATTACHMENTS_TO` into signed upload and
 * download URLs (ADR-064 decision 3): that it reaches the S3 and Azure REST
 * shapes `S3Archive` and `AzureBlobArchive` already speak, not that SigV4 or
 * SAS signing themselves are correct (backup-remote.test.ts already proves
 * that against real test vectors and a strict stub).
 */

let server: Server | null = null;

beforeEach(() => {
  // S3Archive falls back to the platform's own credential chain, which
  // means IMDS network calls that hang in a test sandbox. Plain env
  // credentials short-circuit that, the same way a real deployment's would.
  process.env["AWS_ACCESS_KEY_ID"] = "test-key";
  process.env["AWS_SECRET_ACCESS_KEY"] = "test-secret";
});

afterEach(async () => {
  delete process.env["AWS_ACCESS_KEY_ID"];
  delete process.env["AWS_SECRET_ACCESS_KEY"];
  if (server !== null) await new Promise((done) => server!.close(done));
  server = null;
});

async function serve(handler: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void): Promise<string> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => handler(request, response, Buffer.concat(chunks)));
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

describe("openAttachmentsStore", () => {
  it("is null when attachments are off", () => {
    expect(openAttachmentsStore({ to: null, region: null, endpoint: null })).toBeNull();
  });

  it("refuses an s3 address with no usable prefix, naming the two valid forms", () => {
    expect(() => openAttachmentsStore({ to: "ftp://nope", region: null, endpoint: null })).toThrow(AttachmentsConfigError);
  });

  it("issues an S3 upload URL that a bare PUT reaches at the object's key, and a download URL naming the file", async () => {
    const held = new Map<string, Buffer>();
    const endpoint = await serve((request, response, body) => {
      const url = new URL(request.url!, "http://s3");
      const key = decodeURIComponent(url.pathname.replace(/^\/cairn-attachments\/?/, ""));
      if (request.method === "PUT") {
        expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
        held.set(key, body);
        response.writeHead(200).end();
        return;
      }
      if (request.method === "HEAD") {
        const found = held.get(key);
        if (!found) response.writeHead(404).end();
        else response.writeHead(200, { "content-length": String(found.length) }).end();
        return;
      }
      // GET
      expect(url.searchParams.get("response-content-disposition")).toContain("photo.png");
      expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
      const found = held.get(key);
      if (!found) response.writeHead(404).end();
      else response.writeHead(200).end(found);
    });

    const config: AttachmentsConfig = { to: "s3://cairn-attachments/attachments", region: "eu-west-1", endpoint };
    const store = openAttachmentsStore(config)!;

    const key = "sha256/abc123";
    expect(await store.head(key)).toBeNull();

    const uploadUrl = await store.uploadUrl(key, 900);
    const put = await fetch(uploadUrl, { method: "PUT", body: "hello" });
    expect(put.ok).toBe(true);

    const head = await store.head(key);
    expect(head).toEqual({ bytes: 5 });

    const downloadUrl = await store.downloadUrl(key, 600, "photo.png");
    const get = await fetch(downloadUrl);
    expect(await get.text()).toBe("hello");
  });

  it("writes and reads bytes directly, server-side, for a thumbnail (ADR-064 decision 6)", async () => {
    const held = new Map<string, Buffer>();
    const endpoint = await serve((request, response, body) => {
      const url = new URL(request.url!, "http://s3");
      const key = decodeURIComponent(url.pathname.replace(/^\/cairn-attachments\/?/, ""));
      if (request.method === "PUT") {
        expect(request.headers["content-type"]).toBe("image/webp");
        held.set(key, body);
        response.writeHead(200).end();
        return;
      }
      // GET
      const found = held.get(key);
      if (!found) response.writeHead(404).end();
      else response.writeHead(200).end(found);
    });

    const config: AttachmentsConfig = { to: "s3://cairn-attachments/attachments", region: "eu-west-1", endpoint };
    const store = openAttachmentsStore(config)!;

    const key = "sha256/abc123-thumb";
    expect(await store.get(key)).toBeNull();

    const bytes = new Uint8Array([1, 2, 3, 4]);
    await store.put(key, bytes, "image/webp");

    const back = await store.get(key);
    expect(back).toEqual(bytes);
  });

  // `AttachmentsConfig` has no origin override for `abs://` (unlike
  // `S3ArchiveOptions.endpoint`), so an Azure stub cannot be pointed at from
  // here the way the S3 one above is. `AzureBlobArchive.sasUrl`'s "cw" and
  // "r" permission strings and its `rscd`/`rsct` content-disposition wiring
  // are exercised directly against a real stub in backup-remote.test.ts;
  // this only checks that `openAttachmentsStore` parses an `abs://` address
  // into a working store without touching the network.
  it("parses an abs:// address into a store, without needing a network call", () => {
    const store = openAttachmentsStore({ to: "abs://cairnstore@cairn-attachments/attachments", region: null, endpoint: null });
    expect(store).not.toBeNull();
    expect(typeof store!.head).toBe("function");
    expect(typeof store!.uploadUrl).toBe("function");
    expect(typeof store!.downloadUrl).toBe("function");
  });

  it("refuses a malformed abs:// address, naming the expected shape", () => {
    expect(() => openAttachmentsStore({ to: "abs://no-container-here", region: null, endpoint: null })).toThrow(AttachmentsConfigError);
  });

  it("refuses an s3:// address with no region configured", () => {
    expect(() => openAttachmentsStore({ to: "s3://cairn-attachments/attachments", region: null, endpoint: null })).toThrow(AttachmentsConfigError);
  });
});
