import type { Config } from "../config.js";
import type { AppContext } from "../context.js";
import { githubProvider, oidcProvider } from "./providers.js";
import { OAuthServer } from "./server.js";

/** The OAuth server a config describes, or null when OAuth is not configured. */
export function oauthFromConfig(config: Pick<Config, "oauth">, context: Pick<AppContext, "auth">): OAuthServer | null {
  const oauth = config.oauth;
  if (!oauth) return null;
  const provider =
    oauth.provider.kind === "github"
      ? githubProvider({ clientId: oauth.provider.clientId, clientSecret: oauth.provider.clientSecret })
      : oidcProvider({
          issuer: oauth.provider.issuer,
          clientId: oauth.provider.clientId,
          clientSecret: oauth.provider.clientSecret,
          ...(oauth.provider.name ? { name: oauth.provider.name } : {}),
        });
  return new OAuthServer({
    publicUrl: oauth.publicUrl,
    secrets: oauth.secrets,
    provider,
    allowedUsers: oauth.allowedUsers,
    store: context.auth,
  });
}
