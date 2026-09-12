import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/app.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { createContext, OWNER, type AppContext } from "../src/context.js";

/**
 * Local trust (ADR-010). No token on localhost, but not for a request that
 * merely reached localhost: the Host must be a trusted local name, and MCP
 * refuses anything a foreign web page sent.
 */

const LOCAL = { enabled: true, hosts: ["localhost", "127.0.0.1", "::1", "cairn.local"] };

let app: Hono;
let context: AppContext;

function mcp(host: string, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request(`http://${host}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
}

beforeEach(async () => {
  context = await createContext({
    database: ":memory:",
    host: "127.0.0.1",
    port: 0,
    token: null,
    workspaceId: "ws_trust",
    trustLocal: true,
    localHosts: LOCAL.hosts,
    configFile: null,
  });
  app = createApp({ context, token: null, trust: LOCAL });
});

describe("console on a trusted local host", () => {
  it("opens without sign-in on localhost", async () => {
    const response = await app.fetch(new Request("http://localhost:8787/pages"));
    expect(response.status).toBe(200);
  });

  it("opens without sign-in on 127.0.0.1, ::1 and a configured name", async () => {
    for (const host of ["127.0.0.1:8787", "[::1]:8787", "cairn.local:8787"]) {
      const response = await app.fetch(new Request(`http://${host}/`));
      expect(response.status, host).toBe(200);
    }
  });

  it("skips the sign-in page entirely", async () => {
    const response = await app.fetch(new Request("http://localhost:8787/login?next=%2Fc"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/c");
  });

  it("still refuses a form post from another origin", async () => {
    const page = await context.pages.create(context.workspaceId, { title: "P", body: "x" }, {
      actor: OWNER,
    });
    const response = await app.fetch(
      new Request(`http://localhost:8787/p/${page.id}/edit`, {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ title: "P", body: "defaced", version: page.version }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it("accepts a form post from the console itself, attributed to the owner", async () => {
    const page = await context.pages.create(context.workspaceId, { title: "P", body: "x" }, {
      actor: OWNER,
    });
    const response = await app.fetch(
      new Request(`http://localhost:8787/p/${page.id}/edit`, {
        method: "POST",
        headers: {
          origin: "http://localhost:8787",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ title: "P", body: "edited", version: page.version }),
      }),
    );
    expect(response.status).toBe(303);
    const saved = await context.pages.get(context.workspaceId, page.id);
    expect(saved.body).toBe("edited");
    expect(saved.updatedBy.kind).toBe("user");
  });

  it("sends a rebinding attacker's host to sign-in, which it cannot pass", async () => {
    // evil.example resolved to 127.0.0.1: the connection is local, the Host is not.
    const response = await app.fetch(new Request("http://evil.example:8787/pages"));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/login");

    const login = await app.fetch(
      new Request("http://evil.example:8787/login", {
        method: "POST",
        headers: {
          origin: "http://evil.example:8787",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token: "anything-at-all-000000" }),
      }),
    );
    expect(login.status).toBe(400);
  });
});

describe("MCP on a trusted local host", () => {
  it("answers Claude Code with no token and no Origin", async () => {
    const response = await mcp("localhost:8787", { "user-agent": "claude-code/2.1.4" });
    expect(response.status).toBe(200);
  });

  it("refuses a request a foreign web page sent to localhost", async () => {
    const response = await mcp("localhost:8787", { origin: "https://evil.example" });
    expect(response.status).toBe(401);
  });

  it("refuses a rebinding attacker's host", async () => {
    const response = await mcp("evil.example:8787");
    expect(response.status).toBe(401);
  });

  it("still attributes local writes to the calling agent", async () => {
    const response = await app.fetch(
      new Request("http://localhost:8787/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "user-agent": "claude-code/2.1.4",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "create_page", arguments: { title: "From Claude", body: "hi" } },
        }),
      }),
    );
    const body = (await response.json()) as { result: { content: Array<{ text: string }> } };
    const page = JSON.parse(body.result.content[0]!.text) as { updated_by: { kind: string } };
    expect(page.updated_by.kind).toBe("agent");
  });
});

describe("with local trust off", () => {
  it("requires the token even on localhost", async () => {
    const strict = createApp({
      context,
      token: "strict-token-0123456789",
      trust: { enabled: false, hosts: LOCAL.hosts },
    });
    const console = await strict.fetch(new Request("http://localhost:8787/pages"));
    expect(console.status).toBe(302);
    const tools = await strict.fetch(
      new Request("http://localhost:8787/mcp", { method: "POST", body: "{}" }),
    );
    expect(tools.status).toBe(401);
  });
});

