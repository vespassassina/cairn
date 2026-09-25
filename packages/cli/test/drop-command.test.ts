import { beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, createContext, type AppContext } from "@cairn/api";
import { run, type Io } from "../src/main.js";

/**
 * `cairn drop`, `cairn drops` and `cairn drop-token` end to end (ADR-079,
 * criterion 6): a contract test with a realistic payload, through the real
 * REST routes and a fake blob store.
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

function fakeStore() {
  const blobs = new Map<string, Uint8Array>();
  return {
    async head(key: string) {
      const found = blobs.get(key);
      return found === undefined ? null : { bytes: found.length };
    },
    async uploadUrl(key: string) {
      return `https://blob.example/${key}?upload`;
    },
    async downloadUrl(key: string) {
      return `https://blob.example/${key}?download`;
    },
    async put(key: string, bytes: Uint8Array) {
      blobs.set(key, bytes);
    },
    async get(key: string) {
      return blobs.get(key) ?? null;
    },
  };
}

beforeEach(async () => {
  context = await createContext({ database: ":memory:", workspaceId: "ws" });
  const trust = { enabled: true, hosts: ["localhost"] };
  app = createApp({ context, token: null, trust });
});

describe("drop and drops", () => {
  it("round-trips a text drop: dropped under the Inbox, listed by cairn drops, newest first", async () => {
    expect(await cairn("drop", "call Anna re: NAS", "--tag", "todo", "--url", "https://example.com/nas", "--note", "from the shell")).toBe(0);
    expect(stdout).toContain('ok dropped "call Anna re: NAS"');
    expect(stdout).toContain("/p/pg_");

    expect(await cairn("drop", "--text", "second thought", "--json")).toBe(0);
    const second = JSON.parse(stdout) as { id: string; tags: string[]; title: string };
    expect(second.tags).toEqual(["drop"]);

    expect(await cairn("drops")).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines[0]).toContain(second.id);
    expect(lines[0]).toContain("second thought");
    expect(lines[1]).toContain("call Anna re: NAS");
    expect(lines[2]).toContain("2 waiting");

    expect(await cairn("drops", "--json")).toBe(0);
    const listed = JSON.parse(stdout) as { drops: Array<{ id: string; tags: string[]; sources: string[] }> };
    expect(listed.drops[1]!.tags).toEqual(["todo", "drop"]);
    expect(listed.drops[1]!.sources).toEqual(["https://example.com/nas"]);
  });

  it("says what is missing when there is nothing to drop", async () => {
    expect(await cairn("drop")).toBe(2);
    expect(stderr).toContain("nothing to drop");
    expect(stderr).toContain("--file PATH");
  });

  it("uploads a 25 MB file and refuses a 26 MB one with the limit in the message (criterion 6)", async () => {
    context.attachmentsStore = fakeStore();
    const dir = await mkdtemp(join(tmpdir(), "cairn-drop-"));
    const ok = join(dir, "backup.bin");
    const big = join(dir, "too-big.bin");
    await writeFile(ok, new Uint8Array(25 * 1024 * 1024));
    await writeFile(big, new Uint8Array(26 * 1024 * 1024));

    expect(await cairn("drop", "the backup", "--file", ok, "--json")).toBe(0);
    const page = JSON.parse(stdout) as { id: string };
    const attachments = await app.fetch(new Request(`${CAIRN_BASE}/api/v1/attachments?page=${page.id}`));
    const rows = (await attachments.json()) as { attachments: Array<{ filename: string; bytes: number }> };
    expect(rows.attachments).toEqual([expect.objectContaining({ filename: "backup.bin", bytes: 25 * 1024 * 1024 })]);

    expect(await cairn("drop", "--file", big)).toBe(1);
    expect(stderr).toContain("drop_too_large");
    expect(stderr).toContain("25 MB");
    expect(stderr).toContain("too-big.bin");
  }, 30_000);

  it("names the setting when files are dropped with attachments off", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-drop-"));
    const path = join(dir, "note.txt");
    await writeFile(path, "hello");
    expect(await cairn("drop", "--file", path)).toBe(1);
    expect(stderr).toContain("attachments_off");
    expect(stderr).toContain("CAIRN_ATTACHMENTS_TO");
  });
});

describe("drop-token", () => {
  it("creates a token shown once, lists it without the value, and a drop with it is written as the token", async () => {
    expect(await cairn("drop-token", "create", "phone", "--description", "share sheet", "--note", "new phone")).toBe(0);
    const token = /cairn_drop_[A-Za-z0-9_-]+/.exec(stdout)?.[0];
    expect(token).toBeDefined();
    expect(stdout).toContain("shown once");
    expect(stdout).toContain("kind person because --kind was not given");

    expect(await cairn("drop-token", "list")).toBe(0);
    expect(stdout).toContain("phone");
    expect(stdout).toContain("person");
    expect(stdout).toContain("last used never");
    expect(stdout).not.toContain(token!);

    // The token drops, and the page says it came from the phone. Through an
    // app without local trust, since a trusted localhost caller is the owner
    // whatever token it carries.
    const strict = createApp({ context, token: "service-token", trust: { enabled: false, hosts: [] } });
    const dropped = await strict.fetch(
      new Request(`${CAIRN_BASE}/api/v1/drops`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: "from the phone" }),
      }),
    );
    expect(dropped.status).toBe(201);
    const page = (await dropped.json()) as { updated_by: { kind: string; name: string } };
    expect(page.updated_by).toEqual({ kind: "user", name: 'token "phone"' });

    expect(await cairn("drop-token", "list", "--json")).toBe(0);
    const list = JSON.parse(stdout) as { tokens: Array<{ id: string; last_used_at: string | null }> };
    expect(list.tokens[0]!.last_used_at).not.toBeNull();

    expect(await cairn("drop-token", "revoke", list.tokens[0]!.id, "--note", "lost the phone")).toBe(0);
    expect(stdout).toContain("revoked");
    expect(await cairn("drop-token", "list")).toBe(0);
    expect(stdout).toContain("(revoked)");
  });

  it("creates an agent token with --kind agent and refuses another kind", async () => {
    expect(await cairn("drop-token", "create", "cron", "--kind", "agent", "--json")).toBe(0);
    expect((JSON.parse(stdout) as { kind: string }).kind).toBe("agent");
    expect(await cairn("drop-token", "create", "x", "--kind", "robot")).toBe(2);
    expect(stderr).toContain("person or agent");
  });
});
