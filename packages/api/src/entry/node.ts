import type { Server } from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import { createApp } from "../app.js";
import { ConfigError, loadConfig } from "../config.js";
import { createContext } from "../context.js";

/**
 * The Node entry point. The only file that knows about a listening socket.
 * Lambda and Azure Functions get their own file beside this one, and neither
 * touches a route (ADR-006).
 */

/**
 * The addresses to listen on. `localhost` resolves to 127.0.0.1 or ::1
 * depending on the client, so the default binds both. Only the first is
 * required; the IPv6 one is skipped where the machine has no IPv6 loopback.
 */
export function listenAddresses(host: string): string[] {
  return host === "127.0.0.1" || host === "localhost" ? ["127.0.0.1", "::1"] : [host];
}

function listen(server: Server, port: number, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, address, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const context = await createContext(config);
  const app = createApp({
    context,
    token: config.token,
    trust: { enabled: config.trustLocal, hosts: config.localHosts },
  });

  const [primary, ...optional] = listenAddresses(config.host);
  try {
    await listen(createAdaptorServer({ fetch: app.fetch }) as Server, config.port, primary!);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      process.stderr.write(
        `port ${config.port} is already in use.\n` +
          `  Cairn may already be running: open http://localhost:${config.port}/health\n` +
          `  or stop the other process: lsof -nP -iTCP:${config.port} -sTCP:LISTEN\n` +
          `  or pick another port with "port" in cairn.config.json or CAIRN_PORT.\n`,
      );
      process.exit(1);
    }
    throw error;
  }
  const bound = [primary!];
  for (const address of optional) {
    try {
      await listen(createAdaptorServer({ fetch: app.fetch }) as Server, config.port, address);
      bound.push(address);
    } catch {
      // No IPv6 loopback, or something else holds it. 127.0.0.1 still serves.
    }
  }

  const auth = config.trustLocal
    ? `no sign-in for ${config.localHosts.join(", ")}` +
      (config.token ? "; token for any other host name" : "")
    : "token required";
  process.stdout.write(
    `cairn listening on http://localhost:${config.port}\n` +
      `  console   http://localhost:${config.port}/\n` +
      `  mcp       http://localhost:${config.port}/mcp\n` +
      `  bound     ${bound.join(", ")}\n` +
      `  auth      ${auth}\n` +
      `  database  ${config.database}\n` +
      `  workspace ${config.workspaceId}\n` +
      `  config    ${config.configFile ?? "none (defaults)"}\n`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`configuration error: ${error.message}\n`);
    process.exit(2);
  }
  throw error;
});
