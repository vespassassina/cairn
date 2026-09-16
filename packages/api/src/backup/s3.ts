import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { backupTime, type Archive, type Backup } from "./archive.js";

/**
 * Backups in S3, or anything that speaks S3 (ADR-050).
 *
 * Hand-rolled for the same reason as the Azure archive: four operations do not
 * justify the AWS SDK, and signing a request is about eighty lines of Web
 * Crypto. It also keeps the promise that Cairn's server has no cloud SDK in it
 * at all, which is what lets the same image run everywhere (ADR-020).
 */

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
/**
 * Allowed over HTTPS, and what lets an upload stream from disk instead of
 * being read into memory to be hashed first. The transport protects the body;
 * the signature still covers the headers, the path and the credentials.
 */
const UNSIGNED = "UNSIGNED-PAYLOAD";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function hmac(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as never,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(message));
}

/**
 * Percent-encode for a canonical request. Stricter than encodeURIComponent,
 * which leaves ! ' ( ) * alone; S3 expects those encoded too, and a signature
 * that disagrees with the server about one character fails as completely as
 * one with the wrong key.
 */
function encodeRfc3986(text: string): string {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The path, encoded segment by segment so the separators survive. */
function canonicalPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeRfc3986(segment))
    .join("/");
}

export interface SignInput {
  method: string;
  /** Absolute URL, query included. */
  url: string;
  headers: Record<string, string>;
  credentials: Credentials;
  region: string;
  /** SHA-256 of the body in hex, or UNSIGNED-PAYLOAD. */
  payload: string;
  /** Overridable so the signature can be checked against a known vector. */
  now?: Date;
  service?: string;
}

/**
 * Sign a request the way Signature Version 4 requires, returning the headers
 * to send. Exported because it is the part that is worth testing against the
 * published test vectors rather than against a stub that would accept anything.
 */
export async function signV4(input: SignInput): Promise<Record<string, string>> {
  const url = new URL(input.url);
  const service = input.service ?? "s3";
  const at = input.now ?? new Date();
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = stamp.slice(0, 8);

  const headers: Record<string, string> = {
    ...input.headers,
    host: url.host,
    "x-amz-date": stamp,
    // S3's own header, naming the payload it expects to receive. Other
    // services neither send nor sign it, which is why this is conditional
    // rather than always on: signing a header the service does not expect
    // produces a signature it will not accept.
    ...(service === "s3" ? { "x-amz-content-sha256": input.payload } : {}),
  };
  if (input.credentials.sessionToken !== undefined) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }

  // Header names lowercased and sorted, values trimmed: the canonical form both
  // sides must agree on byte for byte.
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((name) => {
      const [, value] = Object.entries(headers).find(([key]) => key.toLowerCase() === name)!;
      return `${name}:${value.trim().replace(/\s+/g, " ")}\n`;
    })
    .join("");
  const signedHeaders = names.join(";");

  // Query parameters sorted by name, each encoded, as the canonical form wants.
  const query = [...url.searchParams.entries()]
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const canonicalRequest = [
    input.method,
    canonicalPath(url.pathname),
    query,
    canonicalHeaders,
    signedHeaders,
    input.payload,
  ].join("\n");

  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const toSign = [ALGORITHM, stamp, scope, await sha256(canonicalRequest)].join("\n");

  const kDate = await hmac(
    new TextEncoder().encode(`AWS4${input.credentials.secretAccessKey}`),
    day,
  );
  const kRegion = await hmac(kDate, input.region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, toSign));

  return {
    ...headers,
    Authorization:
      `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Credentials from the places AWS itself looks, in the same order: the
 * environment, then the role a task or an instance is running as. Never from a
 * file in the repository, and never from a setting (hard rule 18).
 */
export async function platformCredentials(): Promise<Credentials> {
  const id = process.env["AWS_ACCESS_KEY_ID"];
  const secret = process.env["AWS_SECRET_ACCESS_KEY"];
  if (id !== undefined && secret !== undefined) {
    const token = process.env["AWS_SESSION_TOKEN"];
    return { accessKeyId: id, secretAccessKey: secret, ...(token === undefined ? {} : { sessionToken: token }) };
  }

  // A container on ECS or App Runner is given an endpoint to ask.
  const relative = process.env["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"];
  const full = process.env["AWS_CONTAINER_CREDENTIALS_FULL_URI"];
  if (relative !== undefined || full !== undefined) {
    const url = full ?? `http://169.254.170.2${relative}`;
    const authorization = process.env["AWS_CONTAINER_AUTHORIZATION_TOKEN"];
    const response = await fetch(url, {
      headers: authorization === undefined ? {} : { Authorization: authorization },
    });
    if (response.ok) return asCredentials(await response.json());
  }

  // A plain EC2 instance has the instance metadata service. IMDSv2 wants a
  // token first, and an instance configured to require it refuses v1.
  const put = await fetch("http://169.254.169.254/latest/api/token", {
    method: "PUT",
    headers: { "x-aws-ec2-metadata-token-ttl-seconds": "300" },
  }).catch(() => null);
  const headers = put?.ok ? { "x-aws-ec2-metadata-token": await put.text() } : {};
  const roles = await fetch("http://169.254.169.254/latest/meta-data/iam/security-credentials/", {
    headers,
  }).catch(() => null);
  if (roles?.ok) {
    const role = (await roles.text()).split("\n")[0]!.trim();
    const response = await fetch(
      `http://169.254.169.254/latest/meta-data/iam/security-credentials/${role}`,
      { headers },
    );
    if (response.ok) return asCredentials(await response.json());
  }

  throw new Error(
    "no AWS credentials were found for the backup archive. Either give the machine a role " +
      "that may write to the bucket, or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the " +
      "environment. Cairn never reads credentials from a config file (ADR-017).",
  );
}

