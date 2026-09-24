import { beforeEach, describe, expect, it } from "vitest";
import { createApp, createContext, type AppContext } from "@cairn/api";
import { run, type Io } from "../src/main.js";

/**
 * `cairn synonyms list/add/remove` end to end (ADR-077): a contract test
 * with a realistic payload, per "Verification before calling a task done"
 * item 3.
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

async function collectionId(): Promise<string> {
  await cairn("create", "--title", "Peptides", "--text", "Root.", "--json");
  return (JSON.parse(stdout) as { id: string }).id;
}

describe("synonyms", () => {
  it("adds, lists and removes a pair", async () => {
    const id = await collectionId();

    expect(await cairn("synonyms", "list", id)).toBe(0);
    expect(stdout).toContain(`no synonyms for ${id}`);

    const added = await cairn("synonyms", "add", id, "GLP-1", "glucagon-like peptide 1", "--note", "Common abbreviation");
    expect(added).toBe(0);
    expect(stdout).toContain('"glp-1" = "glucagon-like peptide 1"');

    expect(await cairn("synonyms", "list", id, "--json")).toBe(0);
    const listed = JSON.parse(stdout) as { synonyms: Array<Record<string, unknown>> };
    expect(listed.synonyms).toHaveLength(1);
    expect(listed.synonyms[0]).toMatchObject({ term: "glp-1", synonym: "glucagon-like peptide 1" });

    const removed = await cairn("synonyms", "remove", id, "GLP-1", "glucagon-like peptide 1");
    expect(removed).toBe(0);
    expect(stdout).toContain("removed");

    expect(await cairn("synonyms", "list", id)).toBe(0);
    expect(stdout).toContain(`no synonyms for ${id}`);
  });

  it("says how to use it when no subcommand is given", async () => {
    const code = await cairn("synonyms");
    expect(code).not.toBe(0);
    expect(stderr).toContain("cairn synonyms needs a subcommand");
  });
});
