import { createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { backupTime, type Archive, type Backup } from "./archive.js";

/**
 * Backups in Azure Blob Storage (ADR-050).
 *
 * Written by hand against the REST API rather than with `@azure/storage-blob`,
 * for the reason ADR-018 gives: the app reaches storage through its managed
 * identity and no storage key exists anywhere in the deployment. The SDK would
 * bring that same identity flow plus about forty megabytes of dependencies for
 * four operations. What is here is a token from the platform's own identity
 * endpoint, then put, get, list and delete.
 *
 * Uploads go up in blocks. A single Put Blob would mean holding the whole
 * database in memory, which is fine for a personal wiki and not fine as a rule
 * the code quietly depends on.
 */

/** Azure rejects requests that do not name a version of the API. */
const API_VERSION = "2021-08-06";
const BLOCK_BYTES = 8 * 1024 * 1024;

interface Token {
  value: string;
  /** Milliseconds since the epoch. */
  expires: number;
}

/**
 * The key Azure hands back for "Get User Delegation Key", the only way to mint
 * a SAS when there is no storage account key (ADR-018: the deployment
 * authenticates as the managed identity only). Field names keep Azure's own
 * "Signed*" prefix because they go straight into the SAS string-to-sign
 * unchanged; renaming them would just be a translation step that could drift.
 */
interface UserDelegationKey {
  signedOid: string;
  signedTid: string;
  signedStart: string;
  signedExpiry: string;
  signedService: string;
  signedVersion: string;
  /** Base64, the HMAC key material for every SAS signed with it. */
  value: string;
  /** Milliseconds since the epoch, parsed from signedExpiry. */
  expires: number;
}

/** HMAC-SHA256, base64-encoded: the form a SAS signature is sent in. */
async function hmacSha256Base64(key: Uint8Array, message: string): Promise<string> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as never,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(message));
  return Buffer.from(signature).toString("base64");
}

export interface AzureArchiveOptions {
  account: string;
  container: string;
  /** Folder within the container. May be empty. */
  prefix: string;
  /** Overridable so tests can point at a local stub instead of Azure. */
  origin?: string;
  /** Overridable for the same reason. Returns a bearer token for storage. */
  fetchToken?: () => Promise<Token>;
}

/**
 * A bearer token for Azure Storage, from whichever identity endpoint this
 * platform provides.
 *
 * Container Apps and App Service inject IDENTITY_ENDPOINT and IDENTITY_HEADER;
 * a plain VM has the instance metadata service instead. Trying the injected one
 * first and falling back means the same image works in both without a setting
 * to get wrong.
 */
async function platformToken(): Promise<Token> {
  const resource = "https://storage.azure.com/";
  const injected = process.env["IDENTITY_ENDPOINT"];
  const header = process.env["IDENTITY_HEADER"];
  const [url, headers] =
    injected !== undefined && header !== undefined
      ? [
          `${injected}?resource=${encodeURIComponent(resource)}&api-version=2019-08-01`,
          { "X-IDENTITY-HEADER": header },
        ]
      : [
          `http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${encodeURIComponent(resource)}`,
          { Metadata: "true" },
        ];

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(
      `the managed identity would not give a token for storage (HTTP ${response.status}). ` +
        "Check that the container app has a system-assigned identity and that it holds the " +
        "Storage Blob Data Contributor role on the storage account: " +
        'az containerapp identity show -g <group> -n <app> and az role assignment list --assignee <principal-id>',
    );
  }
  const body = (await response.json()) as { access_token?: string; expires_on?: string | number };
  if (typeof body.access_token !== "string") {
    throw new Error("the identity endpoint answered without an access token");
  }
  // expires_on is seconds since the epoch, as a string on some platforms and a
  // number on others. An unreadable one is treated as a short life rather than
  // a failure: the worst case is asking for a token more often than needed.
  const seconds = Number(body.expires_on);
  const expires = Number.isFinite(seconds) ? seconds * 1000 : Date.now() + 5 * 60 * 1000;
  return { value: body.access_token, expires };
}

export class AzureBlobArchive implements Archive {
  readonly where: string;
  private readonly origin: string;
  private readonly prefix: string;
  private readonly getToken: () => Promise<Token>;
  private token: Token | null = null;
  private delegation: UserDelegationKey | null = null;

