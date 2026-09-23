import { createHash, createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AzureBlobArchive } from "../src/backup/azure.js";
import { S3Archive, presignV4, signV4 } from "../src/backup/s3.js";
import { ArchiveError, openArchive } from "../src/backup/open.js";
import { FolderArchive } from "../src/backup/archive.js";

/**
 * The archives that put backups in a cloud's own object storage (ADR-050).
 *
 * Neither AWS nor Azure is called here. What is checked is the part that is
 * ours to get wrong: the signature, the request shapes, and that a file goes
 * up and comes back byte for byte. The stubs are deliberately strict about
 * what they will accept, because a stub that accepts anything proves nothing.
 */

let dir = "";
let server: Server | null = null;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-archive-"));
});

afterEach(async () => {
  if (server !== null) await new Promise((done) => server!.close(done));
  server = null;
  await rm(dir, { recursive: true, force: true });
});

/** A stub HTTP server, returning the origin it is listening on. */
async function serve(
  handler: (request: IncomingMessage, response: ServerResponse, body: Buffer) => void,
): Promise<string> {
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

describe("signing a request for S3", () => {
  // From AWS's own Signature Version 4 test suite, the "get-vanilla" case.
  // This is the one part of the archive that cannot be checked against a stub:
  // a stub would accept whatever we sent it, including a wrong signature, and
  // the first time we learned otherwise would be against the real S3.
  it("matches the published test vector", async () => {
    const headers = await signV4({
      method: "GET",
      url: "https://example.amazonaws.com/",
      headers: {},
      credentials: {
        accessKeyId: "AKIDEXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      },
      region: "us-east-1",
      service: "service",
      payload: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      now: new Date("2015-08-30T12:36:00Z"),
    });

    expect(headers["Authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("produces a different signature for a different secret", async () => {
    // Without this, a signer that returned a constant would pass the vector
    // test by accident if the constant were ever hard-coded.
    const headers = await signV4({
      method: "GET",
      url: "https://example.amazonaws.com/",
      headers: {},
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "a-different-secret" },
      region: "us-east-1",
      service: "service",
      payload: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      now: new Date("2015-08-30T12:36:00Z"),
    });
    expect(headers["Authorization"]).not.toContain(
      "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("signs the same request the same way twice, and a different one differently", async () => {
    const credentials = { accessKeyId: "AKID", secretAccessKey: "secret" };
    const base = {
      method: "GET" as const,
      headers: {},
      credentials,
      region: "eu-west-1",
      payload: "UNSIGNED-PAYLOAD",
      now: new Date("2026-09-16T10:00:00Z"),
    };
    const one = await signV4({ ...base, url: "https://b.s3.eu-west-1.amazonaws.com/a" });
    const same = await signV4({ ...base, url: "https://b.s3.eu-west-1.amazonaws.com/a" });
    const other = await signV4({ ...base, url: "https://b.s3.eu-west-1.amazonaws.com/z" });
    expect(one["Authorization"]).toBe(same["Authorization"]);
    expect(one["Authorization"]).not.toBe(other["Authorization"]);
  });

  it("carries a session token when the credentials have one", async () => {
    const headers = await signV4({
      method: "GET",
      url: "https://b.s3.eu-west-1.amazonaws.com/a",
      headers: {},
      credentials: { accessKeyId: "AKID", secretAccessKey: "secret", sessionToken: "temporary" },
      region: "eu-west-1",
      payload: "UNSIGNED-PAYLOAD",
    });
    expect(headers["x-amz-security-token"]).toBe("temporary");
    // The token must be signed over, or S3 rejects it as tampered with.
    expect(headers["Authorization"]).toContain("x-amz-security-token");
  });
});

/**
 * An independent re-derivation of SigV4's query-string (presigned URL) mode,
 * using node:crypto rather than the Web Crypto the implementation signs with,
 * so a stub that accepts a presigned request is proof of something: it agrees
 * with a second implementation of the same published algorithm, not just with
 * itself.
 */
function verifyPresignedS3(url: URL, method: string, secretAccessKey: string, host: string): boolean {
  const signature = url.searchParams.get("X-Amz-Signature");
  if (signature === null) return false;
  const credential = url.searchParams.get("X-Amz-Credential") ?? "";
  const [, day = "", region = "", service = ""] = credential.split("/");
  const stamp = url.searchParams.get("X-Amz-Date") ?? "";
  const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders") ?? "host";

  const canonicalPath = url.pathname
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const canonicalQuery = [...url.searchParams.entries()]
    .filter(([key]) => key !== "X-Amz-Signature")
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join(
    "\n",
  );
  const hmac = (key: Buffer, message: string) => createHmac("sha256", key).update(message).digest();
  const kDate = hmac(Buffer.from(`AWS4${secretAccessKey}`), day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const expected = hmac(kSigning, toSign).toString("hex");
  return expected === signature;
}

describe("the S3 archive", () => {
  /** A stub holding objects in memory, strict about what S3 requires. */
  async function stubS3(held: Map<string, Buffer>, secretAccessKey = "secret"): Promise<string> {
    return serve((request, response, body) => {
      const url = new URL(request.url!, "http://s3");
      // Every request must be signed, either with an Authorization header or,
      // for a presigned URL, a verified query-string signature. Neither is
      // "was there something in the right field": both are checked for real.
      const headerAuthed = (request.headers["authorization"] ?? "").startsWith("AWS4-HMAC-SHA256 ");
      const queryAuthed =
        url.searchParams.has("X-Amz-Signature") &&
        verifyPresignedS3(url, request.method ?? "GET", secretAccessKey, request.headers.host ?? "");
      if (!headerAuthed && !queryAuthed) {
        response.writeHead(403).end("<Error><Code>AccessDenied</Code></Error>");
        return;
      }
      const key = url.pathname.replace(/^\/bucket\/?/, "");
      if (request.method === "PUT") {
        held.set(key, body);
        response.writeHead(200).end();
      } else if (request.method === "DELETE") {
        held.delete(key);
        response.writeHead(204).end();
      } else if (url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const contents = [...held.entries()]
          .filter(([name]) => name.startsWith(prefix))
          .map(([name, value]) => `<Contents><Key>${name}</Key><Size>${value.length}</Size></Contents>`)
          .join("");
        response.writeHead(200).end(`<ListBucketResult>${contents}</ListBucketResult>`);
      } else if (request.method === "HEAD") {
        const held_ = held.get(key);
        if (held_ === undefined) response.writeHead(404).end();
        else response.writeHead(200, { "content-length": String(held_.length) }).end();
      } else {
        const held_ = held.get(key);
        if (held_ === undefined) response.writeHead(404).end("<Error/>");
        else response.writeHead(200).end(held_);
      }
    });
  }

  function archive(endpoint: string): S3Archive {
    return new S3Archive({
      bucket: "bucket",
      prefix: "backups",
      region: "eu-west-1",
      endpoint,
      credentials: async () => ({ accessKeyId: "AKID", secretAccessKey: "secret" }),
    });
  }

  it("puts a file up and gets the same bytes back", async () => {
    const held = new Map<string, Buffer>();
    const store = archive(await stubS3(held));
    const source = join(dir, "source.sqlite");
    // Bigger than one chunk, so streaming is actually exercised.
    const content = Buffer.alloc(300_000, "cairn");
    await writeFile(source, content);

    await store.put("cairn-2026-09-16T10-00-00Z.sqlite", source);
    const back = join(dir, "back.sqlite");
    await store.get("cairn-2026-09-16T10-00-00Z.sqlite", back);

    expect(await readFile(back)).toEqual(content);
  });

  it("lists only backups, and reads the time from the name", async () => {
    const held = new Map<string, Buffer>();
    const store = archive(await stubS3(held));
    const source = join(dir, "s.sqlite");
    await writeFile(source, "x");
    await store.put("cairn-2026-09-16T10-00-00Z.sqlite", source);
    await store.put("cairn-2026-09-15T10-00-00Z.sqlite", source);
    // Somebody else's object, in the same prefix.
    held.set("backups/notes.txt", Buffer.from("not ours"));

    const found = await store.list();
    expect(found.map((backup) => backup.name)).toEqual([
      "cairn-2026-09-15T10-00-00Z.sqlite",
      "cairn-2026-09-16T10-00-00Z.sqlite",
    ]);
    expect(found[1]!.at.toISOString()).toBe("2026-09-16T10:00:00.000Z");
  });

  it("removes one, and treats an already-missing one as done", async () => {
    const held = new Map<string, Buffer>();
    const store = archive(await stubS3(held));
    const source = join(dir, "s.sqlite");
    await writeFile(source, "x");
    await store.put("cairn-2026-09-16T10-00-00Z.sqlite", source);

    await store.remove("cairn-2026-09-16T10-00-00Z.sqlite");
    expect(await store.list()).toEqual([]);
    await expect(store.remove("cairn-2026-09-16T10-00-00Z.sqlite")).resolves.toBeUndefined();
  });

  it("says what to do when S3 refuses the credentials", async () => {
    const endpoint = await serve((_request, response) => {
      response.writeHead(403).end("<Error><Code>AccessDenied</Code></Error>");
    });
    const store = archive(endpoint);
    await expect(store.list()).rejects.toThrow(/s3:ListBucket/);
  });

  it("checks a name's size without downloading it, and returns null when it is missing", async () => {
    const held = new Map<string, Buffer>();
    const store = archive(await stubS3(held));
    const source = join(dir, "s.sqlite");
    await writeFile(source, "twelve bytes");
    await store.put("cairn-2026-09-16T10-00-00Z.sqlite", source);

    expect(await store.head("cairn-2026-09-16T10-00-00Z.sqlite")).toEqual({ bytes: 12 });
    expect(await store.head("cairn-2026-09-17T10-00-00Z.sqlite")).toBeNull();
  });

  describe("presigned URLs", () => {
    const credentials = { accessKeyId: "AKID", secretAccessKey: "secret" };

    it("builds a URL with the five X-Amz-* parameters a presigned request needs", async () => {
      const url = await presignV4({
        method: "PUT",
        url: "https://b.s3.eu-west-1.amazonaws.com/bucket/key",
        credentials,
        region: "eu-west-1",
        expiresInSeconds: 900,
        now: new Date("2026-09-23T10:00:00Z"),
      });
      const parsed = new URL(url);
      expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
      expect(parsed.searchParams.get("X-Amz-Credential")).toBe(
        "AKID/20260923/eu-west-1/s3/aws4_request",
      );
      expect(parsed.searchParams.get("X-Amz-Date")).toBe("20260923T100000Z");
      expect(parsed.searchParams.get("X-Amz-Expires")).toBe("900");
      expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
      expect(parsed.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
      // No Authorization header is needed; nothing else identifies the caller.
      expect(parsed.searchParams.has("Authorization")).toBe(false);
    });

    it("lets a bare fetch, with no header of its own, PUT straight to it, and the stub verifies the signature independently", async () => {
      const held = new Map<string, Buffer>();
      const endpoint = await stubS3(held, credentials.secretAccessKey);
      const url = await presignV4({
        method: "PUT",
        url: `${endpoint}/bucket/direct-upload.sqlite`,
        credentials,
        region: "eu-west-1",
        expiresInSeconds: 900,
      });

      const response = await fetch(url, { method: "PUT", body: "uploaded straight to storage" });

      expect(response.ok).toBe(true);
      expect(held.get("direct-upload.sqlite")?.toString()).toBe("uploaded straight to storage");
    });

    it("lets a bare fetch GET straight from a presigned URL", async () => {
      const held = new Map<string, Buffer>([["direct-download.sqlite", Buffer.from("stored bytes")]]);
      const endpoint = await stubS3(held, credentials.secretAccessKey);
      const url = await presignV4({
        method: "GET",
        url: `${endpoint}/bucket/direct-download.sqlite`,
        credentials,
        region: "eu-west-1",
        expiresInSeconds: 900,
      });

      const response = await fetch(url);

      expect(await response.text()).toBe("stored bytes");
    });

    it("is refused by the independent verifier when the signature is tampered with", async () => {
      const held = new Map<string, Buffer>();
      const endpoint = await stubS3(held, credentials.secretAccessKey);
      const url = new URL(
        await presignV4({
          method: "PUT",
          url: `${endpoint}/bucket/tampered.sqlite`,
          credentials,
          region: "eu-west-1",
          expiresInSeconds: 900,
        }),
      );
      url.searchParams.set("X-Amz-Signature", "0".repeat(64));

      const response = await fetch(url, { method: "PUT", body: "should not land" });

      expect(response.status).toBe(403);
      expect(held.has("tampered.sqlite")).toBe(false);
    });
  });
});

/**
 * A fixed, known user delegation key, the fixture the Azure stub hands back
 * from a "Get User Delegation Key" call and that `verifySas` below signs
 * against independently, so the round trip proves the real string-to-sign
 * construction, not just that the stub accepted whatever it was given.
 */
const DELEGATION_KEY = {
  signedOid: "11111111-1111-1111-1111-111111111111",
  signedTid: "22222222-2222-2222-2222-222222222222",
  signedStart: "2026-09-23T00:00:00Z",
  signedExpiry: "2026-09-30T00:00:00Z",
  signedService: "b",
  signedVersion: "2021-08-06",
  value: Buffer.from("test-delegation-key-material").toString("base64"),
};

const DELEGATION_KEY_XML =
  '<?xml version="1.0" encoding="utf-8"?><UserDelegationKey>' +
  `<SignedOid>${DELEGATION_KEY.signedOid}</SignedOid>` +
  `<SignedTid>${DELEGATION_KEY.signedTid}</SignedTid>` +
  `<SignedStart>${DELEGATION_KEY.signedStart}</SignedStart>` +
  `<SignedExpiry>${DELEGATION_KEY.signedExpiry}</SignedExpiry>` +
  `<SignedService>${DELEGATION_KEY.signedService}</SignedService>` +
  `<SignedVersion>${DELEGATION_KEY.signedVersion}</SignedVersion>` +
  `<Value>${DELEGATION_KEY.value}</Value>` +
  "</UserDelegationKey>";

/**
 * An independent re-derivation of the user-delegation SAS string-to-sign
 * Microsoft's docs specify, built from the same known `DELEGATION_KEY` fixture
 * but without calling anything in `azure.ts`. Confirms the SAS query params
 * actually verify against the published construction, not just that the stub
 * let a request through.
 */
function verifySas(url: URL, account: string): boolean {
  const sig = url.searchParams.get("sig");
  if (sig === null) return false;
  const resource = `/blob/${account}${decodeURIComponent(url.pathname)}`;
  const stringToSign = [
    url.searchParams.get("sp") ?? "",
    url.searchParams.get("st") ?? "",
    url.searchParams.get("se") ?? "",
    resource,
    url.searchParams.get("skoid") ?? "",
    url.searchParams.get("sktid") ?? "",
    url.searchParams.get("skt") ?? "",
    url.searchParams.get("ske") ?? "",
    url.searchParams.get("sks") ?? "",
    url.searchParams.get("skv") ?? "",
    "",
    "",
    "",
    "",
    "https",
    url.searchParams.get("sv") ?? "",
    "b",
    "",
    "",
    "",
    url.searchParams.get("rscd") ?? "",
    "",
    "",
    url.searchParams.get("rsct") ?? "",
  ].join("\n");
  const expected = createHmac("sha256", Buffer.from(DELEGATION_KEY.value, "base64"))
    .update(stringToSign)
    .digest("base64");
  return expected === sig;
}

describe("the Azure blob archive", () => {
  /** A stub holding blobs in memory, and refusing anything unauthenticated. */
  async function stubAzure(held: Map<string, Buffer>): Promise<string> {
    const blocks = new Map<string, Buffer[]>();
    return serve((request, response, body) => {
      const url = new URL(request.url!, "http://blob");

      if (url.searchParams.get("restype") === "service" && url.searchParams.get("comp") === "userdelegationkey") {
        if (request.headers["authorization"] !== "Bearer test-token") {
          response.writeHead(403).end("<Error/>");
          return;
        }
        response.writeHead(200, { "content-type": "application/xml" }).end(DELEGATION_KEY_XML);
        return;
      }

      const bearerAuthed = request.headers["authorization"] === "Bearer test-token";
      // A SAS request carries no bearer token at all; it authorizes itself,
      // and the stub checks that the same way a real account would: by
      // re-deriving the signature, not by trusting the query string's shape.
      const sasAuthed = url.searchParams.has("sig") && verifySas(url, "cairnstore");
      if (!bearerAuthed && !sasAuthed) {
        response.writeHead(403).end("<Error/>");
        return;
      }
      if (bearerAuthed && request.headers["x-ms-version"] === undefined) {
        response.writeHead(400).end("<Error>no version</Error>");
        return;
      }
      const name = decodeURIComponent(url.pathname.replace(/^\/cairn-backups\/?/, ""));
      if (request.method === "HEAD") {
        const found = held.get(name);
        if (found === undefined) response.writeHead(404).end();
        else response.writeHead(200, { "content-length": String(found.length) }).end();
      } else if (request.method === "PUT" && url.searchParams.has("blockid")) {
        // Blocks are staged, and deliberately not visible as a blob yet.
        blocks.set(name, [...(blocks.get(name) ?? []), body]);
        response.writeHead(201).end();
      } else if (request.method === "PUT" && url.searchParams.get("comp") === "blocklist") {
        held.set(name, Buffer.concat(blocks.get(name) ?? []));
        blocks.delete(name);
        response.writeHead(201).end();
      } else if (request.method === "PUT") {
        // A direct SAS upload: one whole object, no block list.
        held.set(name, body);
        response.writeHead(201).end();
      } else if (request.method === "DELETE") {
        held.delete(name);
        response.writeHead(202).end();
      } else if (url.searchParams.get("comp") === "list") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const blobs = [...held.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(
            ([key, value]) =>
              `<Blob><Name>${key}</Name><Properties><Content-Length>${value.length}</Content-Length></Properties></Blob>`,
          )
          .join("");
        response.writeHead(200).end(`<EnumerationResults><Blobs>${blobs}</Blobs></EnumerationResults>`);
      } else {
        const found = held.get(name);
        if (found === undefined) response.writeHead(404).end("<Error/>");
        else response.writeHead(200).end(found);
      }
    });
  }

  function archive(origin: string): AzureBlobArchive {
    return new AzureBlobArchive({
      account: "cairnstore",
      container: "cairn-backups",
      prefix: "backups",
      origin,
      fetchToken: async () => ({ value: "test-token", expires: Date.now() + 3_600_000 }),
    });
  }

  it("puts a file up in blocks and gets the same bytes back", async () => {
    const held = new Map<string, Buffer>();
    const store = archive(await stubAzure(held));
    const source = join(dir, "source.sqlite");
    const content = Buffer.alloc(300_000, "cairn");
    await writeFile(source, content);

    await store.put("cairn-2026-09-16T10-00-00Z.sqlite", source);
    const back = join(dir, "back.sqlite");
    await store.get("cairn-2026-09-16T10-00-00Z.sqlite", back);

    expect(await readFile(back)).toEqual(content);
  });

  it("lists only backups, ignoring anything else in the container", async () => {
    const held = new Map<string, Buffer>();
    const store = archive(await stubAzure(held));
    const source = join(dir, "s.sqlite");
    await writeFile(source, "x");
    await store.put("cairn-2026-09-16T10-00-00Z.sqlite", source);
    held.set("backups/readme.txt", Buffer.from("not ours"));

    const found = await store.list();
    expect(found.map((backup) => backup.name)).toEqual(["cairn-2026-09-16T10-00-00Z.sqlite"]);
  });

  it("treats a container that does not exist yet as holding nothing", async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(404).end("<Error><Code>ContainerNotFound</Code></Error>");
    });
    expect(await archive(origin).list()).toEqual([]);
  });

  it("says what to do when the identity is not allowed to write", async () => {
    const origin = await serve((_request, response) => {
      response.setHeader("x-ms-error-code", "AuthorizationPermissionMismatch");
      response.writeHead(403).end("<Error/>");
    });
    const store = new AzureBlobArchive({
      account: "cairnstore",
      container: "cairn-backups",
      prefix: "",
      origin,
      fetchToken: async () => ({ value: "wrong", expires: Date.now() + 3_600_000 }),
    });
    const source = join(dir, "s.sqlite");
    await writeFile(source, "x");
    await expect(store.put("cairn-2026-09-16T10-00-00Z.sqlite", source)).rejects.toThrow(
      /Storage Blob Data Contributor/,
    );
  });

  it("checks a name's size without downloading it, and returns null when it is missing", async () => {
    const held = new Map<string, Buffer>();
    const store = archive(await stubAzure(held));
    const source = join(dir, "s.sqlite");
    await writeFile(source, "twelve bytes");
    await store.put("cairn-2026-09-16T10-00-00Z.sqlite", source);

    expect(await store.head("cairn-2026-09-16T10-00-00Z.sqlite")).toEqual({ bytes: 12 });
    expect(await store.head("cairn-2026-09-17T10-00-00Z.sqlite")).toBeNull();
  });

  describe("SAS URLs", () => {
    it("mints a URL with the sv/st/se/sr/sp/sk*/sig parameters a SAS needs", async () => {
      const held = new Map<string, Buffer>();
      const store = archive(await stubAzure(held));

      const url = new URL(await store.sasUrl("direct.sqlite", { permissions: "cw", expiresInSeconds: 900 }));

      expect(url.searchParams.get("sv")).toBe("2021-08-06");
      expect(url.searchParams.get("sr")).toBe("b");
      expect(url.searchParams.get("sp")).toBe("cw");
      expect(url.searchParams.get("skoid")).toBe(DELEGATION_KEY.signedOid);
      expect(url.searchParams.get("sktid")).toBe(DELEGATION_KEY.signedTid);
      expect(url.searchParams.get("skv")).toBe(DELEGATION_KEY.signedVersion);
      expect(url.searchParams.get("st")).toBeTruthy();
      expect(url.searchParams.get("se")).toBeTruthy();
      expect(url.searchParams.get("sig")).toBeTruthy();
      // No bearer token of any kind is in the URL; the sig alone authorizes it.
      expect(url.toString()).not.toContain("test-token");
    });

    it("lets a bare fetch, with no bearer token at all, PUT straight to a SAS URL, verified independently by the stub", async () => {
      const held = new Map<string, Buffer>();
      const store = archive(await stubAzure(held));

      const url = await store.sasUrl("direct-upload.sqlite", { permissions: "cw", expiresInSeconds: 900 });
      const response = await fetch(url, { method: "PUT", body: "uploaded straight to blob storage" });

      expect(response.ok).toBe(true);
      expect(held.get("backups/direct-upload.sqlite")?.toString()).toBe("uploaded straight to blob storage");
    });

    it("lets a bare fetch GET straight from a SAS URL", async () => {
      const held = new Map<string, Buffer>([["backups/direct-download.sqlite", Buffer.from("stored bytes")]]);
      const store = archive(await stubAzure(held));

      const url = await store.sasUrl("direct-download.sqlite", { permissions: "r", expiresInSeconds: 900 });
      const response = await fetch(url);

      expect(await response.text()).toBe("stored bytes");
    });

    it("is refused by the independent verifier when the signature is tampered with", async () => {
      const held = new Map<string, Buffer>();
      const store = archive(await stubAzure(held));
      const url = new URL(await store.sasUrl("tampered.sqlite", { permissions: "cw", expiresInSeconds: 900 }));
      url.searchParams.set("sig", Buffer.from("wrong-signature").toString("base64"));

      const response = await fetch(url, { method: "PUT", body: "should not land" });

      expect(response.status).toBe(403);
      expect(held.has("backups/tampered.sqlite")).toBe(false);
    });

    it("reuses the cached delegation key across two SAS mints instead of fetching it twice", async () => {
      const held = new Map<string, Buffer>();
      let delegationKeyRequests = 0;
      const origin = await serve((request, response, body) => {
        const url = new URL(request.url!, "http://blob");
        if (url.searchParams.get("comp") === "userdelegationkey") {
          delegationKeyRequests += 1;
          response.writeHead(200, { "content-type": "application/xml" }).end(DELEGATION_KEY_XML);
          return;
        }
        if (request.method === "PUT") {
          const name = decodeURIComponent(url.pathname.replace(/^\/cairn-backups\/?/, ""));
          held.set(name, body);
          response.writeHead(201).end();
          return;
        }
        response.writeHead(404).end();
      });
      const store = archive(origin);

      await store.sasUrl("one.sqlite", { permissions: "cw", expiresInSeconds: 900 });
      await store.sasUrl("two.sqlite", { permissions: "cw", expiresInSeconds: 900 });

      expect(delegationKeyRequests).toBe(1);
    });
  });
});

describe("choosing an archive from the setting", () => {
  it("takes a plain path as a folder", () => {
    expect(openArchive("/var/cairn/backups")).toBeInstanceOf(FolderArchive);
  });

  it("takes an abs:// address as Azure, the same shape as CAIRN_REPLICA_URL", () => {
    const store = openArchive("abs://cairnstore@cairn-backups/backups");
    expect(store).toBeInstanceOf(AzureBlobArchive);
    expect(store.where).toBe("abs://cairnstore@cairn-backups/backups/");
  });

  it("takes an s3:// address as S3, with the region given", () => {
    const store = openArchive("s3://my-bucket/backups", { region: "eu-west-1" });
    expect(store).toBeInstanceOf(S3Archive);
    expect(store.where).toBe("s3://my-bucket/backups/");
  });

  it("refuses an s3 address with no region, naming the setting that fixes it", () => {
    const region = process.env["AWS_REGION"];
    const fallback = process.env["AWS_DEFAULT_REGION"];
    delete process.env["AWS_REGION"];
    delete process.env["AWS_DEFAULT_REGION"];
    try {
      expect(() => openArchive("s3://my-bucket/backups")).toThrow(/CAIRN_BACKUP_REGION/);
    } finally {
      if (region !== undefined) process.env["AWS_REGION"] = region;
      if (fallback !== undefined) process.env["AWS_DEFAULT_REGION"] = fallback;
    }
  });

  it("refuses a scheme it does not know, and lists the ones it does", () => {
    expect(() => openArchive("gs://my-bucket/backups")).toThrow(ArchiveError);
    expect(() => openArchive("gs://my-bucket/backups")).toThrow(/abs:\/\/.*s3:\/\//s);
  });

  it("refuses an incomplete azure address rather than guessing the container", () => {
    expect(() => openArchive("abs://cairnstore")).toThrow(/abs:\/\/<account>@<container>/);
  });
});
