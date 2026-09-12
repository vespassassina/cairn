/**
 * Upstream sign-in (ADR-017). Cairn never sees a password: it sends the
 * browser to a provider, gets a code back, and asks the provider who it was.
 *
 * Two kinds cover almost everyone. GitHub is plain OAuth 2.0 with a user API.
 * Any OpenID Connect provider (Entra ID, Google, Auth0, Keycloak, and so on)
 * is found through its discovery document and asked through userinfo.
 */

export interface Identity {
  /** Stable key: `github:<login>` or `oidc:<sub>`, lower case. */
  id: string;
  /** Shown in the console and in attribution. */
  label: string;
  /** Only set when the provider says the address is verified. */
  verifiedEmail: string | null;
}

export interface IdentityProvider {
  /** Shown on the sign-in button, for example "GitHub". */
  readonly name: string;
  /** Where to send the browser. `verifier` is for PKCE with the provider. */
  authorizeUrl(state: string, redirectUri: string, verifier: string): Promise<string>;
  /** Swap the code for the signed-in identity. */
  identify(code: string, redirectUri: string, verifier: string): Promise<Identity>;
}

type Fetch = (input: Request) => Promise<Response>;

export interface GitHubOptions {
  clientId: string;
  clientSecret: string;
}

export function githubProvider(options: GitHubOptions, fetcher: Fetch = (r) => fetch(r)): IdentityProvider {
  return {
    name: "GitHub",
    async authorizeUrl(state, redirectUri) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("allow_signup", "false");
      // No scope: the public profile is all Cairn needs.
      return url.toString();
    },
    async identify(code, redirectUri) {
      const token = await fetcher(
        new Request("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({
            client_id: options.clientId,
            client_secret: options.clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        }),
      );
      const tokenBody = (await token.json()) as { access_token?: string; error?: string };
      if (!tokenBody.access_token) throw new Error(`GitHub refused the code: ${tokenBody.error ?? token.status}`);
      const user = await fetcher(
        new Request("https://api.github.com/user", {
          headers: {
            authorization: `Bearer ${tokenBody.access_token}`,
            accept: "application/vnd.github+json",
            "user-agent": "cairn",
          },
        }),
      );
      const profile = (await user.json()) as { login?: string; name?: string | null };
      if (!profile.login) throw new Error("GitHub did not return a user");
      return { id: `github:${profile.login.toLowerCase()}`, label: profile.login, verifiedEmail: null };
    },
  };
}

export interface OidcOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Shown on the button. Defaults to the issuer's host. */
  name?: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

export function oidcProvider(options: OidcOptions, fetcher: Fetch = (r) => fetch(r)): IdentityProvider {
  let discovery: Promise<Discovery> | null = null;
  const discover = () => {
    discovery ??= (async () => {
      const response = await fetcher(
        new Request(`${options.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`),
      );
      if (!response.ok) throw new Error(`cannot read the OIDC discovery document: HTTP ${response.status}`);
      const doc = (await response.json()) as Discovery;
      // The document must describe the issuer that was configured, or a
      // misconfiguration could send sign-ins somewhere else.
      if (doc.issuer.replace(/\/+$/, "") !== options.issuer.replace(/\/+$/, "")) {
        throw new Error(`the discovery document is for ${doc.issuer}, not ${options.issuer}`);
      }
      return doc;
    })().catch((error: unknown) => {
      discovery = null;
      throw error;
    });
    return discovery;
  };

  const challengeOf = async (verifier: string) => {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    let binary = "";
    for (const byte of digest) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  return {
    name: options.name ?? new URL(options.issuer).host,
    async authorizeUrl(state, redirectUri, verifier) {
      const doc = await discover();
      const url = new URL(doc.authorization_endpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", options.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", "openid email profile");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", await challengeOf(verifier));
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    },
    async identify(code, redirectUri, verifier) {
      const doc = await discover();
      const token = await fetcher(
        new Request(doc.token_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: options.clientId,
            client_secret: options.clientSecret,
            code_verifier: verifier,
          }).toString(),
        }),
      );
      const tokenBody = (await token.json()) as { access_token?: string; error?: string };
      if (!tokenBody.access_token) throw new Error(`the provider refused the code: ${tokenBody.error ?? token.status}`);
      const info = await fetcher(
        new Request(doc.userinfo_endpoint, { headers: { authorization: `Bearer ${tokenBody.access_token}` } }),
      );
      const claims = (await info.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string };
      if (!claims.sub) throw new Error("the provider did not say who signed in");
      return {
        id: `oidc:${claims.sub.toLowerCase()}`,
        label: claims.name ?? claims.email ?? claims.sub,
        verifiedEmail: claims.email && claims.email_verified === true ? claims.email.toLowerCase() : null,
      };
    },
  };
}

/** Is this identity on the owner's list? */
export function isAllowed(identity: Identity, allowed: string[]): boolean {
  const list = new Set(allowed.map((entry) => entry.trim().toLowerCase()));
  return list.has(identity.id) || (identity.verifiedEmail !== null && list.has(`email:${identity.verifiedEmail}`));
}