  constructor(private readonly options: AzureArchiveOptions) {
    this.origin = options.origin ?? `https://${options.account}.blob.core.windows.net`;
    // One trailing slash, or none at all, so joining a name is always the same.
    this.prefix = options.prefix === "" ? "" : `${options.prefix.replace(/\/+$/, "")}/`;
    this.getToken = options.fetchToken ?? platformToken;
    this.where = `abs://${options.account}@${options.container}/${this.prefix}`;
  }

  private async authorization(): Promise<string> {
    // A minute of margin, so a token cannot expire between this check and the
    // request that uses it.
    if (this.token === null || this.token.expires - 60_000 < Date.now()) {
      this.token = await this.getToken();
    }
    return `Bearer ${this.token.value}`;
  }

  private url(name: string, query = ""): string {
    const path = name === "" ? "" : `/${encodeURIComponent(`${this.prefix}${name}`)}`;
    return `${this.origin}/${this.options.container}${path}${query}`;
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return {
      Authorization: await this.authorization(),
      "x-ms-version": API_VERSION,
      ...extra,
    };
  }

  /** Every failure says which operation failed, and what Azure said about it. */
  private async fail(what: string, response: Response): Promise<never> {
    const detail = await response.text().catch(() => "");
    // Azure puts a machine-readable reason in a header; the body is XML.
    const code = response.headers.get("x-ms-error-code") ?? "";
    const next =
      response.status === 403
        ? " The identity can reach the account but is not allowed to do this. Give it the Storage Blob Data Contributor role on the storage account."
        : response.status === 404
          ? ` The container ${this.options.container} may not exist. Create it, or run deploy/azure/deploy.sh which creates it.`
          : "";
    throw new Error(
      `could not ${what} in ${this.where}: HTTP ${response.status}${code === "" ? "" : ` ${code}`}.${next}` +
        (detail === "" ? "" : ` Azure said: ${detail.slice(0, 300)}`),
    );
  }

  async list(): Promise<Backup[]> {
    const found: Backup[] = [];
    let marker = "";
    do {
      const query =
        `?restype=container&comp=list&prefix=${encodeURIComponent(this.prefix)}` +
        (marker === "" ? "" : `&marker=${encodeURIComponent(marker)}`);
      const response = await fetch(this.url("", query), { headers: await this.headers() });
      // A container that does not exist yet holds no backups. That is the state
      // before the first one, not a failure to report.
      if (response.status === 404) return [];
      if (!response.ok) await this.fail("list the backups", response);
      const xml = await response.text();
      for (const [, name, size] of xml.matchAll(
        /<Blob>.*?<Name>([^<]*)<\/Name>.*?<Content-Length>(\d+)<\/Content-Length>.*?<\/Blob>/gs,
      )) {
        const short = name!.startsWith(this.prefix) ? name!.slice(this.prefix.length) : name!;
        const at = backupTime(short);
        // Anything else in the container belongs to someone else. Never count
        // it towards retention, and never delete it.
        if (at === null) continue;
        found.push({ name: short, at, bytes: Number(size) });
      }
      marker = /<NextMarker>([^<]+)<\/NextMarker>/.exec(xml)?.[1] ?? "";
    } while (marker !== "");
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  async put(name: string, path: string): Promise<void> {
    const { size } = await stat(path);
    const handle = await open(path, "r");
    try {
      const ids: string[] = [];
      const buffer = Buffer.allocUnsafe(Math.min(BLOCK_BYTES, Math.max(size, 1)));
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (bytesRead === 0) break;
        // Every block id must be the same length before it is base64 encoded,
        // or Azure rejects the list.
        const id = Buffer.from(`cairn-${String(ids.length).padStart(6, "0")}`).toString("base64");
        const response = await fetch(this.url(name, `?comp=block&blockid=${encodeURIComponent(id)}`), {
          method: "PUT",
          headers: await this.headers({ "Content-Length": String(bytesRead) }),
          body: buffer.subarray(0, bytesRead),
        });
        if (!response.ok) await this.fail(`upload part of ${name}`, response);
        ids.push(id);
        offset += bytesRead;
      }

      // The blob does not exist for a reader until this call commits the list,
      // so a failed or half-finished upload never appears as a backup. That is
      // the same guarantee the folder archive gets from renaming into place.
      const list = `<?xml version="1.0" encoding="utf-8"?><BlockList>${ids
        .map((id) => `<Latest>${id}</Latest>`)
        .join("")}</BlockList>`;
      const committed = await fetch(this.url(name, "?comp=blocklist"), {
        method: "PUT",
        headers: await this.headers({
          "Content-Type": "application/xml",
          "x-ms-blob-content-type": "application/vnd.sqlite3",
        }),
        body: list,
      });
      if (!committed.ok) await this.fail(`finish uploading ${name}`, committed);
    } finally {
      await handle.close();
    }
  }

