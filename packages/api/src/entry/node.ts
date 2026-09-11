import { serve } from "@hono/node-server";
import { createApp } from "../app.js";
import { ConfigError, loadConfig } from "../config.js";
import { createContext } from "../context.js";

/**
 * The Node entry point. The only file that knows about a listening socket.
 * Lambda and Azure Functions get their own file beside this one, and neither
 * touches a route (ADR-006).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const context = await createContext(config);
  const app = createApp({ context, token: config.token });

  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    process.stdout.write(
      `cairn listening on http://${config.host}:${info.port}\n` +
        `  database  ${config.database}\n` +
        `  workspace ${config.workspaceId}\n` +
        `  mcp       http://${config.host}:${info.port}/mcp (bearer token required)\n`,
    );
  });
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`configuration error: ${error.message}\n`);
    process.exit(2);
  }
  throw error;
});
