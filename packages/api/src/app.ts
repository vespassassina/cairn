import { Hono, type MiddlewareHandler } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Actor } from "@cairn/core";
import type { AppContext } from "./context.js";
import { SERVER_INSTRUCTIONS } from "./mcp/instructions.js";
import { cachedInstructions } from "./mcp/summary.js";
import { registerTools } from "./mcp/tools.js";
import { restRoutes } from "./rest/routes.js";
import { NO_LOCAL_TRUST, trustedForMcp, type LocalTrust } from "./trust.js";
import type { OAuthServer } from "./oauth/server.js";
import { registerConsole } from "./web/console.js";
import { registerPublicWiki, type SelfDescription } from "./web/public.js";
import { SESSION_COOKIE } from "./web/session.js";

/**
 * The Hono app. Handlers use web standard Request and Response only, so the
 * same app runs on Node, Lambda and Azure Functions through a thin entry point
 * (ADR-006). Nothing here knows which one it is on.
 */

export interface AppOptions {
  context: AppContext;
  /**
   * Dev-mode bearer token. Required on every route except /health, unless the
   * request is trusted as local. Null means only local requests get in.
   */
  token: string | null;
  /** Skip the token for trusted local requests (ADR-010). Off unless given. */
  trust?: LocalTrust;
  /** OAuth sign-in and token checks (ADR-017). Null or absent: not configured. */
  oauth?: OAuthServer | null;
  /** The origin people use, when it differs from what the server sees (a TLS proxy). */
  publicOrigin?: string | null;
  /** The licence published pages carry (ADR-032). Null shows none. */
  contentLicence?: string | null;
  /** How this Cairn describes itself at /.well-known/cairn.json (ADR-034). */
  selfDescription?: SelfDescription;
  /** The IndexNow key (ADR-074). Null or absent: publishing never notifies IndexNow. */
  indexNowKey?: string | null;
  /** Overrides `fetch` for IndexNow submissions. Only ever set by tests. */
  indexNowFetch?: typeof fetch;
  /**
   * Told about every request that changed something, so it can back up when
   * the last backup is more than three hours old (ADR-049). Absent in tests
   * and short-lived commands, which back up nothing.
   */
  onWrite?: () => void;
  /**
   * Epoch milliseconds of the newest backup (0: none yet, null: unknown or
   * backups off), read by the console footer and /health (ADR-056/057
   * fault 8). Absent when there is no backup engine.
   */
  backupStatus?: () => number | null;
}

/** How a request got in, for attribution and for GET /api/v1/me. */
export interface Caller {
  actor: Actor;
  via: "local" | "token" | "oauth";
  /** The signed-in person, for OAuth: `github:<login>` and the like. */
  identity: string | null;
}

const SERVER_INFO = { name: "cairn", version: "0.1.7" };

/**
 * A fresh server and transport per request.
 *
 * Stateless streamable HTTP forbids reusing a transport, which suits a runtime
 * where instances are recycled between calls and share no memory. It also
 * means no session state to lose, and no server-initiated messages.
 */
async function handleMcpRequest(
  request: Request,
  context: AppContext,
  actor: Actor,
): Promise<Response> {
  // Instructions are only sent in the initialize result, so the live summary
  // of the workspace (ADR-012) is built for that request and no other.
  const instructions = (await isInitialize(request))
    ? await cachedInstructions(context)
    : SERVER_INSTRUCTIONS;
  const server = new McpServer(SERVER_INFO, { instructions });
  registerTools(server, context, actor);

  // No sessionIdGenerator means stateless: no session to track, and no
  // server-initiated messages. enableJsonResponse returns one JSON body
  // instead of holding an event stream open.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

/** Whether the JSON-RPC body, single or batched, carries an initialize. */
async function isInitialize(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  try {
    const body: unknown = await request.clone().json();
    const messages = Array.isArray(body) ? body : [body];
    return messages.some(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as { method?: unknown }).method === "initialize",
    );
  } catch {
    return false;
  }
}

/**
 * Who is calling, for attributing writes (ADR-008 rule 4).
 *
 * In stateless mode the MCP client's name arrives only at initialize, never on
 * a tool call, so the user agent header is the best label available until
 * OAuth client registrations exist (ADR-007). REST callers are labelled the
 * same way; the CLI sends its own name (ADR-013 rule 3).
 */
