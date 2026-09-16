import { createServer } from "node:http";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Fetch } from "./client.js";

/**
 * `cairn login` against a server that uses OAuth (ADR-017), the way native
 * apps do it (RFC 8252): a one-off listener on 127.0.0.1, the browser for the
 * sign-in itself, PKCE for the code. Tokens are kept in a file only the user
 * can read, one entry per server, and refreshed before they expire.
 */

export interface Credentials {
  client_id: string;
  access_token: string;
  refresh_token: string;
  /** Epoch milliseconds. */
  expires_at: number;
}

type CredentialFile = { servers: Record<string, Credentials> };

export interface LoginIo {
  fetch: Fetch;
  env: Record<string, string | undefined>;
  stderr: (text: string) => void;
  /** Open the sign-in page. The URL is also printed, for when no browser opens. */
  openBrowser: (url: string) => Promise<void>;
}

/** Where tokens live: CAIRN_CREDENTIALS, else the OS's usual config folder. */
export function credentialsPath(env: Record<string, string | undefined>, platform: string = process.platform): string {
  if (env["CAIRN_CREDENTIALS"]) return env["CAIRN_CREDENTIALS"];
  if (platform === "win32") return join(env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "cairn", "credentials.json");
  return join(env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "cairn", "credentials.json");
}

async function readCredentials(path: string): Promise<CredentialFile> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CredentialFile;
  } catch {
    return { servers: {} };
  }
}

/**
 * Writes one server's entry, re-reading the file first (ADR-054): a process
 * that has been asleep, refreshing a token, cannot then overwrite an entry a
 * faster process wrote in the meantime with its own stale in-memory copy.
 * `entry: null` removes the server's entry instead of setting it.
 */
async function writeCredentials(path: string, key: string, entry: Credentials | null): Promise<void> {
  const file = await readCredentials(path);
  if (entry) file.servers[key] = entry;
  else delete file.servers[key];
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined); // Windows keeps the profile's own permissions.
}

const serverKey = (baseUrl: string) => baseUrl.replace(/\/+$/, "");

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface Metadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint?: string;
}

/**
 * The server has no sign-in to offer: it answered without OAuth metadata, or
 * did not answer. `cairn login` explains what to do instead, which depends on
 * how the address was chosen, so the message is written there.
 */
export class NoSignIn extends Error {
  constructor(
    readonly baseUrl: string,
    /** The HTTP status it answered with, or null when it did not answer. */
    readonly status: number | null,
  ) {
    super(status === null ? `could not reach ${baseUrl}` : `${baseUrl} has no browser sign-in (HTTP ${status})`);
  }
}

async function metadata(baseUrl: string, fetcher: Fetch): Promise<Metadata> {
  let response: Response;
  try {
    response = await fetcher(new Request(`${serverKey(baseUrl)}/.well-known/oauth-authorization-server`));
  } catch {
    throw new NoSignIn(baseUrl, null);
  }
  if (response.status >= 500) {
    throw new Error(`${baseUrl} answered HTTP ${response.status} when asked how to sign in. If it was starting, try again in a minute.`);
  }
  const body = response.ok ? ((await response.json().catch(() => null)) as Metadata | null) : null;
  if (!body || typeof body.authorization_endpoint !== "string") throw new NoSignIn(baseUrl, response.status);
  return body;
}

async function tokenRequest(fetcher: Fetch, endpoint: string, params: Record<string, string>) {
  const response = await fetcher(
    new Request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || typeof body["access_token"] !== "string") {
    throw new Error(`sign-in failed: ${String(body["error_description"] ?? body["error"] ?? response.status)}`);
  }
  return body as { access_token: string; refresh_token: string; expires_in: number };
}

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Larger than the roughly 25 second cold start of a Cairn on Azure's free
 * tier (ADR-054), so a refresh during a cold start gets a real answer
 * instead of a timeout that looks like the sign-in itself is broken.
 */
