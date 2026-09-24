import { beforeEach, describe, expect, it } from "vitest";
import { createApp, createContext, OWNER, setApproval, type AppContext } from "@cairn/api";
import { eventually } from "@cairn/core/testing";
import { run, type Io } from "../src/main.js";

/**
 * `cairn approve`, `cairn disapprove` and `cairn unmark` end to end
 * (ADR-078 decision 2): a contract test with a realistic payload. The CLI
 * sends the mark as a person only when nothing says an agent is driving it,
 * and refuses outright when `CLAUDECODE` or `CAIRN_AGENT` is set.
 */

const CAIRN_BASE = "http://localhost:8787";

let context: AppContext;
let app: ReturnType<typeof createApp>;
let stdout: string;
let stderr: string;

function io(env: Record<string, string>): Io {
  return {
    fetch: async (request) => {
      if (request.url.startsWith(CAIRN_BASE)) return app.fetch(request);
      throw new Error(`unexpected request in test: ${request.url}`);
    },
    env: { CAIRN_CREDENTIALS: "/nonexistent/cairn-test/credentials.json", ...env },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: async () => null,
  };
}

async function cairn(env: Record<string, string>, ...argv: string[]): Promise<number> {
  stdout = "";
  stderr = "";
  return run(argv, io(env));
}

beforeEach(async () => {
  context = await createContext({ database: ":memory:", workspaceId: "ws" });
  app = createApp({ context, token: null, trust: { enabled: true, hosts: ["localhost"] } });
});

async function somePage(): Promise<{ id: string; version: string }> {
  await cairn({}, "create", "--title", "Build log", "--text", "Notes.", "--json");
  return JSON.parse(stdout) as { id: string; version: string };
}

describe("approve, disapprove, unmark", () => {
  it("marks a page from a person's shell and says so", async () => {
    const page = await somePage();
    expect(await cairn({}, "approve", page.id)).toBe(2);
    expect(stderr).toContain("--version");

    expect(await cairn({}, "approve", page.id, "--version", page.version, "--note", "Checked the dosages")).toBe(0);
    expect(stdout).toContain(`ok ${page.id} approved`);
    let stored = await context.pages.get(context.workspaceId, page.id);
    expect(stored.approval).toBe("approved");
    expect(stored.approvalVersion).toBe(page.version);
    const [latest] = await context.pages.history(context.workspaceId, page.id, { limit: 1 });
    expect(latest?.note).toBe("Marked approved: Checked the dosages");
    expect(latest?.actor.kind).toBe("user");

    expect(await cairn({}, "disapprove", page.id, "--version", stored.version)).toBe(0);
    expect(stdout).toContain(`ok ${page.id} disapproved`);
    stored = await context.pages.get(context.workspaceId, page.id);
    expect(stored.approval).toBe("disapproved");

    expect(await cairn({}, "unmark", page.id, "--version", stored.version)).toBe(0);
    expect(stdout).toContain(`ok ${page.id} neutral`);
    stored = await context.pages.get(context.workspaceId, page.id);
    expect(stored.approval).toBe("neutral");
  });

  it("refuses inside an agent session, before any request, and names the way out", async () => {
    const page = await somePage();
    for (const env of [{ CLAUDECODE: "1" }, { CAIRN_AGENT: "my-bot" }]) {
      expect(await cairn(env, "approve", page.id, "--version", page.version)).toBe(2);
      expect(stderr).toContain("person");
      expect(stderr).toContain("console");
      const stored = await context.pages.get(context.workspaceId, page.id);
      expect(stored.approval).toBe("neutral");
    }
  });

  it("prints the mark as JSON with --json", async () => {
    const page = await somePage();
    expect(await cairn({}, "approve", page.id, "--version", page.version, "--json")).toBe(0);
    const json = JSON.parse(stdout) as Record<string, unknown>;
    expect(json["approval"]).toBe("approved");
    expect(json["approval_version"]).toBe(page.version);
  });
});

describe("search and the mark", () => {
  it("orders approved first, hides disapproved unless --include-disapproved, and shows the mark", async () => {
    const body = "Zinc carnosine supports the gut lining after antibiotics.";
    const neutral = await context.pages.create(context.workspaceId, { title: "B", body, tags: [] }, { actor: OWNER }, "pg_n");
    const approved = await context.pages.create(context.workspaceId, { title: "A", body, tags: [] }, { actor: OWNER }, "pg_a");
    const bad = await context.pages.create(context.workspaceId, { title: "C", body, tags: [] }, { actor: OWNER }, "pg_d");
    await setApproval(context, approved.id, "approved", approved.version, { actor: OWNER });
    await setApproval(context, bad.id, "disapproved", bad.version, { actor: OWNER });

    await eventually(async () => {
      expect(await cairn({}, "search", "zinc", "carnosine", "gut", "--json")).toBe(0);
      const json = JSON.parse(stdout) as { pages: { page_id: string; approval: string }[] };
      expect(json.pages.map((p) => p.page_id)).toEqual([approved.id, neutral.id]);
      expect(json.pages[0]?.approval).toBe("approved");
    });

    expect(await cairn({}, "search", "zinc", "carnosine", "gut")).toBe(0);
    expect(stdout).toContain(`${approved.id}  [approved]`);
    expect(stdout).not.toContain(bad.id);

    expect(await cairn({}, "search", "zinc", "carnosine", "gut", "--include-disapproved")).toBe(0);
    expect(stdout).toContain(`${bad.id}  [disapproved]`);
  });
});
