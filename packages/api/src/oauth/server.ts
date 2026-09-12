import type { Context, Hono } from "hono";
import type { Actor, AuthStore } from "@cairn/core";
import { pkceMatches, randomToken, sha256, signJwt, verifyJwt } from "./crypto.js";
import { isAllowed, type Identity, type IdentityProvider } from "./providers.js";

/**
 * The OAuth 2.1 authorization server (ADR-007, ADR-017).
 *
 * Small by design:
 *
 * 1. Authorization code with PKCE (S256 only), and refresh tokens that are
 *    single use and rotate. No other grants.
 * 2. Dynamic client registration, which Claude and other MCP clients use.
 * 3. Sign-in is delegated to one upstream provider. Only identities on the
 *    owner's allowlist get past it.
 * 4. A consent page names the client and where it will send the code, so a
 *    client registered by someone else cannot quietly obtain a token.
 * 5. Access tokens are HS256 JWTs checked locally on every request: no store
 *    read, no network call.
 *
 * Standards followed: OAuth 2.1 draft, RFC 7591 (registration), RFC 8414
 * (server metadata), RFC 9728 (protected resource metadata), RFC 8707
 * (resource indicators), RFC 8252 (loopback redirects), RFC 7009 (revocation),
 * and the MCP authorization specification built on them.
 */

export interface OAuthSettings {
  /** The address people and clients reach Cairn at, such as https://cairn.example.com. */
  publicUrl: string;
  /** Signing secrets, the current one first. A second one covers a rotation. */
  secrets: string[];
  provider: IdentityProvider;
  /** `github:<login>`, `oidc:<sub>` or `email:<address>`. */
  allowedUsers: string[];
  store: AuthStore;
}

const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const CODE_SECONDS = 5 * 60;
const PENDING_SECONDS = 10 * 60;
const SCOPE = "cairn";

export const SESSION_TYP = "cairn-session+jwt";
const ACCESS_TYP = "at+jwt";

interface Client {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: string;
}

interface AuthorizeRequest {
  client_id: string;
  client_name: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  scope: string;
  resource: string;
}

/** Sign-in in progress at the upstream provider. */
interface Pending {
  flow: "authorize" | "console";
  verifier: string;
  request?: AuthorizeRequest;
  next?: string;
}

/** Signed in upstream, waiting for the owner to approve the client. */
interface Consent {
  request: AuthorizeRequest;
  identity: Identity;
}

interface CodeGrant {
  client_id: string;
  client_name: string;
  redirect_uri: string;
  code_challenge: string;
  identity: Identity;
  scope: string;
  resource: string;
}

interface RefreshGrant {
  family: string;
  client_id: string;
  client_name: string;
  identity: Identity;
  scope: string;
  resource: string;
}

const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
const nowSeconds = () => Math.floor(Date.now() / 1000);

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Loopback redirects may use any port (RFC 8252 section 7.3). */
function isLoopbackUrl(url: URL): boolean {
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:"]);

/** Allowed: https, loopback http, and a native app's own scheme. */
function acceptableRedirect(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash !== "") return false;
  if (BLOCKED_SCHEMES.has(url.protocol)) return false;
  if (url.protocol === "http:") return isLoopbackUrl(url);
  return true;
}

function redirectMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let asked: URL;
  try {
    asked = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopbackUrl(asked)) return false;
  return registered.some((candidate) => {
    const known = new URL(candidate);
    return isLoopbackUrl(known) && known.hostname === asked.hostname && known.pathname === asked.pathname;
  });
}

export class OAuthServer {
  readonly issuer: string;
  private readonly resources: Set<string>;

  constructor(private readonly settings: OAuthSettings) {
    this.issuer = settings.publicUrl.replace(/\/+$/, "");
    // One owner, one server: a token for any of Cairn's doors is good for all.
    this.resources = new Set([this.issuer, `${this.issuer}/`, `${this.issuer}/mcp`, `${this.issuer}/api/v1`]);
  }