describe("configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "cairn-config-"));

  it("trusts local by default and needs no token", () => {
    const config = loadConfig({}, null);
    expect(config.trustLocal).toBe(true);
    expect(config.token).toBeNull();
    expect(config.localHosts).toEqual(["localhost", "127.0.0.1", "::1"]);
  });

  it("adds host names from the config file and resolves the database next to it", () => {
    const path = join(dir, "cairn.config.json");
    writeFileSync(
      path,
      JSON.stringify({ database: "data/notes.sqlite", auth: { localHosts: ["Cairn.Local"] } }),
    );
    const config = loadConfig({}, path);
    expect(config.localHosts).toContain("cairn.local");
    expect(config.database).toBe(join(dir, "data", "notes.sqlite"));
    expect(config.configFile).toBe(path);
  });

  it("insists on a token when local trust is off", () => {
    expect(() => loadConfig({ CAIRN_TRUST_LOCAL: "false" }, null)).toThrow(ConfigError);
    expect(loadConfig({ CAIRN_TRUST_LOCAL: "0", CAIRN_TOKEN: "x".repeat(16) }, null).trustLocal).toBe(
      false,
    );
  });

  it("refuses to listen beyond loopback without OAuth", () => {
    expect(() => loadConfig({ CAIRN_HOST: "0.0.0.0" }, null)).toThrow(/without OAuth/);
  });
});

describe("public mode with OAuth (ADR-017)", () => {
  const OAUTH = {
    CAIRN_HOST: "0.0.0.0",
    CAIRN_PUBLIC_URL: "https://cairn.example.com/",
    CAIRN_AUTH_PROVIDER: "github",
    CAIRN_AUTH_SECRET: "s".repeat(32),
    CAIRN_OAUTH_CLIENT_ID: "Iv1.abc",
    CAIRN_OAUTH_CLIENT_SECRET: "shh",
    CAIRN_ALLOWED_USERS: "github:Vespassassina, email:me@example.com",
  };

  it("listens publicly with OAuth, and turns local trust off whatever the settings say", () => {
    const config = loadConfig({ ...OAUTH, CAIRN_TRUST_LOCAL: "1" }, null);
    expect(config.host).toBe("0.0.0.0");
    expect(config.trustLocal).toBe(false);
    expect(config.oauth).toMatchObject({
      publicUrl: "https://cairn.example.com",
      provider: { kind: "github", clientId: "Iv1.abc" },
      allowedUsers: ["github:vespassassina", "email:me@example.com"],
    });
  });

  it("names everything missing from a partial OAuth setup", () => {
    expect(() => loadConfig({ CAIRN_PUBLIC_URL: "https://cairn.example.com" }, null)).toThrow(
      /CAIRN_AUTH_PROVIDER.*CAIRN_AUTH_SECRET.*CAIRN_OAUTH_CLIENT_ID.*CAIRN_OAUTH_CLIENT_SECRET.*CAIRN_ALLOWED_USERS/,
    );
  });

  it("refuses a short secret, a plain http public URL, and a malformed allowlist", () => {
    expect(() => loadConfig({ ...OAUTH, CAIRN_AUTH_SECRET: "short" }, null)).toThrow(/at least 32/);
    expect(() => loadConfig({ ...OAUTH, CAIRN_PUBLIC_URL: "http://cairn.example.com" }, null)).toThrow(/must be https/);
    expect(() => loadConfig({ ...OAUTH, CAIRN_ALLOWED_USERS: "vespassassina" }, null)).toThrow(/github:yourlogin/);
    expect(() => loadConfig({ ...OAUTH, CAIRN_TOKEN: "x".repeat(20) }, null)).toThrow(/at least 32/);
  });

  it("allows http://localhost as the public URL for trying OAuth on one machine", () => {
    const config = loadConfig({ ...OAUTH, CAIRN_HOST: "127.0.0.1", CAIRN_PUBLIC_URL: "http://localhost:8787" }, null);
    expect(config.oauth?.publicUrl).toBe("http://localhost:8787");
  });

  it("keeps secrets out of the config file: only the environment sets them", () => {
    const path = join(mkdtempSync(join(tmpdir(), "cairn-oauth-")), "cairn.config.json");
    writeFileSync(
      path,
      JSON.stringify({
        auth: {
          oauth: {
            publicUrl: "https://cairn.example.com",
            provider: "github",
            allowedUsers: ["github:owner"],
            clientSecret: "written-in-the-file-by-mistake",
          },
        },
      }),
    );
    expect(() => loadConfig({ CAIRN_OAUTH_CLIENT_ID: "Iv1.abc" }, path)).toThrow(
      /CAIRN_AUTH_SECRET, CAIRN_OAUTH_CLIENT_SECRET/,
    );
  });
});
