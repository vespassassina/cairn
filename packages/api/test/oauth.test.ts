import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/app.js";
import { createContext, type AppContext } from "../src/context.js";
import { base64url, signJwt } from "../src/oauth/crypto.js";
import type { IdentityProvider } from "../src/oauth/providers.js";
import { OAuthServer } from "../src/oauth/server.js";

/**
 * The OAuth server end to end (ADR-017), as Claude and the CLI use it, with a
 * fake provider standing in for GitHub. Every attack in the MCP security
 * guidance that applies to a server like this has a test here.
 */

const ISSUER = "https://cairn.test";
const SECRET = "a".repeat(32);
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let context: AppContext;
let app: Hono;
let signInAs: string;

/** Sends the browser straight back, as a provider would after its own login. */
const fakeProvider: IdentityProvider = {
  name: "Fake",
  async authorizeUrl(state, redirectUri) {
    return `${redirectUri}?code=user-${signInAs}&state=${state}`;
  },
  async identify(code) {
    const login = code.replace(/^user-/, "");
    return { id: `github:${login}`, label: login, verifiedEmail: null };
  },
};

function build(secrets: string[] = [SECRET]) {
  const oauth = new OAuthServer({
    publicUrl: ISSUER,
    secrets,
    provider: fakeProvider,
    allowedUsers: ["github:owner"],
    store: context.auth,
  });
  return createApp({ context, token: null, trust: { enabled: false, hosts: [] }, oauth, publicOrigin: ISSUER });
}

beforeEach(async () => {
  context = await createContext({ database: ":memory:", workspaceId: "ws_oauth" });
  app = build();
  signInAs = "owner";
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Move the clock past the refresh grace window (ADR-033), so a second use of a
 * refresh token counts as a replay rather than a repeat. Only `Date` is faked:
 * the store decides a record has expired by comparing ISO times, and faking
 * the rest would stall the awaits around it.
 */
function afterGrace() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.now() + 61_000));
}

function call(path: string, init: RequestInit = {}) {
  const url = path.startsWith("http") ? path : `${ISSUER}${path}`;
  return app.fetch(new Request(url, init));
}

async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64url(digest) };
}

