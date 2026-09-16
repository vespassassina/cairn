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
}
