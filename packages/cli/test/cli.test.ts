import { beforeEach, describe, expect, it } from "vitest";
import { createApp, createContext, OWNER, type AppContext } from "@cairn/api";
import { eventually } from "@cairn/core/testing";
import { readFileSync } from "node:fs";
import { run, VERSION, type Io } from "../src/main.js";

/**
 * The CLI against the real app, through an injected fetch (ADR-013 rule 5).
 * Same path as a real run, minus the socket.
 */

let context: AppContext;
let io: Io;
let stdout: string;
let stderr: string;
let stdin: string | null;
let seen: Request[];

beforeEach(async () => {
  context = await createContext({ database: ":memory:", workspaceId: "ws_test" });
  const app = createApp({ context, token: null, trust: { enabled: true, hosts: ["localhost"] } });
  stdout = "";
  stderr = "";
  stdin = null;
  seen = [];
  io = {
    fetch: async (request) => {
      seen.push(request.clone());
      return app.fetch(request);
    },
    env: { CLAUDECODE: "1" },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: async () => stdin,
  };
});

async function cairn(...argv: string[]): Promise<number> {
  stdout = "";
  stderr = "";
  return run(argv, io);
}

async function createLog(): Promise<{ id: string; version: string }> {
  stdin = "## Firmware\n\nOld firmware.\n\n## Motors\n\n2207 1750kv.";
  expect(await cairn("create", "--title", "5 inch build log", "--tag", "fpv", "--note", "From bench notes")).toBe(0);
  stdin = null;
  const match = /^ok (\S+) version (\S+)$/.exec(stdout.trim());
  expect(match).not.toBeNull();
  return { id: match![1]!, version: match![2]! };
}

