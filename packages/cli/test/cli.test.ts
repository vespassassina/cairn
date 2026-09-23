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
    // A config folder that does not exist, so the owner's own instances and
    // sign-ins never reach a test.
    env: { CLAUDECODE: "1", CAIRN_CREDENTIALS: "/nonexistent/cairn-test/credentials.json" },
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
    expect(seen.at(-1)!.headers.get("user-agent")).toBe(`cairn-cli/${VERSION} (claude-code)`);
    const page = await context.pages.get(context.workspaceId, id);
    expect(page.updatedBy).toMatchObject({ kind: "agent", id: "api:dev", label: `cairn-cli/${VERSION} (claude-code)` });
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
    expect(stdout).toContain("no matches for \"zzzznotaword\"");
    expect(stdout).toContain("synonym");
  });

  it("starts a page from a template with cairn new, and opens today's note with cairn today (ADR-075)", async () => {
    stdin = "# {{title}}\n\nDate: {{date}}\n\n## Attendees\n";
    expect(await cairn("create", "--title", "Meeting notes", "--note", "template")).toBe(0);
    stdin = null;
    const templateId = /^ok (\S+) version/.exec(stdout.trim())![1]!;

    expect(await cairn("new", "--template", templateId, "--title", "Standup", "--note", "from template")).toBe(0);
    expect(stdout).toMatch(/^ok pg_\S+ version \S+/);
    const newId = /^ok (\S+) version/.exec(stdout.trim())![1]!;

    expect(await cairn("read", newId)).toBe(0);
    const today = new Date().toISOString().slice(0, 10);
    expect(stdout).toContain(`# Standup\n\nDate: ${today}\n\n## Attendees`);

    expect(await cairn("today")).toBe(0);
    expect(stdout).toMatch(/^ok created today's note pg_\S+ version \S+/);
    const noteId = /today's note (\S+) version/.exec(stdout.trim())![1]!;

    expect(await cairn("today")).toBe(0);
    expect(stdout).toMatch(/^ok today's note pg_\S+ version \S+/);
    expect(stdout).toContain(`today's note ${noteId} version`);
  });

  it("shows a page once, with a count of the passages it did not print (ADR-057, criteria 8, 9)", async () => {
    stdin = [
      "## First",
      "",
      "zoetropic appears here first.",
      "",
      "## Second",
      "",
      "zoetropic appears here too.",
      "",
      "## Third",
      "",
      "zoetropic and more zoetropic.",
      "",
      "## Fourth",
      "",
      "a fourth zoetropic mention.",
    ].join("\n");
    expect(await cairn("create", "--title", "Zoetropic notes")).toBe(0);
    stdin = null;

    await eventually(async () => {
      expect(await cairn("search", "zoetropic")).toBe(0);
      expect(stdout).toContain("more passage");
    });

    const idLines = stdout.split("\n").filter((line) => /^pg_/.test(line));
    expect(idLines).toHaveLength(1);
  });

  it("publishes a page and takes it down again, and says where it is readable", async () => {
    const { id, version } = await createLog();
    expect(await cairn("publish", id)).toBe(2);
    expect(stderr).toContain("--version");

    expect(await cairn("publish", id, "--version", version, "--note", "Published")).toBe(0);
    expect(stdout).toContain(`/w/${id}`);
    expect(stdout).toContain("does not travel with sync");
    const published = await context.pages.get(context.workspaceId, id);
    expect(published.public).toBe(true);

    expect(await cairn("unpublish", id, "--version", published.version)).toBe(0);
    expect(stdout).toContain("private again");
    expect((await context.pages.get(context.workspaceId, id)).public).toBe(false);
  });

  it("appends without a version, since appending never overwrites", async () => {
    const { id } = await createLog();
    stdin = "Props: 5.1 inch tri-blade.";
    expect(await cairn("append", id, "--note", "Added props")).toBe(0);
    expect(stderr).toBe("");
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
    // The REST wording (ETag, If-Match) means nothing at a terminal, and the
    // CLI's own next step, printed once, replaces it rather than sitting beside it.
    expect(stderr).not.toContain("ETag");
    expect(stderr).not.toContain("If-Match");
    expect(stderr.match(/Read (it|the page) again, merge/g)?.length).toBe(1);
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
    expect(stdout).toContain(`agent: cairn-cli/${VERSION} (claude-code)`);

    expect(await cairn("revision", id, next)).toBe(0);
    expect(stdout).toContain("+ BLHeli_32");

    await eventually(async () => {
      expect(await cairn("changes", "--agents")).toBe(0);
      expect(stdout).toContain(`page ${id} "5 inch build log"`);
      expect(stdout).toContain("next time: --since");
    });
  });

  it("peeks at an old revision without changing anything, then restores it", async () => {
    const { id, version } = await createLog();
    const updated = await cairn(
      "replace-section", id, "--section", "Firmware", "--version", version, "--text", "BLHeli_32", "--note", "Real firmware",
    );
    expect(updated).toBe(0);
    const current = /version (\S+)/.exec(stdout)![1]!;

    expect(await cairn("peek", id, version)).toBe(0);
    expect(stdout).toContain("2207 1750kv");
    expect(stdout).toContain("changed nothing");
    const unchanged = await context.pages.get(context.workspaceId, id);
    expect(unchanged.version).toBe(current);

    expect(await cairn("restore", id, version)).toBe(2);
    expect(stderr).toContain("--version");

    expect(await cairn("restore", id, version, "--version", current, "--note", "Back out the firmware change")).toBe(0);
    expect(stdout).toContain("restored");
    const restored = await context.pages.get(context.workspaceId, id);
    expect(restored.body).toContain("2207 1750kv");
    expect(restored.body).not.toContain("BLHeli_32");
    expect(restored.version).not.toBe(current);
  });

  it("lists a deleted page, undeletes it with its history intact, and drops it from the list again (ADR-059)", async () => {
    const { id, version } = await createLog();
    expect(await cairn("delete", id, "--version", version, "--note", "No longer needed")).toBe(0);

    await eventually(async () => {
      expect(await cairn("deleted")).toBe(0);
      expect(stdout).toContain(id);
      expect(stdout).toContain('"5 inch build log"');
    });

    expect(await cairn("undelete", id, "--note", "Turns out we need it")).toBe(0);
    expect(stdout).toContain("undeleted");

    expect(await cairn("read", id)).toBe(0);
    expect(stdout).toContain("## Motors");

    expect(await cairn("history", id)).toBe(0);
    expect(stdout).toContain('"No longer needed"');
    expect(stdout).toContain('"From bench notes"');

    expect(await cairn("deleted")).toBe(0);
    expect(stdout).not.toContain(id);
  });

  it("lists pages in freshness order with cairn stale, never verified first (ADR-073)", async () => {
    const never = await createLog();
    stdin = "## Motors\n\n2207 1750kv.";
    expect(await cairn("create", "--title", "Verified a while ago", "--note", "note")).toBe(0);
    const olderMatch = /^ok (\S+) version (\S+)$/.exec(stdout.trim());
    const olderId = olderMatch![1]!;
    stdin = null;

    const olderPage = await context.pages.get(context.workspaceId, olderId);
    await context.pages.update(
      context.workspaceId,
      olderId,
      { title: olderPage.title, body: olderPage.body, parentId: olderPage.parentId, tags: olderPage.tags, verifiedAt: "2020-01-01T00:00:00Z" },
      olderPage.version,
      { actor: { kind: "agent", id: "test", label: "test" }, note: "backdate for test" },
    );

    expect(await cairn("stale")).toBe(0);
    const neverIndex = stdout.indexOf(never.id);
    const olderIndex = stdout.indexOf(olderId);
    expect(neverIndex).toBeGreaterThanOrEqual(0);
    expect(olderIndex).toBeGreaterThan(neverIndex);
    expect(stdout).toContain("never verified");
    expect(stdout).toContain("verified 2020-01-01T00:00:00.000Z");
    expect(stdout).toContain("never verified in the workspace");

    expect(await cairn("stale", "--limit", "1")).toBe(0);
    expect(stdout).toContain(never.id);
    expect(stdout).toContain("more: --cursor");
  });

  it("refuses undelete for a page that still exists, naming restore instead", async () => {
    const { id } = await createLog();
    expect(await cairn("undelete", id)).toBe(1);
    expect(stderr).toContain("restore");
  });

  it("refuses undelete for an id with no deletion in its history, naming the fix", async () => {
    expect(await cairn("undelete", "pg_never_existed")).toBe(1);
    expect(stderr).toContain("cairn deleted");
  });

  it("vacuums a page's older revisions, refusing a stale version", async () => {
    const { id, version } = await createLog();
    const updated = await cairn(
      "replace-section", id, "--section", "Firmware", "--version", version, "--text", "BLHeli_32", "--note", "Real firmware",
    );
    expect(updated).toBe(0);
    const current = /version (\S+)/.exec(stdout)![1]!;

    expect(await cairn("vacuum", id)).toBe(2);
    expect(stderr).toContain("--version");

    expect(await cairn("vacuum", id, "--version", version)).toBe(1);
    expect(stderr).toContain("version_conflict");

    expect(await cairn("vacuum", id, "--version", current)).toBe(0);
    expect(stdout).toContain("removed 1");

    expect(await cairn("history", id)).toBe(0);
    expect(stdout.trim().split("\n")).toHaveLength(1);
  });

  it("works with tables: create rows, query, and name bad fields", async () => {
    const table = await context.tables.create(
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
    expect(await cairn("tables")).toBe(0);
    expect(stdout).toContain("Prints  (title:text*, grams:number, material:select)");
    // cairn collections is the top-level pages (ADR-058), not tables: with
    // none created in this test, it lists none.
    expect(await cairn("collections")).toBe(0);
    expect(stdout).toBe("no children\n");

    expect(await cairn("upsert", table.id, "--set", "title=Canopy", "--set", "grams=22", "--set", "material=TPU")).toBe(0);
    expect(await cairn("upsert", table.id, "--set", "title=Mount", "--set", "grams=14", "--set", "material=PLA")).toBe(0);

    expect(await cairn("rows", table.id, "--where", "grams gt 15")).toBe(0);
    expect(stdout).toContain('"title":"Canopy"');
    expect(stdout).not.toContain("Mount");

    // A misspelled field is refused by name, not read as always-null (fault 2,
    // console-and-search-polish, acceptance criterion 12).
    expect(await cairn("rows", table.id, "--where", "nosuch eq 1")).toBe(1);
    expect(stderr).toContain("validation_failed");
    expect(stderr).toContain("nosuch");
    expect(stderr).toContain("known fields: title, grams, material");

    expect(await cairn("upsert", table.id, "--set", "grams=heavy")).toBe(1);
    expect(stderr).toContain("validation_failed");
    expect(stderr).toContain("title:");
    expect(stderr).toContain("grams:");
  });

  it("creates a table's schema from the CLI, then changes it (ADR-058)", async () => {
    expect(
      await cairn(
        "create-table",
        "Spools",
        "--field",
        "material:select(PLA,PETG,TPU)*",
        "--field",
        "prints:relation->pages[]",
        "--note",
        "Track filament on hand",
      ),
    ).toBe(0);
    const created = /^ok (\S+) version (\S+)$/.exec(stdout.trim());
    expect(created).not.toBeNull();
    const [, cid, version] = created!;

    expect(await cairn("tables")).toBe(0);
    expect(stdout).toContain("Spools  (material:select*, prints:relation[])");

    expect(
      await cairn(
        "update-table",
        cid!,
        "--title",
        "Spools",
        "--field",
        "material:select(PLA,PETG,TPU,ABS)*",
        "--version",
        version!,
        "--note",
        "Add ABS as an option",
      ),
    ).toBe(0);
    const table = await context.tables.get(context.workspaceId, cid!);
    expect(table.fields.find((f) => f.name === "material")).toMatchObject({ options: ["PLA", "PETG", "TPU", "ABS"] });

    expect(await cairn("create-table", "Bad")).toBe(2);
    expect(stderr).toContain("--field");
  });

  it("records sources with --source, adds more on later writes, and prints them (ADR-027)", async () => {
    const paper = "https://pubmed.ncbi.nlm.nih.gov/12345/";
    stdin = "A gastric peptide.";
    expect(await cairn("create", "--title", "BPC-157", "--source", paper, "--note", "From the review")).toBe(0);
    stdin = null;
    const [, id, version] = /^ok (\S+) version (\S+)$/.exec(stdout.trim())!;
    expect(await cairn("append", id!, "--text", "Studied in rats.", "--source", "Smith 2021, J Pept Sci")).toBe(0);
    // A write with no --note still succeeds, but warns on stderr rather than
    // passing silently (fault 3, console-and-search-polish, criterion 13).
    expect(stderr).toContain("no change note given");
    expect(stderr).toContain("--note");
    const page = await context.pages.get(context.workspaceId, id!);
    expect(page.sources).toEqual([paper, "Smith 2021, J Pept Sci"]);
    expect(await cairn("revision", id!, page.version)).toBe(0);
    expect(stdout).toContain("+ source: Smith 2021, J Pept Sci");
    expect(version).not.toBe(page.version);

    const table = await context.tables.create(
      context.workspaceId,
      { name: "Peptides", fields: [{ name: "name", type: "text", required: true }] },
      { actor: OWNER, note: null },
    );
    expect(await cairn("upsert", table.id, "--set", "name=BPC-157", "--source", paper)).toBe(0);
    const [, rid, rversion] = /^ok (\S+) version (\S+)$/.exec(stdout.trim())!;
    expect(
      await cairn("upsert", table.id, "--id", rid!, "--version", rversion!, "--set", "name=BPC-157", "--source", "the owner, 2026-09-14"),
    ).toBe(0);
    expect(await cairn("row", table.id, rid!)).toBe(0);
    expect(stdout).toContain(`source: ${paper}`);
    expect(stdout).toContain("source: the owner, 2026-09-14");
  });

  it("marks a page verified with --verified, with or without new text (ADR-028)", async () => {
    const { id } = await createLog();
    expect((await context.pages.get(context.workspaceId, id)).verifiedAt).toBeNull();
    expect(await cairn("append", id, "--verified", "--note", "Re-read the datasheet: still right")).toBe(0);
    const page = await context.pages.get(context.workspaceId, id);
    expect(page.verifiedAt).toBe(page.updatedAt);
    expect(page.body).toBe("## Firmware\n\nOld firmware.\n\n## Motors\n\n2207 1750kv.");
    expect(await cairn("read", id)).toBe(0);
    expect(stdout).toContain(`verified: ${page.verifiedAt}`);
    expect(await cairn("revision", id, page.version)).toBe(0);
    expect(stdout).toContain("verified: the page's facts were re-checked");
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

  it("says the address was a default when none was named (fault 7, console-and-search-polish)", async () => {
    io.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await cairn("overview")).toBe(1);
    expect(stderr).toContain("http://localhost:8787");
    expect(stderr).toContain("the default");
    expect(stderr).toContain("no --instance, CAIRN_URL");
  });

  it("moves a table under a page and shows a row's links (ADR-024)", async () => {
    const ws = context.workspaceId;
    const home = await context.pages.create(ws, { title: "Peptides", body: "Hub." }, { actor: OWNER });
    const peptides = await context.tables.create(ws, { name: "Peptides", fields: [{ name: "name", type: "text", required: true }] }, { actor: OWNER }, "col_peptides");
    await context.tables.create(
      ws,
      { name: "Stacks", fields: [{ name: "title", type: "text", required: true }, { name: "components", type: "relation", target: "col_peptides", multiple: true }] },
      { actor: OWNER },
      "col_stacks",
    );
    await context.tables.upsertRow(ws, "col_peptides", { values: { name: "BPC-157" } }, { actor: OWNER }, { id: "row_bpc" });
    expect(await cairn("upsert", "col_stacks", "--id", "row_wolverine", "--set", "title=Wolverine", "--set", 'components=["row_bpc"]', "--note", "The healing stack")).toBe(0);

    expect(await cairn("move", "col_peptides", "--parent", home.id, "--version", peptides.version, "--note", "Group the tables")).toBe(0);
    expect(stdout).toContain(`ok table col_peptides now under ${home.id}`);
    expect(await cairn("tables")).toBe(0);
    expect(stdout).toContain(`under ${home.id}`);
    expect(stdout).toContain("components:relation->col_peptides[]");

    expect(await cairn("links", "col_peptides/row_bpc")).toBe(0);
    expect(stdout).toContain("col_stacks/row_wolverine  relation components");
  });
});