export const REFRESH_TIMEOUT_MS = 30_000;

interface RefreshTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/** Why `storedToken` could not refresh a sign-in that exists but is expiring. */
export type RefreshFailureReason =
  | { kind: "invalid_grant" }
  | { kind: "http"; status: number; message: string }
  | { kind: "network"; message: string };

/**
 * Thrown by `storedToken` when a sign-in is on record but a refresh did not
 * succeed. `reason.kind` tells the caller whether the sign-in is actually
 * gone (`invalid_grant`, the only case where the stored credentials are
 * deleted) or the refresh merely failed to happen (`http`, `network`), in
 * which case the credentials are left in place for the next attempt.
 */
export class RefreshFailed extends Error {
  constructor(
    readonly baseUrl: string,
    readonly reason: RefreshFailureReason,
  ) {
    super(
      reason.kind === "invalid_grant"
        ? `the sign-in to ${baseUrl} is no longer valid`
        : reason.kind === "http"
          ? `${baseUrl} refused to refresh the sign-in (HTTP ${reason.status}): ${reason.message}`
          : `could not reach ${baseUrl} to refresh the sign-in: ${reason.message}`,
    );
  }
}

type RefreshOutcome = { ok: true; tokens: RefreshTokens } | ({ ok: false } & RefreshFailureReason);

async function refreshOnce(fetcher: Fetch, endpoint: string, params: Record<string, string>): Promise<Response> {
  return fetcher(
    new Request(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    }),
  );
}

/**
 * A refresh request with its own timeout and one retry on a connection-level
 * failure (ADR-054): a cold container or a dropped connection is often gone
 * on the next attempt. The result always classifies why, never throws for an
 * answer the server actually gave.
 */
async function refreshRequest(fetcher: Fetch, endpoint: string, params: Record<string, string>): Promise<RefreshOutcome> {
  let response: Response;
  try {
    response = await refreshOnce(fetcher, endpoint, params);
  } catch {
    try {
      response = await refreshOnce(fetcher, endpoint, params);
    } catch (error) {
      return { ok: false, kind: "network", message: error instanceof Error ? error.message : String(error) };
    }
  }
  let body: Record<string, unknown>;
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, kind: "network", message: `the answer was not JSON (HTTP ${response.status})` };
  }
  if (
    response.ok &&
    typeof body["access_token"] === "string" &&
    typeof body["refresh_token"] === "string" &&
    typeof body["expires_in"] === "number"
  ) {
    return { ok: true, tokens: body as unknown as RefreshTokens };
  }
  if (body["error"] === "invalid_grant") return { ok: false, kind: "invalid_grant" };
  return {
    ok: false,
    kind: "http",
    status: response.status,
    message: String(body["error_description"] ?? body["error"] ?? response.statusText),
  };
}

export async function login(baseUrl: string, io: LoginIo): Promise<Credentials> {
  const meta = await metadata(baseUrl, io.fetch);

  // A listener on a free port, for the browser to come back to.
  let resolveCode: (value: { code: string; state: string }) => void;
  let rejectCode: (error: Error) => void;
  const arrived = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      error
        ? "<p>Sign-in was not completed. You can close this window.</p>"
        : "<p>Signed in to Cairn. You can close this window and go back to the terminal.</p>",
    );
    if (error) rejectCode(new Error(`sign-in was not completed: ${error}`));
    else resolveCode({ code: url.searchParams.get("code") ?? "", state: url.searchParams.get("state") ?? "" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  try {
    const registered = await io.fetch(
      new Request(meta.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "cairn CLI", redirect_uris: [redirectUri] }),
      }),
    );
    if (!registered.ok) throw new Error(`the server refused to register the CLI (HTTP ${registered.status})`);
    const clientId = String(((await registered.json()) as Record<string, unknown>)["client_id"]);

    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
    );
    const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
    const authorize = new URL(meta.authorization_endpoint);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource: serverKey(baseUrl),
    }).toString();

    io.stderr(`Opening your browser to sign in. If it does not open, visit:\n  ${authorize.toString()}\n`);
    await io.openBrowser(authorize.toString()).catch(() => undefined);

    const timeout = setTimeout(() => rejectCode(new Error("no sign-in within 5 minutes")), LOGIN_TIMEOUT_MS);
    const result = await arrived.finally(() => clearTimeout(timeout));
    if (result.state !== state) throw new Error("the sign-in came back with the wrong state; try again");

    const tokens = await tokenRequest(io.fetch, meta.token_endpoint, {
      grant_type: "authorization_code",
      code: result.code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    const credentials: Credentials = {
      client_id: clientId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
    };
    await writeCredentials(credentialsPath(io.env), serverKey(baseUrl), credentials);
    return credentials;
  } finally {
    server.close();
  }
}