describe("cairn", () => {
  it("prints help, and exits 2 on unknown commands or flags", async () => {
    expect(await cairn("--help")).toBe(0);
    expect(stdout).toContain("every change reviewable");
    expect(await cairn("frobnicate")).toBe(2);
    expect(stderr).toContain("unknown command");
    expect(await cairn("search", "--bogus")).toBe(2);
  });

  it("names itself and the agent in the user agent, so writes are attributed", async () => {
    const { id } = await createLog();
    expect(seen.at(-1)!.headers.get("user-agent")).toBe("cairn-cli/0.1.0 (claude-code)");
    const page = await context.pages.get(context.workspaceId, id);
    expect(page.updatedBy).toMatchObject({ kind: "agent", id: "api:dev", label: "cairn-cli/0.1.0 (claude-code)" });
  });

  it("creates, reads as Markdown, and searches", async () => {
    const { id, version } = await createLog();
    expect(await cairn("read", id)).toBe(0);
    expect(stdout).toContain(`version: ${version}`);
    expect(stdout).toContain("## Motors");

    await eventually(async () => {
      expect(await cairn("search", "firmware")).toBe(0);
      expect(stdout).toContain(id);
    });
    expect(await cairn("search", "zzzznotaword")).toBe(0);
    expect(stdout).toContain("no matches");
  });

  it("appends without a version, since appending never overwrites", async () => {
    const { id } = await createLog();
    stdin = "Props: 5.1 inch tri-blade.";
    expect(await cairn("append", id, "--note", "Added props")).toBe(0);
    const page = await context.pages.get(context.workspaceId, id);
    expect(page.body.endsWith("Props: 5.1 inch tri-blade.")).toBe(true);
  });

  it("requires a version to replace, and explains a conflict", async () => {
    const { id, version } = await createLog();
    expect(await cairn("replace-section", id, "--section", "Firmware", "--text", "BLHeli_32")).toBe(2);
    expect(stderr).toContain("--version");

    expect(
      await cairn("replace-section", id, "--section", "Firmware", "--version", version, "--text", "BLHeli_32"),
    ).toBe(0);
    expect(await cairn("write", id, "--version", version, "--text", "stale overwrite")).toBe(1);
    expect(stderr).toContain("version_conflict");
    expect(stderr).toContain("current version:");
    const page = await context.pages.get(context.workspaceId, id);
    expect(page.body).toContain("BLHeli_32");
    expect(page.body).toContain("2207 1750kv");
  });

  it("shows history, a revision diff, and the changes feed", async () => {
    const { id, version } = await createLog();
    await cairn("replace-section", id, "--section", "Firmware", "--version", version, "--text", "BLHeli_32", "--note", "Real firmware");
    const next = /version (\S+)/.exec(stdout)![1]!;

    expect(await cairn("history", id)).toBe(0);
    expect(stdout).toContain('"Real firmware"');
    expect(stdout).toContain("agent: cairn-cli/0.1.0 (claude-code)");

    expect(await cairn("revision", id, next)).toBe(0);
    expect(stdout).toContain("+ BLHeli_32");

    await eventually(async () => {
      expect(await cairn("changes", "--agents")).toBe(0);
      expect(stdout).toContain(`page ${id} "5 inch build log"`);
      expect(stdout).toContain("next time: --since");
    });
  });

  it("works with collections: create rows, query, and name bad fields", async () => {
    const collection = await context.collections.create(
      context.workspaceId,
      {
        name: "Prints",
        fields: [
          { name: "title", type: "text", required: true },
          { name: "grams", type: "number" },
          { name: "material", type: "select", options: ["PLA", "TPU"] },
        ],
      },
      { actor: { kind: "user", id: "owner", label: "Owner" }, note: null },
    );
    expect(await cairn("collections")).toBe(0);
    expect(stdout).toContain("Prints  (title:text*, grams:number, material:select)");

    expect(await cairn("upsert", collection.id, "--set", "title=Canopy", "--set", "grams=22", "--set", "material=TPU")).toBe(0);
    expect(await cairn("upsert", collection.id, "--set", "title=Mount", "--set", "grams=14", "--set", "material=PLA")).toBe(0);

    expect(await cairn("rows", collection.id, "--where", "grams gt 15")).toBe(0);
    expect(stdout).toContain('"title":"Canopy"');
    expect(stdout).not.toContain("Mount");

    expect(await cairn("upsert", collection.id, "--set", "grams=heavy")).toBe(1);
    expect(stderr).toContain("validation_failed");
    expect(stderr).toContain("title:");
    expect(stderr).toContain("grams:");
  });

  it("prints its version, which matches the package", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(await cairn("-V")).toBe(0);
    expect(stdout).toBe(`cairn ${VERSION}\n`);
    expect(await cairn("version")).toBe(0);
  });

  it("turns Windows line endings into plain newlines", async () => {
    stdin = "## Firmware\r\n\r\nWritten in Notepad.\r\n";
    expect(await cairn("create", "--title", "From Windows")).toBe(0);
    const id = /^ok (\S+)/.exec(stdout)![1]!;
    const page = await context.pages.get(context.workspaceId, id);
    expect(page.body).toBe("## Firmware\n\nWritten in Notepad.\n");
    expect(page.body).not.toContain("\r");
  });

  it("prints the raw response with --json", async () => {
    const { id } = await createLog();
    expect(await cairn("read", id, "--json")).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ id, title: "5 inch build log" });
  });

  it("says plainly when the server is not running", async () => {
    io.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await cairn("overview")).toBe(1);
    expect(stderr).toContain("cannot reach Cairn");
  });

  it("moves a collection under a page and shows a row's links (ADR-024)", async () => {
    const ws = context.workspaceId;
    const home = await context.pages.create(ws, { title: "Peptides", body: "Hub." }, { actor: OWNER });
    const peptides = await context.collections.create(ws, { name: "Peptides", fields: [{ name: "name", type: "text", required: true }] }, { actor: OWNER }, "col_peptides");
    await context.collections.create(
      ws,
      { name: "Stacks", fields: [{ name: "title", type: "text", required: true }, { name: "components", type: "relation", target: "col_peptides", multiple: true }] },
      { actor: OWNER },
      "col_stacks",
    );
    await context.collections.upsertRow(ws, "col_peptides", { values: { name: "BPC-157" } }, { actor: OWNER }, { id: "row_bpc" });
    expect(await cairn("upsert", "col_stacks", "--id", "row_wolverine", "--set", "title=Wolverine", "--set", 'components=["row_bpc"]', "--note", "The healing stack")).toBe(0);

    expect(await cairn("move", "col_peptides", "--parent", home.id, "--version", peptides.version, "--note", "Group the tables")).toBe(0);
    expect(stdout).toContain(`ok collection col_peptides now under ${home.id}`);
    expect(await cairn("collections")).toBe(0);
    expect(stdout).toContain(`under ${home.id}`);
    expect(stdout).toContain("components:relation->col_peptides[]");

    expect(await cairn("links", "col_peptides/row_bpc")).toBe(0);
    expect(stdout).toContain("col_stacks/row_wolverine  relation components");
  });
});