export function agentActor(request: Request, surface: "mcp" | "api" = "mcp"): Actor {
  const userAgent = request.headers.get("user-agent")?.trim();
  return {
    kind: "agent",
    id: `${surface}:dev`,
    label: userAgent ? userAgent.slice(0, 120) : surface === "mcp" ? "MCP client" : "API client",
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  // Unauthenticated on purpose: it reveals nothing and answers "is it up".
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      server: SERVER_INFO,
      workspace: options.context.workspaceId,
      local_trust: trust.enabled,
      oauth: oauth ? { issuer: oauth.issuer, provider: oauth.providerName } : null,
      adapters: {
        store: options.context.store.constructor.name,
        search: options.context.search.constructor.name,
        vectors: options.context.search.capabilities.vectors,
        row_query_pushdown: options.context.store.capabilities.rowQueryPushdown,
      },
      // ADR-022: whether search can use meaning yet, and how much is left to embed.
      semantic_search: options.context.search.status(),
    }),
  );

  // Backing up is triggered by activity rather than by a timer, because a
  // timer never fires in a container that is scaled to zero (ADR-049). This is
  // the one place all three surfaces meet: REST, MCP and the console all
  // arrive here, and the CLI only ever reaches Cairn over HTTP (hard rule 15).
  //
  // A method that can change something is taken as a write. MCP sends reads as
  // POST too, so some of these changed nothing, and that is accepted: the
  // trigger is the age of the last backup, so an extra one costs a few
  // milliseconds and a file, while a missed one costs hours of work.
  if (options.onWrite) {
    const onWrite = options.onWrite;
    app.use("*", async (c, next) => {
      await next();
      if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return;
      // A request that failed changed nothing worth copying.
      if (c.res.status >= 400) return;
      onWrite();
    });
  }

  const trust = options.trust ?? NO_LOCAL_TRUST;

  const oauth = options.oauth ?? null;
  // Who each request is, set by the check below and read by the handlers.
  const callers = new WeakMap<Request, Caller>();
  const callerOf = (request: Request, surface: "mcp" | "api"): Caller =>
    callers.get(request) ?? { actor: agentActor(request, surface), via: "local", identity: null };

  // MCP and REST are both agent doors, so one check guards both (ADR-013).
  // In order: a trusted local request, the static service token, an OAuth
  // access token.
  const agentAuth: MiddlewareHandler = async (c, next) => {
    const surface = c.req.path.startsWith("/mcp") ? "mcp" : "api";
    if (trustedForMcp(c.req.raw, trust)) return next();
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (token !== "" && options.token !== null && timingSafeEqual(token, options.token)) {
      callers.set(c.req.raw, { actor: agentActor(c.req.raw, surface), via: "token", identity: null });
      return next();
    }
    if (token !== "" && oauth) {
      const verified = await oauth.verifyAccessToken(token);
      if (verified) {
        callers.set(c.req.raw, { actor: verified.actor, via: "oauth", identity: verified.identity });
        return next();
      }
    }
    if (oauth) {
      // RFC 9728: tell the client where to get a token (MCP authorization spec).
      const metadata = oauth.resourceMetadataUrl(surface === "mcp" ? "/mcp" : "/api/v1");
      c.header(
        "www-authenticate",
        `Bearer resource_metadata="${metadata}"${token !== "" ? ', error="invalid_token"' : ""}`,
      );
    }
    return c.json(
      {
        error: "unauthorized",
        message: oauth
          ? "Sign in: this server uses OAuth. MCP clients do it themselves; for the CLI run cairn login."
          : options.token === null
            ? "This server only accepts local requests, and this one is not trusted as local."
            : "Send the dev token as a Bearer token.",
      },
      401,
    );
  };
  app.use("/mcp", agentAuth);
  app.use("/api/*", agentAuth);

  if (oauth) {
    oauth.register(app, {
      secureCookies: options.publicOrigin?.startsWith("https:") ?? false,
      sessionCookie: SESSION_COOKIE,
    });
  }

  app.all("/mcp", (c) => handleMcpRequest(c.req.raw, options.context, callerOf(c.req.raw, "mcp").actor));
  app.route(
    "/api/v1",
    restRoutes(options.context, (request) => callerOf(request, "api"), {
      publicOrigin: options.publicOrigin ?? null,
      indexNowKey: options.indexNowKey ?? null,
      ...(options.indexNowFetch ? { indexNowFetch: options.indexNowFetch } : {}),
    }),
  );

  // The review console (ADR-009). Registered after MCP so its sign-in never
  // stands in front of the MCP bearer check.
  registerConsole(app, {
    context: options.context,
    token: options.token,
    trust,
    oauth,
    publicOrigin: options.publicOrigin ?? null,
    selfDescription: options.selfDescription ?? null,
    backupStatus: options.backupStatus ?? null,
    indexNowKey: options.indexNowKey ?? null,
    ...(options.indexNowFetch ? { indexNowFetch: options.indexNowFetch } : {}),
  });

  // The published wiki (ADR-032). Registered after the console so the console's
  // middleware still runs in front of it: that middleware skips sign-in for
  // these paths and adds the security headers they need.
  registerPublicWiki(app, {
    context: options.context,
    publicOrigin: options.publicOrigin ?? null,
    contentLicence: options.contentLicence ?? null,
    selfDescription: options.selfDescription ?? null,
    indexNowKey: options.indexNowKey ?? null,
  });

  return app;
}