/**
 * A usable access token for this server, refreshed if it is about to expire,
 * or null when there is no sign-in stored. Throws `RefreshFailed` when a
 * sign-in exists but a needed refresh did not succeed; the caller decides
 * what to tell the person (ADR-054).
 */
export async function storedToken(baseUrl: string, io: Pick<LoginIo, "fetch" | "env">): Promise<string | null> {
  const key = serverKey(baseUrl);
  const path = credentialsPath(io.env);
  const saved = (await readCredentials(path)).servers[key];
  if (!saved) return null;
  if (saved.expires_at - 60_000 > Date.now()) return saved.access_token;

  let endpoint: string;
  try {
    endpoint = (await metadata(baseUrl, io.fetch)).token_endpoint;
  } catch (error) {
    // Could not even ask how to refresh: the same "server unreachable"
    // bucket as a failed refresh request itself.
    throw new RefreshFailed(baseUrl, { kind: "network", message: error instanceof Error ? error.message : String(error) });
  }

  const outcome = await refreshRequest(io.fetch, endpoint, {
    grant_type: "refresh_token",
    refresh_token: saved.refresh_token,
    client_id: saved.client_id,
  });

  if (outcome.ok) {
    const updated: Credentials = {
      client_id: saved.client_id,
      access_token: outcome.tokens.access_token,
      refresh_token: outcome.tokens.refresh_token,
      expires_at: Date.now() + outcome.tokens.expires_in * 1000,
    };
    await writeCredentials(path, key, updated);
    return updated.access_token;
  }

  // Only a genuine invalid_grant means the sign-in is actually gone; an HTTP
  // or network failure leaves it in place for the next attempt.
  if (outcome.kind === "invalid_grant") await writeCredentials(path, key, null);
  throw new RefreshFailed(baseUrl, outcome);
}

/**
 * Reads what is on record for this server without refreshing or deleting
 * anything, for `cairn status` (ADR-053): a status check must not have the
 * side effect of signing the person out.
 */
export async function peekCredentials(baseUrl: string, env: Record<string, string | undefined>): Promise<{ expiresAt: number } | null> {
  const file = await readCredentials(credentialsPath(env));
  const saved = file.servers[serverKey(baseUrl)];
  return saved ? { expiresAt: saved.expires_at } : null;
}

/** Forget this server's sign-in, revoking it on the server first. */
export async function logout(baseUrl: string, io: Pick<LoginIo, "fetch" | "env">): Promise<boolean> {
  const path = credentialsPath(io.env);
  const key = serverKey(baseUrl);
  const saved = (await readCredentials(path)).servers[key];
  if (!saved) return false;
  try {
    const meta = await metadata(baseUrl, io.fetch);
    if (meta.revocation_endpoint) {
      await io.fetch(
        new Request(meta.revocation_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: saved.refresh_token }).toString(),
        }),
      );
    }
  } catch {
    // Offline or gone: forgetting it locally is still what was asked.
  }
  await writeCredentials(path, key, null);
  return true;
}
