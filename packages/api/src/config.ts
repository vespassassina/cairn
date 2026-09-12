import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Configuration, read once at startup from the environment and an optional
 * `cairn.config.json`.
 *
 * Dev mode is loopback only (PRD section 7), enforced at startup rather than
 * documented and hoped for. On loopback, requests addressed to a trusted local
 * host name need no token at all (ADR-010). The token is then only needed for
 * host names outside that list.
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
}

/** The shape of `cairn.config.json`. Every key is optional. */
export interface ConfigFile {
  database?: string;
  port?: number;
  workspace?: string;
  auth?: {
    /** Default true. Set false to require the token even on localhost. */
    trustLocal?: boolean;
    /** Extra host names to trust, such as a name in /etc/hosts. */
    localHosts?: string[];
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

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  configPath: string | null = env["CAIRN_CONFIG"] ?? findConfigFile(),
): Config {
  const file = readConfigFile(configPath);
  const token = env["CAIRN_TOKEN"] ?? "";
  const host = env["CAIRN_HOST"] ?? "127.0.0.1";
  const port = Number(env["CAIRN_PORT"] ?? file.port ?? 8787);
  const trustLocal = parseBoolean(env["CAIRN_TRUST_LOCAL"]) ?? file.auth?.trustLocal ?? true;
  const localHosts = [
    ...new Set(
      [...DEFAULT_LOCAL_HOSTS, ...(file.auth?.localHosts ?? [])].map((name) =>
        name.trim().toLowerCase(),
      ),
    ),
  ];

  if (!isLoopback(host)) {
    // Dev mode has no real auth. Binding it to a public interface would put an
    // unauthenticated write API on the network, so refuse to start instead.
    throw new ConfigError(
      `dev mode refuses to bind to ${host}. It is loopback only until OAuth lands (ADR-007).`,
    );
  }
  if (token !== "" && token.length < 16) {
    throw new ConfigError(
      "CAIRN_TOKEN must be at least 16 characters. Generate one with: openssl rand -hex 24",
    );
  }
  if (token === "" && !trustLocal) {
    throw new ConfigError(
      "Local trust is off, so CAIRN_TOKEN is required. Set one, or turn trustLocal back on.",
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(`port must be a number from 1 to 65535, got ${port}`);
  }

  // A relative path in the config file means relative to that file, not to
  // wherever the server happened to be started from.
  const base = configPath ? dirname(configPath) : process.cwd();
  const database = env["CAIRN_DB"] ?? resolve(base, file.database ?? "cairn.sqlite");

  return {
    database,
    host,
    port,
    token: token === "" ? null : token,
    workspaceId: env["CAIRN_WORKSPACE"] ?? file.workspace ?? "ws_default",
    trustLocal,
    localHosts,
    configFile: configPath,
  };
}
