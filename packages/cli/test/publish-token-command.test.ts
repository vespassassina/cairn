import { beforeEach, describe, expect, it } from "vitest";
import { createApp, createContext, type AppContext } from "@cairn/api";
import { run, type Io } from "../src/main.js";

/**
 * `cairn publish-token create/list/revoke` end to end (ADR-066): a contract
 * test with a realistic payload, per "Verification before calling a task
 * done" item 3.
 */

const CAIRN_BASE = "http://localhost:8787";

let context: AppContext;
let app: ReturnType<typeof createApp>;
let stdout: string;
let stderr: string;

function io(): Io {
  return {
    fetch: async (request) => {
      if (request.url.startsWith(CAIRN_BASE)) return app.fetch(request);
      throw new Error(`unexpected request in test: ${request.url}`);
    },
    env: { CAIRN_CREDENTIALS: "/nonexistent/cairn-test/credentials.json" },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: async () => null,
  };
}

async function cairn(...argv: string[]): Promise<number> {
  stdout = "";
  stderr = "";
  return run(argv, io());
}

beforeEach(async () => {
  context = await createContext({ database: ":memory:", workspaceId: "ws" });
  const trust = { enabled: true, hosts: ["localhost"] };
  app = createApp({ context, token: null, trust });
});

async function publishedPage(): Promise<string> {
  await cairn("create", "--title", "Build log", "--text", "Notes.", "--json");
  const page = JSON.parse(stdout) as { id: string; version: string };
  const code = await cairn("publish", page.id, "--version", page.version);
  expect(code).toBe(0);
  return page.id;
}

describe("publish-token", () => {
  it("creates a token, shows it once, and it is not in the list that follows", async () => {
    const pageId = await publishedPage();

    const created = await cairn("publish-token", "create", pageId, "--name", "accountant", "--description", "for the books", "--json");
    expect(created).toBe(0);
    const row = JSON.parse(stdout) as { id: string; token: string; name: string };
    expect(row.token).toBeTruthy();
    expect(row.name).toBe("accountant");

    const listed = await cairn("publish-token", "list", pageId, "--json");
    expect(listed).toBe(0);
    const list = JSON.parse(stdout) as { tokens: Array<Record<string, unknown>> };
    expect(list.tokens).toHaveLength(1);
    expect(list.tokens[0]!["name"]).toBe("accountant");
    expect(list.tokens[0]!["token"]).toBeUndefined();
    expect(JSON.stringify(list.tokens[0])).not.toContain(row.token);
  });

  it("prints the raw token and the shareable link in plain text, once", async () => {
    const pageId = await publishedPage();
    const code = await cairn("publish-token", "create", pageId, "--name", "accountant");
    expect(code).toBe(0);
    expect(stdout).toContain('token "accountant" created');
    expect(stdout).toContain("shown once, not stored");
    expect(stdout).toContain(`/w/${pageId}?token=`);
  });

  it("revokes a token, and it stops appearing as active", async () => {
    const pageId = await publishedPage();
    await cairn("publish-token", "create", pageId, "--name", "accountant", "--json");
    const created = JSON.parse(stdout) as { id: string };

    const revoked = await cairn("publish-token", "revoke", created.id);
    expect(revoked).toBe(0);
    expect(stdout).toContain(`ok token ${created.id} revoked`);

    await cairn("publish-token", "list", pageId, "--json");
    const list = JSON.parse(stdout) as { tokens: Array<Record<string, unknown>> };
    expect(list.tokens[0]!["revoked_at"]).not.toBeNull();
  });

  it("says how to use it when no subcommand is given", async () => {
    const code = await cairn("publish-token");
    expect(code).not.toBe(0);
    expect(stderr).toContain("cairn publish-token needs a subcommand");
  });
});
