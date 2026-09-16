import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Configuration, read once at startup from the environment and an optional
 * `cairn.config.json`.
 *
 * Two modes, decided at startup rather than documented and hoped for:
 *
 * 1. Local: bound to loopback. Requests addressed to a trusted local host name
 *    need no token (ADR-010).
 * 2. Public: bound to any other address, such as 0.0.0.0 in a container. Only
 *    allowed with OAuth configured (ADR-017). Local trust is forced off,
 *    because on a public server the Host header is whatever a caller sends.
 *
 * Secrets come only from the environment, never from the committed file.
 */

export interface Config {
  /** SQLite file used by both the document store and the search index. */
  database: string;
  host: string;
  port: number;
  /**
   * Static bearer token for dev mode. Optional when local trust is on, because
   * every request a loopback server can receive is then trusted by host name.
   */
  token: string | null;
  /** Single-workspace PoC. Multi-workspace arrives with auth. */
  workspaceId: string;
  /** Skip sign-in for requests addressed to a host in `localHosts` (ADR-010). */
  trustLocal: boolean;
  /** Host names treated as this machine. Always includes the loopback names. */
  localHosts: string[];
  /** Where the config file was found, for the startup banner. Null if none. */
  configFile: string | null;
  /** OAuth sign-in (ADR-017), or null when not configured. */
  oauth: OAuthConfig | null;
  /** Semantic search with a model inside the process (ADR-022). */
  embeddings: EmbeddingsConfig;
  /**
   * The licence shown on published pages (ADR-032), such as
   * "CC BY 4.0". It covers the owner's text, not Cairn's code. Null shows
   * no licence at all.
   */
  contentLicence: string | null;
  /** How this Cairn describes itself at /.well-known/cairn.json (ADR-034). */
  selfDescription: SelfDescriptionConfig;
  /**
   * Seconds to finish a tidy shutdown in: drain requests, back up, close the
   * database (ADR-046). Must be under the platform's own grace period, which
   * is 30 seconds on Azure Container Apps and 10 on `docker stop` unless the
   * compose file says otherwise. Being killed part way through a shutdown is
   * how a truncated transaction reaches the replica.
   */
  shutdownSeconds: number;
  /** Where backups are kept, and how long (ADR-049). */
  backups: BackupConfig;
}

export interface BackupConfig {
  /**
   * Where backups go: a folder path, `abs://account@container/prefix`, or
   * `s3://bucket/prefix` (ADR-050). Off when null, so no backups are taken and
   * none are pruned.
   */
  to: string | null;
  /** Only for s3, which needs a region to sign with. */
  region: string | null;
  /** Only for s3: a store that speaks S3 but is not AWS. */
  endpoint: string | null;
  /** Back up after a write when the newest backup is older than this. */
  afterHours: number;
  /** Delete backups older than this. */
  keepDays: number;
  /** However old they are, never leave fewer than this many. */
  keepAtLeast: number;
}

export interface SelfDescriptionConfig {
  /** Shown at /.well-known/cairn.json. Defaults to "Cairn" so it is never empty. */
  name: string;
  /** In the owner's words, or null when not set. */
  description: string | null;
  /** BCP 47 language tag, such as "en". */
  language: string;
  /** What this Cairn is about, or null when not set. */
  topics: string[] | null;
}

export interface EmbeddingsConfig {
  /** `local` runs bge-small-en-v1.5 in the process; `off` is keyword search only. */
  provider: "local" | "off";
  /** Where model files are kept. */
  modelDir: string;
  /** False where the model ships with the install, as in the container image. */
  allowDownload: boolean;
  /** How far a vector match must stand above its neighbours. Null for the default. */
  margin: number | null;
}

export type ProviderConfig =
  | { kind: "github"; clientId: string; clientSecret: string }
  | { kind: "oidc"; issuer: string; clientId: string; clientSecret: string; name?: string };

export interface OAuthConfig {
  /** The address people and clients reach Cairn at, without a trailing slash. */
  publicUrl: string;
  /** Signing secrets, the current one first; a second one covers a rotation. */
  secrets: string[];
  provider: ProviderConfig;
  /** `github:<login>`, `oidc:<sub>` or `email:<address>`, lower case. */
  allowedUsers: string[];
}