function asCredentials(body: unknown): Credentials {
  const held = body as { AccessKeyId?: string; SecretAccessKey?: string; Token?: string };
  if (typeof held.AccessKeyId !== "string" || typeof held.SecretAccessKey !== "string") {
    throw new Error("the credentials endpoint answered without an access key");
  }
  return {
    accessKeyId: held.AccessKeyId,
    secretAccessKey: held.SecretAccessKey,
    ...(typeof held.Token === "string" ? { sessionToken: held.Token } : {}),
  };
}

export interface S3ArchiveOptions {
  bucket: string;
  prefix: string;
  region: string;
  /** For MinIO, Backblaze, or any other store that speaks S3. Path style. */
  endpoint?: string;
  credentials?: () => Promise<Credentials>;
}

export class S3Archive implements Archive {
  readonly where: string;
  private readonly prefix: string;
  private readonly getCredentials: () => Promise<Credentials>;

  constructor(private readonly options: S3ArchiveOptions) {
    this.prefix = options.prefix === "" ? "" : `${options.prefix.replace(/\/+$/, "")}/`;
    this.getCredentials = options.credentials ?? platformCredentials;
    this.where = `s3://${options.bucket}/${this.prefix}`;
  }

  /**
   * Virtual-hosted style against real S3, path style against a named endpoint.
   * A custom endpoint is usually MinIO or similar, where the bucket is a path
   * and not a subdomain.
   */
  private url(name: string, query = ""): string {
    const key = name === "" ? "" : `${this.prefix}${name}`;
    if (this.options.endpoint !== undefined) {
      const base = this.options.endpoint.replace(/\/+$/, "");
      return `${base}/${this.options.bucket}${key === "" ? "" : `/${key}`}${query}`;
    }
    return `https://${this.options.bucket}.s3.${this.options.region}.amazonaws.com/${key}${query}`;
  }

  private async send(
    method: string,
    url: string,
    payload: string,
    body?: ReadableStream | string | Uint8Array,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const headers = await signV4({
      method,
      url,
      headers: extra,
      credentials: await this.getCredentials(),
      region: this.options.region,
      payload,
    });
    return fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      // Node needs telling that a streamed body is not expecting to read the
      // response at the same time.
      ...(body instanceof Readable || body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit);
  }

  private async fail(what: string, response: Response): Promise<never> {
    const detail = await response.text().catch(() => "");
    const next =
      response.status === 403
        ? ` The credentials reached S3 but may not do this. Allow s3:PutObject, s3:GetObject, s3:ListBucket and s3:DeleteObject on ${this.where} and on the bucket itself.`
        : response.status === 404
          ? ` The bucket ${this.options.bucket} may not exist in ${this.options.region}, or the region may be wrong.`
          : "";
    throw new Error(
      `could not ${what} in ${this.where}: HTTP ${response.status}.${next}` +
        (detail === "" ? "" : ` S3 said: ${detail.slice(0, 300)}`),
    );
  }

  async list(): Promise<Backup[]> {
    const found: Backup[] = [];
    let token = "";
    do {
      const query =
        `?list-type=2&prefix=${encodeRfc3986(this.prefix)}` +
        (token === "" ? "" : `&continuation-token=${encodeRfc3986(token)}`);
      const response = await this.send("GET", this.url("", query), EMPTY_SHA256);
      if (response.status === 404) return [];
      if (!response.ok) await this.fail("list the backups", response);
      const xml = await response.text();
      for (const [, key, size] of xml.matchAll(
        /<Contents>.*?<Key>([^<]*)<\/Key>.*?<Size>(\d+)<\/Size>.*?<\/Contents>/gs,
      )) {
        const short = key!.startsWith(this.prefix) ? key!.slice(this.prefix.length) : key!;
        const at = backupTime(short);
        if (at === null) continue;
        found.push({ name: short, at, bytes: Number(size) });
      }
      token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "";
    } while (token !== "");
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  async put(name: string, path: string): Promise<void> {
    const { size } = await stat(path);
    // A single PUT, streamed from disk. S3 takes an object up to 5 GiB this
    // way, which is far beyond any Cairn, and an unsigned payload is what lets
    // the bytes go straight from the file to the socket without being held in
    // memory to be hashed first.
    const response = await this.send(
      "PUT",
      this.url(name),
      UNSIGNED,
      Readable.toWeb(createReadStream(path)) as ReadableStream,
      { "content-length": String(size), "content-type": "application/vnd.sqlite3" },
    );
    if (!response.ok) await this.fail(`upload ${name}`, response);
  }

  async get(name: string, destination: string): Promise<void> {
    const response = await this.send("GET", this.url(name), EMPTY_SHA256);
    if (!response.ok) await this.fail(`download ${name}`, response);
    if (response.body === null) throw new Error(`${name} came back empty from ${this.where}`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
  }

  async remove(name: string): Promise<void> {
    const response = await this.send("DELETE", this.url(name), EMPTY_SHA256);
    if (response.status === 404) return;
    if (!response.ok) await this.fail(`delete ${name}`, response);
  }
}