async function register(redirect = CLAUDE_REDIRECT, name = "Claude") {
  const response = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: name }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function authorizeUrl(clientId: string, challenge: string, redirect = CLAUDE_REDIRECT, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${ISSUER}/mcp`,
    ...extra,
  });
  return `/oauth/authorize?${params.toString()}`;
}

/** Authorize, sign in upstream, and return the consent page. */
async function toConsent(clientId: string, challenge: string, redirect = CLAUDE_REDIRECT) {
  const authorize = await call(authorizeUrl(clientId, challenge, redirect));
  expect(authorize.status).toBe(302);
  const callback = await call(authorize.headers.get("location")!);
  return callback;
}

async function approve(consentHtml: string, decision = "allow", origin = ISSUER) {
  const key = /name="request" value="([^"]+)"/.exec(consentHtml)![1]!;
  return call("/oauth/consent", {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request: key, decision }),
  });
}

async function token(params: Record<string, string>) {
  const response = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The whole flow, returning tokens. */
async function signIn(redirect = CLAUDE_REDIRECT, name = "Claude") {
  const client = String((await register(redirect, name)).body["client_id"]);
  const { verifier, challenge } = await pkce();
  const consent = await toConsent(client, challenge, redirect);
  const approved = await approve(await consent.text());
  const back = new URL(approved.headers.get("location")!);
  const tokens = await token({
    grant_type: "authorization_code",
    code: back.searchParams.get("code")!,
    redirect_uri: redirect,
    client_id: client,
    code_verifier: verifier,
  });
  return { client, verifier, back, tokens };
}

function mcp(accessToken: string | null, body: unknown) {
  return call("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("discovery, as an MCP client finds its way in", () => {
  it("answers an unauthenticated MCP call with 401 and where to look", async () => {
    const response = await mcp(null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("publishes resource and server metadata", async () => {
    const resource = await (await call("/.well-known/oauth-protected-resource/mcp")).json();
    expect(resource).toMatchObject({ resource: `${ISSUER}/mcp`, authorization_servers: [ISSUER] });
    const server = (await (await call("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(server).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/authorize`,
      token_endpoint: `${ISSUER}/oauth/token`,
      registration_endpoint: `${ISSUER}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });
});

describe("the authorization code flow", () => {
  it("signs Claude in, and its writes name the client and the person", async () => {
    const { tokens, back } = await signIn();
    expect(back.origin + back.pathname).toBe(CLAUDE_REDIRECT);
    expect(back.searchParams.get("state")).toBe("xyz");
    expect(back.searchParams.get("iss")).toBe(ISSUER);
    expect(tokens.status).toBe(200);
    expect(tokens.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "cairn" });

    const created = await mcp(String(tokens.body["access_token"]), {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "create_page", arguments: { title: "Written by Claude", body: "hello" } },
    });
    expect(created.status).toBe(200);
    const payload = (await created.json()) as { result: { content: Array<{ text: string }> } };
    const pageId = String(JSON.parse(payload.result.content[0]!.text).id);
    const page = await context.pages.get(context.workspaceId, pageId);
    expect(page.updatedBy.kind).toBe("agent");
    expect(page.updatedBy.id).toMatch(/^oauth:cl_/);
    expect(page.updatedBy.label).toBe("Claude for owner");

    const me = (await (
      await call("/api/v1/me", { headers: { authorization: `Bearer ${String(tokens.body["access_token"])}` } })
    ).json()) as Record<string, unknown>;
    expect(me).toMatchObject({ via: "oauth", identity: "github:owner" });
  });

  it("shows the client and where the key will go on the consent page", async () => {
    const client = String((await register()).body["client_id"]);
    const consent = await toConsent(client, (await pkce()).challenge);
    const html = await consent.text();
    expect(consent.status).toBe(200);
    expect(html).toContain("<strong>Claude</strong>");
    expect(html).toContain("<strong>claude.ai</strong>");
    expect(consent.headers.get("x-frame-options")).toBe("DENY");
  });

  it("turns away someone not on the allowlist", async () => {
    signInAs = "stranger";
    const client = String((await register()).body["client_id"]);
    const response = await toConsent(client, (await pkce()).challenge);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("github:stranger");
  });

  it("sends a denial back to the client as access_denied", async () => {
    const client = String((await register()).body["client_id"]);
    const consent = await toConsent(client, (await pkce()).challenge);
    const denied = await approve(await consent.text(), "deny");
    expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("refuses an approval posted from another site", async () => {
    const client = String((await register()).body["client_id"]);
    const consent = await toConsent(client, (await pkce()).challenge);
    const forged = await approve(await consent.text(), "allow", "https://evil.example");
    expect(forged.status).toBe(403);
  });

  it("accepts a loopback redirect on another port, for CLIs", async () => {
    const { tokens } = await signIn("http://127.0.0.1:1234/callback", "cairn-cli");
    expect(tokens.status).toBe(200);
    const client = String((await register("http://127.0.0.1:1234/callback", "cairn-cli")).body["client_id"]);
    const other = await call(authorizeUrl(client, (await pkce()).challenge, "http://127.0.0.1:5555/callback"));
    expect(other.status).toBe(302);
  });
});

describe("what the server refuses", () => {
  it("registers only safe redirects", async () => {
    expect((await register("http://evil.example/cb")).status).toBe(400);
    expect((await register("javascript:alert(1)")).status).toBe(400);
    expect((await register("https://claude.ai/cb#fragment")).status).toBe(400);
    expect((await register("cursor://anysphere.cursor-retrieval/oauth/callback")).status).toBe(201);
  });

  it("will not redirect to an address the client did not register", async () => {
    const client = String((await register()).body["client_id"]);
    const response = await call(authorizeUrl(client, (await pkce()).challenge, "https://evil.example/steal"));
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("insists on PKCE with S256", async () => {
    const client = String((await register()).body["client_id"]);
    const response = await call(authorizeUrl(client, "short", CLAUDE_REDIRECT, { code_challenge_method: "plain" }));
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });

  it("refuses a code twice, with the wrong verifier, or for another redirect", async () => {
    const client = String((await register()).body["client_id"]);
    const { verifier, challenge } = await pkce();
    const consent = await toConsent(client, challenge);
    const code = new URL((await approve(await consent.text())).headers.get("location")!).searchParams.get("code")!;
    const base = { grant_type: "authorization_code", code, redirect_uri: CLAUDE_REDIRECT, client_id: client };

    expect((await token({ ...base, code_verifier: "x".repeat(43) })).body["error"]).toBe("invalid_grant");
    // The failed attempt used the code up: codes are single use, right or wrong.
    expect((await token({ ...base, code_verifier: verifier })).body["error"]).toBe("invalid_grant");
  });

  it("rejects forged, expired and other servers' tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: ISSUER, aud: `${ISSUER}/mcp`, sub: "github:owner", client_id: "cl_x", iat: now, exp: now + 60 };
    const forged = await signJwt(claims, "b".repeat(32), "at+jwt");
    const expired = await signJwt({ ...claims, exp: now - 1 }, SECRET, "at+jwt");
    const elsewhere = await signJwt({ ...claims, iss: "https://other.test" }, SECRET, "at+jwt");
    const session = await signJwt({ ...claims, aud: `${ISSUER}/console` }, SECRET, "cairn-session+jwt");
    for (const bad of [forged, expired, elsewhere, session, "not-a-jwt"]) {
      const response = await mcp(bad, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    }
  });

  it("keeps accepting tokens signed with the previous secret during a rotation", async () => {
    const { tokens } = await signIn();
    app = build(["c".repeat(32), SECRET]);
    const response = await mcp(String(tokens.body["access_token"]), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(200);
  });
});

describe("refresh tokens", () => {
  it("rotate, and a reused one ends the whole sign-in once the grace has passed", async () => {
    const { client, tokens } = await signIn();
    const first = String(tokens.body["refresh_token"]);
    const renewed = await token({ grant_type: "refresh_token", refresh_token: first, client_id: client });
    expect(renewed.status).toBe(200);
    const second = String(renewed.body["refresh_token"]);
    expect(second).not.toBe(first);

    // Someone replays the first one, long after the client had its answer:
    // refused, and the family is revoked (ADR-033).
    afterGrace();
    expect((await token({ grant_type: "refresh_token", refresh_token: first, client_id: client })).body["error"]).toBe(
      "invalid_grant",
    );
    expect((await token({ grant_type: "refresh_token", refresh_token: second, client_id: client })).body["error"]).toBe(
      "invalid_grant",
    );
  });

  it("answers a repeat inside the grace window with the same tokens (ADR-033)", async () => {
    const { client, tokens } = await signIn();
    const first = String(tokens.body["refresh_token"]);
    const ask = () => token({ grant_type: "refresh_token", refresh_token: first, client_id: client });

    const renewed = await ask();
    // The answer never reached the client, or two processes refreshed at once.
    const again = await ask();
    expect(again.status).toBe(200);
    expect(again.body["refresh_token"]).toBe(renewed.body["refresh_token"]);
    expect(again.body["access_token"]).toBe(renewed.body["access_token"]);

    // The sign-in is intact: the token it was given still works afterwards.
    const next = await token({
      grant_type: "refresh_token",
      refresh_token: String(again.body["refresh_token"]),
      client_id: client,
    });
    expect(next.status).toBe(200);
  });

  it("stops replaying once the sign-in is revoked, even inside the window", async () => {
    const { client, tokens } = await signIn();
    const first = String(tokens.body["refresh_token"]);
    const renewed = await token({ grant_type: "refresh_token", refresh_token: first, client_id: client });

    await call("/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: String(renewed.body["refresh_token"]) }),
    });

    const again = await token({ grant_type: "refresh_token", refresh_token: first, client_id: client });
    expect(again.status).toBe(400);
  });

  it("can be revoked", async () => {
    const { client, tokens } = await signIn();
    const refresh = String(tokens.body["refresh_token"]);
    const revoked = await call("/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refresh }),
    });
    expect(revoked.status).toBe(200);
    expect((await token({ grant_type: "refresh_token", refresh_token: refresh, client_id: client })).status).toBe(400);
  });
});

describe("console sign-in through the provider", () => {
  it("signs a person in, and names them in history", async () => {
    const home = await call("/");
    expect(home.headers.get("location")).toContain("/login");
    const login = await (await call("/login")).text();
    expect(login).toContain("Sign in with Fake");

    const start = await call("/oauth/login?next=%2Ft");
    const callback = await call(start.headers.get("location")!);
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/t");
    const cookie = callback.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    const session = cookie.split(";")[0]!;

    expect((await call("/t", { headers: { cookie: session } })).status).toBe(200);

    const page = await context.pages.create(context.workspaceId, { title: "P", body: "x" }, {
      actor: { kind: "agent", id: "a", label: "A" },
    });
    const edit = await call(`/p/${page.id}/edit`, {
      method: "POST",
      headers: { cookie: session, origin: ISSUER, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: "P", body: "edited by a person", version: page.version }),
    });
    expect(edit.status).toBe(303);
    const saved = await context.pages.get(context.workspaceId, page.id);
    expect(saved.updatedBy).toEqual({ kind: "user", id: "github:owner", label: "owner" });
  });

  it("does not let a Host header of localhost past a public server", async () => {
    const response = await app.fetch(new Request("http://localhost/mcp", { method: "POST", body: "{}" }));
    expect(response.status).toBe(401);
  });
});
