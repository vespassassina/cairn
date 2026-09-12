import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Actor } from "@cairn/core";
import type { AppContext } from "./context.js";
import { SERVER_INSTRUCTIONS } from "./mcp/instructions.js";
import { registerTools } from "./mcp/tools.js";
import { NO_LOCAL_TRUST, trustedForMcp, type LocalTrust } from "./trust.js";
import { registerConsole } from "./web/console.js";

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
}

const SERVER_INFO = { name: "cairn", version: "0.1.0" };

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
): Promise<Response> {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, context, agentActor(request));

  // No sessionIdGenerator means stateless: no session to track, and no
  // server-initiated messages. enableJsonResponse returns one JSON body
  // instead of holding an event stream open.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

/**
 * Who is calling, for attributing writes (ADR-008 rule 4).
 *
 * In stateless mode the MCP client's name arrives only at initialize, never on
 * a tool call, so the user agent header is the best label available until
 * OAuth client registrations exist (ADR-007).
 */
export function agentActor(request: Request): Actor {
  const userAgent = request.headers.get("user-agent")?.trim();
  return {
    kind: "agent",
    id: "mcp:dev",
    label: userAgent ? userAgent.slice(0, 120) : "MCP client",
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
      adapters: {
        store: options.context.store.constructor.name,
        search: options.context.search.constructor.name,
        vectors: options.context.search.capabilities.vectors,
        row_query_pushdown: options.context.store.capabilities.rowQueryPushdown,
      },
    }),
  );

  const trust = options.trust ?? NO_LOCAL_TRUST;

  app.use("/mcp", async (c, next) => {
    if (trustedForMcp(c.req.raw, trust)) return next();
    const header = c.req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (options.token === null || !timingSafeEqual(token, options.token)) {
      return c.json(
        {
          error: "unauthorized",
          message:
            options.token === null
              ? "This server only accepts local requests, and this one is not trusted as local."
              : "Send the dev token as a Bearer token.",
        },
        401,
      );
    }
    await next();
  });

  app.all("/mcp", (c) => handleMcpRequest(c.req.raw, options.context));

  // The review console (ADR-009). Registered after MCP so its sign-in never
  // stands in front of the MCP bearer check.
  registerConsole(app, { context: options.context, token: options.token, trust });

  return app;
}