/** The shape of `cairn.config.json`. Every key is optional. */
export interface ConfigFile {
  database?: string;
  /** The licence published pages carry, such as "CC BY 4.0" (ADR-032). */
  contentLicence?: string;
  /** How this Cairn describes itself at /.well-known/cairn.json (ADR-034). */
  name?: string;
  description?: string;
  language?: string;
  topics?: string[];
  port?: number;
  workspace?: string;
  /** Seconds allowed for a tidy shutdown. Default 25 (ADR-046). */
  shutdownSeconds?: number;
  /** Backups: where they go and how long they are kept (ADR-049). */
  backups?: {
    /**
     * A folder, an `abs://` or `s3://` address, or "off". Default: a `backups`
     * folder beside the database.
     */
    to?: string;
    region?: string;
    endpoint?: string;
    afterHours?: number;
    keepDays?: number;
    keepAtLeast?: number;
  };
  embeddings?: {
    provider?: "local" | "off";
    modelDir?: string;
    margin?: number;
  };
  auth?: {
    /** Default true. Set false to require the token even on localhost. */
    trustLocal?: boolean;
    /** Extra host names to trust, such as a name in /etc/hosts. */
    localHosts?: string[];
    /** OAuth settings that are not secret. Secrets only come from the environment. */
    oauth?: {
      publicUrl?: string;
      provider?: "github" | "oidc";
      issuer?: string;
      providerName?: string;
      allowedUsers?: string[];
    };
  };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
export const DEFAULT_LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];
export const CONFIG_FILE_NAME = "cairn.config.json";

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

export class ConfigError extends Error {}

/**
 * The nearest `cairn.config.json` at or above `start`, so it is found whether
 * the server is started from the repo root or from a package folder.
 */
/**
 * A path the user typed, resolved against the folder they typed it in. pnpm
 * runs package scripts from the package's own folder and records the
 * original one in INIT_CWD, so a plain resolve() would look in packages/api.
 */
export function userPath(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env["INIT_CWD"] ?? process.cwd(), path);
}

