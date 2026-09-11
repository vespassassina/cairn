/**
 * Configuration, read once from the environment.
 *
 * Dev mode is a static bearer token on loopback only (PRD section 7). The
 * loopback check is enforced at startup, not documented and hoped for.
 */

export interface Config {
  /** SQLite file used by both the document store and the search index. */
  database: string;
  host: string;
  port: number;
  /** Static bearer token for dev mode. */
  token: string;
  /** Single-workspace PoC. Multi-workspace arrives with auth. */
  workspaceId: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const token = env["CAIRN_TOKEN"] ?? "";
  const host = env["CAIRN_HOST"] ?? "127.0.0.1";
  const port = Number(env["CAIRN_PORT"] ?? 8787);

  if (token.length < 16) {
    throw new ConfigError(
      "CAIRN_TOKEN must be set to at least 16 characters. Generate one with: openssl rand -hex 24",
    );
  }
  if (!isLoopback(host)) {
    // Dev mode has no real auth. Binding it to a public interface would put an
    // unauthenticated write API on the network, so refuse to start instead.
    throw new ConfigError(
      `dev mode refuses to bind to ${host}. It is loopback only until OAuth lands (ADR-007).`,
    );
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(`CAIRN_PORT must be a port number, got ${env["CAIRN_PORT"]}`);
  }

  return {
    database: env["CAIRN_DB"] ?? "./cairn.sqlite",
    host,
    port,
    token,
    workspaceId: env["CAIRN_WORKSPACE"] ?? "ws_default",
  };
}