  async get(name: string, destination: string): Promise<void> {
    const response = await fetch(this.url(name), { headers: await this.headers() });
    if (!response.ok) await this.fail(`download ${name}`, response);
    if (response.body === null) throw new Error(`${name} came back empty from ${this.where}`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
  }

  async remove(name: string): Promise<void> {
    const response = await fetch(this.url(name), {
      method: "DELETE",
      headers: await this.headers(),
    });
    // Already gone is the outcome we wanted.
    if (response.status === 404) return;
    if (!response.ok) await this.fail(`delete ${name}`, response);
  }

  /**
   * Writes `bytes` straight to `name` with a single Put Blob, no file on
   * disk either side. Used by `attachments-blob.ts` for a thumbnail
   * (ADR-064 decision 6): small enough that the block-list dance `put()`
   * above does for a whole database is unneeded, and this sets the
   * `Content-Type` the caller asks for, which `put()` hardcodes.
   */
  async putBytes(name: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const response = await fetch(this.url(name), {
      method: "PUT",
      headers: await this.headers({
        "Content-Length": String(bytes.length),
        "Content-Type": contentType,
        "x-ms-blob-type": "BlockBlob",
      }),
      body: bytes as never,
    });
    if (!response.ok) await this.fail(`upload ${name}`, response);
  }

  /** The bytes at `name`, read straight into memory. The read half of `putBytes`. */
  async getBytes(name: string): Promise<Uint8Array> {
    const response = await fetch(this.url(name), { headers: await this.headers() });
    if (!response.ok) await this.fail(`download ${name}`, response);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** The size of one blob without downloading it, or null if it does not exist. */
  async head(name: string): Promise<{ bytes: number } | null> {
    const response = await fetch(this.url(name), { method: "HEAD", headers: await this.headers() });
    if (response.status === 404) return null;
    if (!response.ok) await this.fail(`check ${name}`, response);
    const length = response.headers.get("content-length");
    return { bytes: length === null ? 0 : Number(length) };
  }

  /**
   * The key behind every SAS this archive mints: fetched from Azure's "Get
   * User Delegation Key" (account-level, not container-level, despite this
   * being a per-container class), cached the same way `authorization()`
   * caches the bearer token, and refetched once past its expiry minus a
   * safety margin. Asked for Azure's own maximum lifetime, seven days, so it
   * is reused across many SAS mints instead of fetched on every one.
   */
  private async delegationKey(): Promise<UserDelegationKey> {
    if (this.delegation === null || this.delegation.expires - 5 * 60_000 < Date.now()) {
      const start = new Date();
      const expiry = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
      const body =
        '<?xml version="1.0" encoding="utf-8"?><KeyInfo>' +
        `<Start>${start.toISOString()}</Start><Expiry>${expiry.toISOString()}</Expiry>` +
        "</KeyInfo>";
      // Account-level: the container or blob path plays no part in the URL.
      const response = await fetch(`${this.origin}/?restype=service&comp=userdelegationkey`, {
        method: "POST",
        headers: await this.headers({ "Content-Type": "application/xml" }),
        body,
      });
      if (!response.ok) await this.fail("get a user delegation key", response);
      const xml = await response.text();
      const field = (tag: string): string => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1] ?? "";
      const value = field("Value");
      if (value === "") {
        throw new Error(
          `could not get a user delegation key from ${this.where}: Azure answered without a ` +
            "usable <Value>. Check that the identity holds a role that may request one, such as " +
            "Storage Blob Data Contributor, at the account level.",
        );
      }
      this.delegation = {
        signedOid: field("SignedOid"),
        signedTid: field("SignedTid"),
        signedStart: field("SignedStart"),
        signedExpiry: field("SignedExpiry"),
        signedService: field("SignedService"),
        signedVersion: field("SignedVersion"),
        value,
        expires: Date.parse(field("SignedExpiry")),
      };
    }
    return this.delegation;
  }

  /**
   * A URL a caller may PUT (upload) or GET (download) directly against this
   * blob, with no bearer token of its own, valid for `expiresInSeconds`.
   *
   * This follows Microsoft's "Construct a user delegation SAS" string-to-sign
   * for blob service version 2020-02-10 and later (which covers API_VERSION,
   * 2021-08-06): newline-joined signedPermissions, signedStart, signedExpiry,
   * canonicalizedResource, then the eight signedKey* fields from the
   * delegation key, four empty fields (authorized/unauthorized user object id,
   * correlation id, IP), signedProtocol, signedVersion, signedResource,
   * signedSnapshotTime, signedEncryptionScope, and the four empty rs* fields
   * except rscd/rsct when the caller asks for them, signed with the
   * delegation key's base64-decoded value as an HMAC-SHA256 key.
   *
   * Unlike `signV4` in s3.ts, this construction has never been checked
   * against a real Azure storage account or an official test vector.
   * Microsoft does not publish one for a user-delegation SAS the way AWS
   * publishes SigV4 vectors. It is checked here only structurally and against
   * this file's own independent re-derivation in the test stub. Verify
   * against a real deployment before trusting it in production; if it turns
   * out wrong, the fix belongs here and in `delegationKey()` above. See
   * `docs/LESSONS.md`, 2026-09-23.
   */
  async sasUrl(
    name: string,
    opts: { permissions: "r" | "cw"; expiresInSeconds: number; contentDisposition?: string; contentType?: string },
  ): Promise<string> {
    const key = await this.delegationKey();
    // A few minutes in the past, the same clock-skew margin Microsoft's own
    // examples use, so a client whose clock runs slightly behind is not
    // refused for a URL that is not "valid yet" from its own point of view.
    const start = new Date(Date.now() - 5 * 60_000);
    const expiry = new Date(Date.now() + opts.expiresInSeconds * 1000);
    const startStr = start.toISOString();
    const expiryStr = expiry.toISOString();
    const resource = `/blob/${this.options.account}/${this.options.container}/${this.prefix}${name}`;

    const stringToSign = [
      opts.permissions,
      startStr,
      expiryStr,
      resource,
      key.signedOid,
      key.signedTid,
      key.signedStart,
      key.signedExpiry,
      key.signedService,
      key.signedVersion,
      "", // signedAuthorizedUserObjectId: only for a SAS delegating a SAS, not used here
      "", // signedUnauthorizedUserObjectId
      "", // signedCorrelationId
      "", // signedIP: no IP restriction
      "https",
      API_VERSION,
      "b", // signedResource: a single blob
      "", // signedSnapshotTime
      "", // signedEncryptionScope
      "", // rscc: cache-control
      opts.contentDisposition ?? "", // rscd: content-disposition
      "", // rsce: content-encoding
      "", // rscl: content-language
      opts.contentType ?? "", // rsct: content-type
    ].join("\n");

    const signature = await hmacSha256Base64(Buffer.from(key.value, "base64"), stringToSign);

    const url = new URL(this.url(name));
    url.searchParams.set("sv", API_VERSION);
    url.searchParams.set("st", startStr);
    url.searchParams.set("se", expiryStr);
    url.searchParams.set("sr", "b");
    url.searchParams.set("sp", opts.permissions);
    url.searchParams.set("skoid", key.signedOid);
    url.searchParams.set("sktid", key.signedTid);
    url.searchParams.set("skt", key.signedStart);
    url.searchParams.set("ske", key.signedExpiry);
    url.searchParams.set("sks", key.signedService);
    url.searchParams.set("skv", key.signedVersion);
    if (opts.contentDisposition !== undefined) url.searchParams.set("rscd", opts.contentDisposition);
    if (opts.contentType !== undefined) url.searchParams.set("rsct", opts.contentType);
    url.searchParams.set("sig", signature);
    return url.toString();
  }
}
