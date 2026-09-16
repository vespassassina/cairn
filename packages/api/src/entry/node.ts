import type { Server } from "node:http";
import { createAdaptorServer } from "@hono/node-server";
import { canSnapshot } from "@cairn/core";
import { createApp } from "../app.js";
import { ConfigError, loadConfig } from "../config.js";
import { closeContext, createContext } from "../context.js";
import { oauthFromConfig } from "../oauth/setup.js";
import { BackupEngine } from "../backup/engine.js";
import { openArchive } from "../backup/open.js";
import { installShutdown } from "./shutdown.js";

/**
 * The Node entry point. The only file that knows about a listening socket
 * (ADR-006). Cairn runs as one container on Node everywhere (ADR-020).
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
  const oauth = oauthFromConfig(config, context);

  // Backups are a capability of the store rather than something every adapter
  // must answer for (ADR-049), so this is a check rather than an assumption.
  const backups =
    config.backups.to !== null && canSnapshot(context.store)
      ? new BackupEngine({
          source: context.store,
          archive: openArchive(config.backups.to, {
            ...(config.backups.region === null ? {} : { region: config.backups.region }),
            ...(config.backups.endpoint === null ? {} : { endpoint: config.backups.endpoint }),
          }),
          policy: {
            afterMs: config.backups.afterHours * 60 * 60 * 1000,
            keepMs: config.backups.keepDays * 24 * 60 * 60 * 1000,
            keepAtLeast: config.backups.keepAtLeast,
          },
          log: (line) => process.stdout.write(`cairn: ${line}\n`),
        })
      : null;
  if (backups) {
    await backups.start();
    // A replica URL means the database is being streamed off this machine,
    // which means this machine's disk is not expected to outlive the
    // container, and that object storage is already reachable. Backups left on
    // the local disk would be lost exactly when they are needed, so say so
    // rather than let them look like protection (ADR-050).
    const local = !/^[a-z][a-z0-9+.-]*:\/\//i.test(config.backups.to!);
    if (local && process.env["CAIRN_REPLICA_URL"]) {
      process.stdout.write(
        `cairn: warning: backups are going to ${config.backups.to}, a folder on this machine, ` +
          "but CAIRN_REPLICA_URL is set, which usually means this disk does not outlive the container. " +
          "If so these backups are lost when it stops. Point CAIRN_BACKUP_TO at object storage " +
          "(abs://<account>@<container>/<prefix> or s3://<bucket>/<prefix>), or at a mounted volume that survives.\n",
      );
    }
  }

  const app = createApp({
    context,
    token: config.token,
    trust: { enabled: config.trustLocal, hosts: config.localHosts },
    oauth,
    publicOrigin: config.oauth ? new URL(config.oauth.publicUrl).origin : null,
    contentLicence: config.contentLicence,
    selfDescription: config.selfDescription,
    backupStatus: () => backups?.lastBackupAt() ?? null,
    ...(backups ? { onWrite: () => backups.afterWrite() } : {}),
  });

  const servers: Server[] = [];
  const [primary, ...optional] = listenAddresses(config.host);
  try {
    const server = createAdaptorServer({ fetch: app.fetch }) as Server;
    await listen(server, config.port, primary!);
    servers.push(server);
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
      const server = createAdaptorServer({ fetch: app.fetch }) as Server;
      await listen(server, config.port, address);
      servers.push(server);
      bound.push(address);
    } catch {
      // No IPv6 loopback, or something else holds it. 127.0.0.1 still serves.
    }
  }

  // Stopping tidily matters most where the database is replicated: a process
  // killed mid-write leaves Litestream shipping an unfinished transaction
  // (ADR-046, docs/LESSONS.md).
  installShutdown({
    servers,
    steps: [
      // Before the close, because a backup of a closed database is not
      // possible, and because the last few hours of work are exactly what a
      // sudden stop would otherwise cost (ADR-049).
      ...(backups
        ? [{ name: "backed up", run: async () => void (await backups.backupNow("shutting down")) }]
        : []),
      {
        name: "closed the database",
        // SQLite checkpoints the WAL and removes it when the last connection
        // closes, so this is what leaves the replica a finished file.
        run: () => closeContext(context),
      },
    ],
    budgetMs: config.shutdownSeconds * 1000,
    log: (line) => process.stdout.write(`cairn: ${line}\n`),
    exit: (code) => process.exit(code),
  });

  const auth = [
    config.trustLocal ? `no sign-in for ${config.localHosts.join(", ")}` : null,
    config.oauth ? `OAuth via ${oauth!.providerName} for ${config.oauth.allowedUsers.join(", ")}` : null,
    config.token ? "service token accepted" : null,
  ]
    .filter((part) => part !== null)
    .join("; ");
  const base = config.oauth ? config.oauth.publicUrl : `http://localhost:${config.port}`;
  process.stdout.write(
    `cairn listening on port ${config.port}\n` +
      `  console   ${base}/\n` +
      `  mcp       ${base}/mcp\n` +
      `  bound     ${bound.join(", ")}\n` +
      `  auth      ${auth}\n` +
      `  database  ${config.database}\n` +
      `  workspace ${config.workspaceId}\n` +
      `  search    ${
        config.embeddings.provider === "local"
          ? `keyword, plus meaning for English text once the model loads (${config.embeddings.modelDir})`
          : "keyword only (CAIRN_EMBEDDINGS=off)"
      }\n` +
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