export function findConfigFile(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readConfigFile(path: string | null): ConfigFile {
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ConfigFile;
  } catch (error) {
    throw new ConfigError(
      `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return !/^(0|false|no|off)$/i.test(value);
}

const MIN_SECRET = 32;

function loadOAuth(env: NodeJS.ProcessEnv, file: ConfigFile, hostIsLoopback: boolean): OAuthConfig | null {
  const fromFile = file.auth?.oauth ?? {};
  const publicUrl = (env["CAIRN_PUBLIC_URL"] ?? fromFile.publicUrl ?? "").trim().replace(/\/+$/, "");
  const provider = (env["CAIRN_AUTH_PROVIDER"] ?? fromFile.provider ?? "").trim().toLowerCase();
  const secret = env["CAIRN_AUTH_SECRET"] ?? "";
  const clientId = env["CAIRN_OAUTH_CLIENT_ID"] ?? "";
  const clientSecret = env["CAIRN_OAUTH_CLIENT_SECRET"] ?? "";
  const allowedUsers = (env["CAIRN_ALLOWED_USERS"]?.split(",") ?? fromFile.allowedUsers ?? [])
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "");

  const anything = publicUrl || provider || secret || clientId || clientSecret;
  if (!anything) return null;

  const missing: string[] = [];
  if (!publicUrl) missing.push("CAIRN_PUBLIC_URL");
  if (!provider) missing.push("CAIRN_AUTH_PROVIDER (github or oidc)");
  if (!secret) missing.push("CAIRN_AUTH_SECRET");
  if (!clientId) missing.push("CAIRN_OAUTH_CLIENT_ID");
  if (!clientSecret) missing.push("CAIRN_OAUTH_CLIENT_SECRET");
  if (allowedUsers.length === 0) missing.push("CAIRN_ALLOWED_USERS");
  if (provider === "oidc" && !(env["CAIRN_OIDC_ISSUER"] ?? fromFile.issuer)) missing.push("CAIRN_OIDC_ISSUER");
  if (missing.length > 0) {
    throw new ConfigError(`OAuth is partly configured. Also set: ${missing.join(", ")}. See docs/DEPLOY-DOCKER.md or docs/DEPLOY-AZURE.md.`);
  }
  if (provider !== "github" && provider !== "oidc") {
    throw new ConfigError(`CAIRN_AUTH_PROVIDER must be github or oidc, got ${provider}`);
  }
  if (secret.length < MIN_SECRET) {
    throw new ConfigError(`CAIRN_AUTH_SECRET must be at least ${MIN_SECRET} characters. Generate one with: openssl rand -hex 32`);
  }
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new ConfigError(`CAIRN_PUBLIC_URL is not a URL: ${publicUrl}`);
  }
  if (url.protocol !== "https:" && !(hostIsLoopback && url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new ConfigError("CAIRN_PUBLIC_URL must be https, except http://localhost for trying OAuth locally.");
  }
  for (const entry of allowedUsers) {
    if (!/^(github|oidc|email):.+/.test(entry)) {
      throw new ConfigError(`CAIRN_ALLOWED_USERS entries look like github:yourlogin or email:you@example.com, got "${entry}"`);
    }
  }
  const previous = env["CAIRN_AUTH_SECRET_PREVIOUS"] ?? "";

  return {
    publicUrl,
    secrets: previous ? [secret, previous] : [secret],
    provider:
      provider === "github"
        ? { kind: "github", clientId, clientSecret }
        : {
            kind: "oidc",
            issuer: (env["CAIRN_OIDC_ISSUER"] ?? fromFile.issuer)!.replace(/\/+$/, ""),
            clientId,
            clientSecret,
            ...(fromFile.providerName ? { name: fromFile.providerName } : {}),
          },
    allowedUsers,
  };
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  configPath: string | null = env["CAIRN_CONFIG"] ?? findConfigFile(),
): Config {
  const file = readConfigFile(configPath);
  const token = env["CAIRN_TOKEN"] ?? "";
  const host = env["CAIRN_HOST"] ?? "127.0.0.1";
  const port = Number(env["CAIRN_PORT"] ?? file.port ?? 8787);
  const loopback = isLoopback(host);
  // Local trust needs a loopback bind: anywhere else the Host header is chosen
  // by whoever sends the request, so it cannot mean "this machine".
  const trustLocal = loopback && (parseBoolean(env["CAIRN_TRUST_LOCAL"]) ?? file.auth?.trustLocal ?? true);
  const oauth = loadOAuth(env, file, loopback);
  const localHosts = [
    ...new Set(
      [...DEFAULT_LOCAL_HOSTS, ...(file.auth?.localHosts ?? [])].map((name) =>
        name.trim().toLowerCase(),
      ),
    ),
  ];

  if (!loopback && !oauth) {
    // Without OAuth, binding to a public interface would put an unprotected
    // write API on the network, so refuse to start instead.
    throw new ConfigError(
      `refusing to listen on ${host} without OAuth. Configure it (docs/DEPLOY-DOCKER.md or docs/DEPLOY-AZURE.md), or use 127.0.0.1.`,
    );
  }
  const minToken = loopback ? 16 : MIN_SECRET;
  if (token !== "" && token.length < minToken) {
    throw new ConfigError(
      `CAIRN_TOKEN must be at least ${minToken} characters. Generate one with: openssl rand -hex 32`,
    );
  }
  if (token === "" && !trustLocal && !oauth) {
    throw new ConfigError(
      "Local trust is off, so CAIRN_TOKEN is required. Set one, or turn trustLocal back on.",
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(`port must be a number from 1 to 65535, got ${port}`);
  }

  // Deliberately shorter than Azure's 30 second grace period. The margin is
  // for the platform's own overhead between deciding to stop us and SIGKILL.
  const shutdownSeconds = Number(env["CAIRN_SHUTDOWN_SECONDS"] ?? file.shutdownSeconds ?? 25);
  if (!Number.isFinite(shutdownSeconds) || shutdownSeconds < 1 || shutdownSeconds > 600) {
    throw new ConfigError(
      `CAIRN_SHUTDOWN_SECONDS must be a number of seconds from 1 to 600, got ${env["CAIRN_SHUTDOWN_SECONDS"] ?? file.shutdownSeconds}. ` +
        "Keep it below the grace period your platform allows, which is 30 seconds on Azure Container Apps and 10 on docker stop.",
    );
  }

  // A relative path in the config file means relative to that file, not to
  // wherever the server happened to be started from.
  const base = configPath ? dirname(configPath) : process.cwd();
  const database = env["CAIRN_DB"] ?? resolve(base, file.database ?? "cairn.sqlite");
  const embeddings = loadEmbeddings(env, file, base);

  return {
    database,
    host,
    port,
    token: token === "" ? null : token,
    workspaceId: env["CAIRN_WORKSPACE"] ?? file.workspace ?? "ws_default",
    trustLocal,
    localHosts,
    configFile: configPath,
    oauth,
    embeddings,
    contentLicence: (env["CAIRN_CONTENT_LICENCE"] ?? file.contentLicence ?? "").trim() || null,
    selfDescription: loadSelfDescription(env, file),
    shutdownSeconds,
    backups: loadBackups(env, file, database),
  };
}

/**
 * Backups default to a folder beside the database, so a Cairn on a mounted
 * volume is backed up without anyone choosing to turn it on (ADR-049). An
 * in-memory database has nothing to copy, and `off` is how to say no.
 */
function loadBackups(env: NodeJS.ProcessEnv, file: ConfigFile, database: string): BackupConfig {
  const asked = (env["CAIRN_BACKUP_TO"] ?? file.backups?.to ?? "").trim();
  const to =
    asked.toLowerCase() === "off" || database === ":memory:"
      ? null
      : asked || join(dirname(database), "backups");

  const number = (name: string, given: unknown, fallback: number, max: number): number => {
    if (given === undefined || given === null || given === "") return fallback;
    const value = Number(given);
    if (!Number.isFinite(value) || value <= 0 || value > max) {
      throw new ConfigError(
        `${name} must be a number greater than 0 and no more than ${max}, got ${String(given)}`,
      );
    }
    return value;
  };

  const optional = (given: string | undefined): string | null => {
    const value = (given ?? "").trim();
    return value === "" ? null : value;
  };

  return {
    to,
    region: optional(env["CAIRN_BACKUP_REGION"] ?? file.backups?.region),
    endpoint: optional(env["CAIRN_BACKUP_ENDPOINT"] ?? file.backups?.endpoint),
    afterHours: number("CAIRN_BACKUP_AFTER_HOURS", env["CAIRN_BACKUP_AFTER_HOURS"] ?? file.backups?.afterHours, 3, 24 * 30),
    keepDays: number("CAIRN_BACKUP_KEEP_DAYS", env["CAIRN_BACKUP_KEEP_DAYS"] ?? file.backups?.keepDays, 2, 3650),
    keepAtLeast: number("CAIRN_BACKUP_KEEP_AT_LEAST", env["CAIRN_BACKUP_KEEP_AT_LEAST"] ?? file.backups?.keepAtLeast, 3, 1000),
  };
}

function loadSelfDescription(env: NodeJS.ProcessEnv, file: ConfigFile): SelfDescriptionConfig {
  const topics = (env["CAIRN_TOPICS"]?.split(",") ?? file.topics ?? [])
    .map((topic) => topic.trim())
    .filter((topic) => topic !== "");
  return {
    name: (env["CAIRN_NAME"] ?? file.name ?? "").trim() || "Cairn",
    description: (env["CAIRN_DESCRIPTION"] ?? file.description ?? "").trim() || null,
    language: (env["CAIRN_LANGUAGE"] ?? file.language ?? "").trim() || "en",
    topics: topics.length > 0 ? topics : null,
  };
}

function loadEmbeddings(env: NodeJS.ProcessEnv, file: ConfigFile, base: string): EmbeddingsConfig {
  const provider = (env["CAIRN_EMBEDDINGS"] ?? file.embeddings?.provider ?? "local").trim().toLowerCase();
  if (provider !== "local" && provider !== "off") {
    throw new ConfigError(`CAIRN_EMBEDDINGS must be local or off, got ${provider}`);
  }
  const modelDir = env["CAIRN_MODELS"]
    ?? (file.embeddings?.modelDir ? resolve(base, file.embeddings.modelDir) : join(homedir(), ".cache", "cairn", "models"));
  const margin = env["CAIRN_VECTOR_MARGIN"] !== undefined
    ? Number(env["CAIRN_VECTOR_MARGIN"])
    : (file.embeddings?.margin ?? null);
  if (margin !== null && !(margin >= 0 && margin <= 1)) {
    throw new ConfigError(`CAIRN_VECTOR_MARGIN must be a number from 0 to 1, got ${margin}`);
  }
  return {
    provider,
    modelDir,
    allowDownload: parseBoolean(env["CAIRN_MODEL_DOWNLOAD"]) ?? true,
    margin,
  };
}