  get providerName(): string {
    return this.settings.provider.name;
  }

  /** RFC 9728: where a client learns which server issues tokens for a resource. */
  resourceMetadataUrl(resourcePath: "/mcp" | "/api/v1" | ""): string {
    return `${this.issuer}/.well-known/oauth-protected-resource${resourcePath}`;
  }

  /** Who an access token belongs to, or null. Local check, no store read. */
  async verifyAccessToken(token: string): Promise<{ actor: Actor; identity: string } | null> {
    const claims = await verifyJwt(token, this.settings.secrets, ACCESS_TYP);
    if (!claims || claims["iss"] !== this.issuer || !this.resources.has(String(claims["aud"]))) return null;
    const clientName = String(claims["client_name"] ?? "OAuth client");
    const who = String(claims["name"] ?? claims["sub"]);
    return {
      identity: String(claims["sub"]),
      actor: {
        kind: "agent",
        id: `oauth:${String(claims["client_id"])}`,
        label: `${clientName} for ${who}`.slice(0, 120),
      },
    };
  }

  /** The person behind a console session cookie, or null. */
  async verifySession(cookie: string): Promise<{ id: string; label: string } | null> {
    const claims = await verifyJwt(cookie, this.settings.secrets, SESSION_TYP);
    if (!claims || claims["iss"] !== this.issuer || claims["aud"] !== `${this.issuer}/console`) return null;
    return { id: String(claims["sub"]), label: String(claims["name"] ?? claims["sub"]) };
  }

  private async sessionFor(identity: Identity): Promise<string> {
    return signJwt(
      {
        iss: this.issuer,
        aud: `${this.issuer}/console`,
        sub: identity.id,
        name: identity.label,
        iat: nowSeconds(),
        exp: nowSeconds() + SESSION_SECONDS,
      },
      this.settings.secrets[0]!,
      SESSION_TYP,
    );
  }

