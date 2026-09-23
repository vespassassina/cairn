import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createApp, createContext, type AppContext } from "@cairn/api";
import { run, type Io } from "../src/main.js";

/**
 * `cairn attachment create/list/get` end to end (ADR-064): a contract test
 * with a realistic payload, per "Verification before calling a task done"
 * item 3. Uses a fake in-memory blob store (attachments-blob.test.ts and
 * attachments.test.ts already cover the real S3/Azure signing), so the
 * "upload_url" this test's server hands back is just another CAIRN_BASE
 * path that io.fetch can serve, standing in for the direct-to-blob PUT a
 * real deployment would make.
 */

const CAIRN_BASE = "http://localhost:8787";

let context: AppContext;
let app: ReturnType<typeof createApp>;
let stdout: string;
let stderr: string;
let dir: string;

/** In-memory blob store, reachable at CAIRN_BASE/_blob/<key> for the test's io.fetch to serve. */
function fakeStore() {
  const held = new Map<string, Buffer>();
  return {
    store: {
      async head(key: string) {
        const found = held.get(key);
        return found ? { bytes: found.length } : null;
      },
      async uploadUrl(key: string) {
        return `${CAIRN_BASE}/_blob/${key}`;
      },
      async downloadUrl(key: string, _expires: number, filename: string) {
        return `${CAIRN_BASE}/_blob/${key}?filename=${encodeURIComponent(filename)}`;
      },
    },
    held,
  };
}

let blob: ReturnType<typeof fakeStore>;

function io(): Io {
  return {
    fetch: async (request) => {
      if (request.method === "PUT" && request.url.includes("/_blob/")) {
        const key = new URL(request.url).pathname.replace("/_blob/", "");
        const body = Buffer.from(await request.arrayBuffer());
        blob.held.set(key, body);
        return new Response(null, { status: 200 });
      }
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
  blob = fakeStore();
  context.attachmentsStore = blob.store;
  app = createApp({ context, token: null, trust: { enabled: true, hosts: ["localhost"] } });
  dir = await mkdtemp(join(tmpdir(), "cairn-attachment-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("attachment", () => {
  it("uploads a file, confirms it, and prints an attachment: link to paste into the page", async () => {
    await cairn("create", "--title", "Print log", "--text", "Notes.", "--json");
    const page = JSON.parse(stdout) as { id: string };

    const path = join(dir, "photo.png");
    await writeFile(path, Buffer.from("fake png bytes"));

    const code = await cairn("attachment", "create", page.id, "--file", path, "--alt", "the print bed", "--note", "attached a photo");
    expect(code).toBe(0);
    expect(stdout).toContain("ok uploaded photo.png");
    expect(stdout).toContain("](attachment:");
    expect(stdout).toContain("![the print bed](attachment:");

    const idMatch = /attachment id (\S+)/.exec(stdout);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1]!;

    const listed = await cairn("attachment", "list", page.id, "--json");
    expect(listed).toBe(0);
    const list = JSON.parse(stdout) as { attachments: Array<Record<string, unknown>> };
    expect(list.attachments).toHaveLength(1);
    expect(list.attachments[0]!["filename"]).toBe("photo.png");

    const got = await cairn("attachment", "get", id);
    expect(got).toBe(0);
    expect(stdout).toContain("http");
  });

  it("says how to use it when no subcommand is given", async () => {
    const code = await cairn("attachment");
    expect(code).not.toBe(0);
    expect(stderr).toContain("cairn attachment needs a subcommand");
  });
});