  private async issueTokens(grant: Omit<RefreshGrant, "family">, family: string): Promise<Record<string, unknown>> {
    const access = await signJwt(
      {
        iss: this.issuer,
        aud: grant.resource,
        sub: grant.identity.id,
        name: grant.identity.label,
        client_id: grant.client_id,
        client_name: grant.client_name,
        scope: grant.scope,
        jti: randomToken(12),
        iat: nowSeconds(),
        exp: nowSeconds() + ACCESS_TOKEN_SECONDS,
      },
      this.settings.secrets[0]!,
      ACCESS_TYP,
    );
    const refresh = randomToken(32);
    await this.settings.store.putAuth(
      "refresh",
      await sha256(refresh),
      { ...grant, family } satisfies RefreshGrant,
      inSeconds(REFRESH_TOKEN_SECONDS),
    );
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refresh,
      scope: grant.scope,
    };
  }

  register(app: Hono, options: { secureCookies: boolean; sessionCookie: string }): void {
    const { store, provider } = this.settings;
    const callback = `${this.issuer}/oauth/callback`;

    // Metadata and the token endpoints are called by clients from anywhere,
    // including browser-based MCP clients, and carry no cookies.
    const cors = (c: Context) => {
      c.header("access-control-allow-origin", "*");
      c.header("access-control-allow-headers", "content-type, authorization, mcp-protocol-version");
      c.header("access-control-allow-methods", "GET, POST, OPTIONS");
    };
    for (const path of ["/.well-known/*", "/oauth/register", "/oauth/token", "/oauth/revoke"]) {
      app.options(path, (c) => {
        cors(c);
        return c.body(null, 204);
      });
    }

    const oauthError = (c: Context, status: 400 | 401, error: string, description: string) => {
      cors(c);
      c.header("cache-control", "no-store");
      return c.json({ error, error_description: description }, status);
    };

    // RFC 9728 and RFC 8414.
    const resourceMetadata = (c: Context, resource: string) => {
      cors(c);
      return c.json({
        resource,
        authorization_servers: [this.issuer],
        bearer_methods_supported: ["header"],
        scopes_supported: [SCOPE],
        resource_name: "Cairn",
      });
    };
    app.get("/.well-known/oauth-protected-resource", (c) => resourceMetadata(c, this.issuer));
    app.get("/.well-known/oauth-protected-resource/mcp", (c) => resourceMetadata(c, `${this.issuer}/mcp`));
    app.get("/.well-known/oauth-protected-resource/api/v1", (c) => resourceMetadata(c, `${this.issuer}/api/v1`));
    app.get("/.well-known/oauth-authorization-server", (c) => {
      cors(c);
      return c.json({
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/oauth/authorize`,
        token_endpoint: `${this.issuer}/oauth/token`,
        registration_endpoint: `${this.issuer}/oauth/register`,
        revocation_endpoint: `${this.issuer}/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [SCOPE],
        authorization_response_iss_parameter_supported: true,
      });
    });

    // RFC 7591. Public clients only: no client secrets to leak.
    app.post("/oauth/register", async (c) => {
      let body: { redirect_uris?: unknown; client_name?: unknown };
      try {
        body = await c.req.json();
      } catch {
        return oauthError(c, 400, "invalid_client_metadata", "The body must be JSON.");
      }
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
      if (uris.length === 0 || uris.length > 10 || !uris.every(acceptableRedirect)) {
        return oauthError(
          c,
          400,
          "invalid_redirect_uri",
          "Give 1 to 10 redirect_uris, each https, http on localhost, or an app's own scheme.",
        );
      }
      const client: Client = {
        client_id: `cl_${randomToken(16)}`,
        client_name: typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : "Unnamed client",
        redirect_uris: uris,
        created_at: new Date().toISOString(),
      };
      await store.putAuth("client", client.client_id, client, null);
      cors(c);
      return c.json(
        {
          ...client,
          client_id_issued_at: nowSeconds(),
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
        201,
      );
    });

    const page = (title: string, content: string) =>
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${escapeHtml(title)} · Cairn</title><link rel="stylesheet" href="/assets/console.css"></head>` +
      `<body><main class="ak-page cairn-narrow"><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`;
    const htmlResponse = (c: Context, status: 200 | 400 | 403, body: string) => {
      // No form-action: browsers apply it to the redirect back to the app, which
      // may be a native app's own scheme. The approval form itself posts here.
      c.header("content-security-policy", "default-src 'self'; frame-ancestors 'none'");
      c.header("x-frame-options", "DENY");
      c.header("cache-control", "no-store");
      return c.html(body, status);
    };
    const failPage = (c: Context, status: 400 | 403, message: string) =>
      htmlResponse(c, status, page("Cannot sign in", `<p>${escapeHtml(message)}</p>`));

    const toProvider = async (c: Context, pending: Pending) => {
      const state = randomToken(24);
      await store.putAuth("pending", state, pending, inSeconds(PENDING_SECONDS));
      return c.redirect(await provider.authorizeUrl(state, callback, pending.verifier), 302);
    };

    // The authorization endpoint. Everything is checked before the browser
    // leaves for the provider; errors that cannot be sent to a verified
    // redirect are shown here instead (OAuth 2.1 section 4.1.2.1).
    app.get("/oauth/authorize", async (c) => {
      const q = (name: string) => c.req.query(name) ?? "";
      const client = await store.getAuth<Client>("client", q("client_id"));
      if (!client) return failPage(c, 400, "This app is not registered with this Cairn. Ask it to connect again.");
      if (!redirectMatches(client.redirect_uris, q("redirect_uri"))) {
        return failPage(c, 400, "The app asked to be sent somewhere it did not register.");
      }
      const back = (error: string, description: string) => {
        const url = new URL(q("redirect_uri"));
        url.searchParams.set("error", error);
        url.searchParams.set("error_description", description);
        if (q("state")) url.searchParams.set("state", q("state"));
        url.searchParams.set("iss", this.issuer);
        return c.redirect(url.toString(), 302);
      };
      if (q("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code.");
      if (q("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q("code_challenge"))) {
        return back("invalid_request", "PKCE with code_challenge_method=S256 is required.");
      }
      const resource = q("resource") || this.issuer;
      if (!this.resources.has(resource)) return back("invalid_target", `This server issues tokens for ${this.issuer}.`);

      return toProvider(c, {
        flow: "authorize",
        verifier: randomToken(32),
        request: {
          client_id: client.client_id,
          client_name: client.client_name,
          redirect_uri: q("redirect_uri"),
          code_challenge: q("code_challenge"),
          state: q("state") || null,
          scope: SCOPE,
          resource: resource.replace(/\/$/, ""),
        },
      });
    });

    // Console sign-in goes through the same provider.
    app.get("/oauth/login", async (c) => {
      const next = c.req.query("next") ?? "/";
      return toProvider(c, {
        flow: "console",
        verifier: randomToken(32),
        next: next.startsWith("/") && !next.startsWith("//") ? next : "/",
      });
    });

    app.get("/oauth/callback", async (c) => {
      const pending = await store.takeAuth<Pending>("pending", c.req.query("state") ?? "");
      if (!pending) return failPage(c, 400, "This sign-in has expired or was already used. Start again.");
      const code = c.req.query("code");
      if (!code) return failPage(c, 400, `${provider.name} did not complete the sign-in: ${c.req.query("error") ?? "no code"}.`);

      let identity: Identity;
      try {
        identity = await provider.identify(code, callback, pending.verifier);
      } catch (error) {
        return failPage(c, 400, `${provider.name} sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!isAllowed(identity, this.settings.allowedUsers)) {
        return failPage(
          c,
          403,
          `${identity.label} is not on this Cairn's list of allowed users. The owner can add "${identity.id}" to CAIRN_ALLOWED_USERS.`,
        );
      }

      if (pending.flow === "console") {
        c.header(
          "set-cookie",
          `${options.sessionCookie}=${await this.sessionFor(identity)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${options.secureCookies ? "; Secure" : ""}`,
        );
        return c.redirect(pending.next ?? "/", 303);
      }

      const request = pending.request!;
      const key = randomToken(24);
      await store.putAuth("pending", key, { request, identity } satisfies Consent, inSeconds(PENDING_SECONDS));
      const target = new URL(request.redirect_uri);
      const where = isLoopbackUrl(target) ? "a program on this computer" : target.host;
      return htmlResponse(
        c,
        200,
        page(
          "Allow access?",
          `<p><strong>${escapeHtml(request.client_name)}</strong> wants to read and write your Cairn as ` +
            `<strong>${escapeHtml(identity.label)}</strong>.</p>` +
            `<p>If you allow it, Cairn sends it a key to <strong>${escapeHtml(where)}</strong>. ` +
            `Every change it makes is kept in history, and you can undo it.</p>` +
            `<p>Only allow apps you just asked to connect.</p>` +
            `<form method="post" action="/oauth/consent" class="cairn-actions">` +
            `<input type="hidden" name="request" value="${key}">` +
            `<button type="submit" name="decision" value="allow" class="ak-btn ak-btn-primary">Allow</button> ` +
            `<button type="submit" name="decision" value="deny" class="ak-btn">Deny</button></form>`,
        ),
      );
    });

    app.post("/oauth/consent", async (c) => {
      // The form can only come from the page above: same origin, one use.
      if (c.req.header("origin") !== new URL(this.issuer).origin) {
        return failPage(c, 403, "That approval did not come from this Cairn.");
      }
      const form = await c.req.parseBody();
      const consent = await store.takeAuth<Consent>("pending", String(form["request"] ?? ""));
      if (!consent) return failPage(c, 400, "This approval has expired or was already used. Connect again.");
      const { request, identity } = consent;
      const url = new URL(request.redirect_uri);
      if (request.state) url.searchParams.set("state", request.state);
      url.searchParams.set("iss", this.issuer);

      if (form["decision"] !== "allow") {
        url.searchParams.set("error", "access_denied");
        return c.redirect(url.toString(), 303);
      }
      const code = randomToken(32);
      await store.putAuth(
        "code",
        await sha256(code),
        {
          client_id: request.client_id,
          client_name: request.client_name,
          redirect_uri: request.redirect_uri,
          code_challenge: request.code_challenge,
          identity,
          scope: request.scope,
          resource: request.resource,
        } satisfies CodeGrant,
        inSeconds(CODE_SECONDS),
      );
      url.searchParams.set("code", code);
      return c.redirect(url.toString(), 303);
    });

    const formOf = async (c: Context): Promise<Record<string, string>> => {
      const type = c.req.header("content-type") ?? "";
      if (type.includes("application/json")) {
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]));
      }
      const body = await c.req.parseBody();
      return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]));
    };

    app.post("/oauth/token", async (c) => {
      const form = await formOf(c);
      if (form["grant_type"] === "authorization_code") {
        const grant = await store.takeAuth<CodeGrant>("code", await sha256(form["code"] ?? ""));
        if (!grant) return oauthError(c, 400, "invalid_grant", "The code is unknown, expired or already used.");
        if (grant.client_id !== form["client_id"]) return oauthError(c, 400, "invalid_grant", "The code was issued to another client.");
        if (grant.redirect_uri !== form["redirect_uri"]) return oauthError(c, 400, "invalid_grant", "redirect_uri does not match.");
        if (!(await pkceMatches(form["code_verifier"] ?? "", grant.code_challenge))) {
          return oauthError(c, 400, "invalid_grant", "code_verifier does not match the code_challenge.");
        }
        cors(c);
        c.header("cache-control", "no-store");
        return c.json(await this.issueTokens(grant, randomToken(12)));
      }

      if (form["grant_type"] === "refresh_token") {
        const hash = await sha256(form["refresh_token"] ?? "");
        const grant = await store.takeAuth<RefreshGrant>("refresh", hash);
        if (!grant) {
          // A refresh token used twice was probably stolen: end its whole family.
          const used = await store.getAuth<{ family: string }>("refresh_used", hash);
          if (used) await store.putAuth("family_revoked", used.family, { at: new Date().toISOString() }, inSeconds(REFRESH_TOKEN_SECONDS));
          return oauthError(c, 400, "invalid_grant", "The refresh token is unknown, expired or already used.");
        }
        if (await store.getAuth("family_revoked", grant.family)) {
          return oauthError(c, 400, "invalid_grant", "This sign-in was revoked. Connect again.");
        }
        if (grant.client_id !== form["client_id"]) return oauthError(c, 400, "invalid_grant", "The token was issued to another client.");
        await store.putAuth("refresh_used", hash, { family: grant.family }, inSeconds(REFRESH_TOKEN_SECONDS));
        const { family, ...rest } = grant;
        cors(c);
        c.header("cache-control", "no-store");
        return c.json(await this.issueTokens(rest, family));
      }

      return oauthError(c, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
    });

    // RFC 7009. Always 200, whether or not the token existed.
    app.post("/oauth/revoke", async (c) => {
      const form = await formOf(c);
      const grant = await store.takeAuth<RefreshGrant>("refresh", await sha256(form["token"] ?? ""));
      if (grant) await store.putAuth("family_revoked", grant.family, { at: new Date().toISOString() }, inSeconds(REFRESH_TOKEN_SECONDS));
      cors(c);
      return c.body(null, 200);
    });
  }
}
