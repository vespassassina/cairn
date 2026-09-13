import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, createContext, OWNER, type AppContext } from "@cairn/api";
import { eventually } from "@cairn/core/testing";
import { run, type Io } from "../src/main.js";
import { assignPaths, pageFile, parsePageFile, slugify, type ExportPage } from "../src/export-format.js";

/**
 * Export and import (ADR-016): a folder written from one Cairn, read back
 * into another, must hold the same pages, ids, tree, tags and rows.
 */

const BY = { actor: OWNER, note: null };

let source: AppContext;
let target: AppContext;
let current: AppContext;
let apps: Map<AppContext, ReturnType<typeof createApp>>;
let folder: string;
let stdout: string;
let stderr: string;

function io(): Io {
  return {
    fetch: async (request) => apps.get(current)!.fetch(request),
    env: {},
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: async () => null,
  };
}

async function cairn(on: AppContext, ...argv: string[]): Promise<number> {
  current = on;
  stdout = "";
  stderr = "";
  return run(argv, io());
}

async function seed(context: AppContext) {
  const ws = context.workspaceId;
  const healing = await context.pages.create(ws, { title: "Recovery & healing", body: "Category.", tags: ["category"] }, BY, "pg_cat_healing");
  await context.pages.create(
    ws,
    { title: "BPC-157", parentId: healing.id, body: "## Status\n\nResearch only.\n\nSee [[pg_tb-500|TB-500]].\n", tags: ["peptide"] },
    BY,
    "pg_bpc-157",
  );
  await context.pages.create(ws, { title: "TB-500", parentId: healing.id, body: "Pairs with [[pg_bpc-157]].", tags: ["peptide"] }, BY, "pg_tb-500");
  await context.pages.create(ws, { title: "Longevity", body: "Another category.", tags: ["category"] }, BY, "pg_cat_longevity");
  const peptides = await context.collections.create(
    ws,
    {
      name: "Peptides",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "categories", type: "multi_select", options: ["healing", "longevity"] },
      ],
    },
    BY,
    "col_peptides",
  );
  await context.collections.upsertRow(ws, peptides.id, { values: { name: "BPC-157", categories: ["healing"] } }, BY, { id: "row_bpc" });
}

beforeEach(async () => {
  source = await createContext({ database: ":memory:", workspaceId: "ws_source" });
  target = await createContext({ database: ":memory:", workspaceId: "ws_target" });
  const trust = { enabled: true, hosts: ["localhost"] };
  apps = new Map([
    [source, createApp({ context: source, token: null, trust })],
    [target, createApp({ context: target, token: null, trust })],
  ]);
  folder = join(await mkdtemp(join(tmpdir(), "cairn-export-test-")), "export");
  await seed(source);
});

afterEach(async () => {
  await rm(join(folder, ".."), { recursive: true, force: true });
});

describe("export format", () => {
  it("makes portable file names", () => {
    expect(slugify("Recovery & healing", "pg_x")).toBe("recovery-healing");
    expect(slugify("Café déjà vu", "pg_x")).toBe("cafe-deja-vu");
    expect(slugify("CON", "pg_con")).toBe("pg_con");
    expect(slugify("???", "pg_q")).toBe("pg_q");
  });

  it("gives siblings with the same title different files", () => {
    const pages: ExportPage[] = [
      { id: "pg_a", title: "Notes", parent_id: null, tags: [], body: "" },
      { id: "pg_b", title: "Notes", parent_id: null, tags: [], body: "" },
      { id: "pg_c", title: "Child", parent_id: "pg_a", tags: [], body: "" },
      { id: "pg_d", title: "Notes pg b", parent_id: null, tags: [], body: "" },
    ];
    const paths = [...assignPaths(pages).values()];
    expect(paths).toEqual(["pages/notes.md", "pages/notes-pg-b.md", "pages/notes/child.md", "pages/notes-pg-b-pg-d.md"]);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("round-trips awkward titles, tags and bodies exactly", () => {
    const page: ExportPage = {
      id: "pg_1",
      title: 'Colons: "quotes" and #hashes',
      parent_id: null,
      tags: ["a b", "c:d"],
      body: "---\nnot front matter\n---\n\ntrailing newline\n",
    };
    expect(parsePageFile(pageFile(page), "x.md")).toEqual(page);
    const windows = pageFile(page).replace(/\n/g, "\r\n");
    expect(parsePageFile(windows, "x.md").title).toBe(page.title);
  });

  it("names the file and the problem when front matter is broken", () => {
    expect(() => parsePageFile("no header", "pages/a.md")).toThrow("pages/a.md: no front matter");
    expect(() => parsePageFile('---\ntitle: "x"\n---\n\nbody', "pages/b.md")).toThrow("no id");
  });
});

describe("cairn export and import", () => {
  it("writes Markdown in a tree that mirrors the pages, and JSON per collection", async () => {
    expect(await cairn(source, "export", folder)).toBe(0);
    expect(stdout).toContain("exported 4 pages, 1 collections and 1 rows");

    expect((await readdir(folder)).sort()).toEqual(["cairn-export.json", "collections", "pages"]);
    expect((await readdir(join(folder, "pages"))).sort()).toEqual(["longevity.md", "recovery-healing", "recovery-healing.md"]);
    const bpc = await readFile(join(folder, "pages", "recovery-healing", "bpc-157.md"), "utf8");
    expect(bpc).toContain('id: "pg_bpc-157"');
    expect(bpc).toContain('parent: "pg_cat_healing"');
    expect(bpc).toContain("See [[pg_tb-500|TB-500]].");

    const collection = JSON.parse(await readFile(join(folder, "collections", "peptides.json"), "utf8"));
    expect(collection.rows).toEqual([{ id: "row_bpc", values: { name: "BPC-157", categories: ["healing"] } }]);
    const manifest = JSON.parse(await readFile(join(folder, "cairn-export.json"), "utf8"));
    expect(manifest).toMatchObject({ format: "cairn-export", version: 1, root: null, counts: { pages: 4, collections: 1, rows: 1 } });
  });

  it("refuses to write into a folder that is not empty", async () => {
    expect(await cairn(source, "export", folder)).toBe(0);
    expect(await cairn(source, "export", folder)).toBe(2);
    expect(stderr).toContain("not empty");
    expect(await cairn(source, "export", folder, "--force")).toBe(0);
  });

  it("imports into another Cairn with the same ids, tree, tags, bodies and rows", async () => {
    await cairn(source, "export", folder);
    expect(await cairn(target, "import", folder)).toBe(0);
    expect(stdout).toContain("pages        4 created, 0 updated, 0 unchanged");
    expect(stdout).toContain("rows         1 created");

    for (const id of ["pg_cat_healing", "pg_bpc-157", "pg_tb-500", "pg_cat_longevity"]) {
      const before = await source.pages.get(source.workspaceId, id);
      const after = await target.pages.get(target.workspaceId, id);
      expect({ title: after.title, body: after.body, parentId: after.parentId, tags: after.tags }).toEqual({
        title: before.title,
        body: before.body,
        parentId: before.parentId,
        tags: before.tags,
      });
      expect(after.updatedBy.kind).toBe("agent");
    }
    const row = await target.collections.getRow(target.workspaceId, "col_peptides", "row_bpc");
    expect(row.values).toEqual({ name: "BPC-157", categories: ["healing"] });

    // Links are derived, and rebuilt on import.
    await eventually(async () => {
      const backlinks = await target.pages.backlinks(target.workspaceId, "pg_tb-500");
      expect(backlinks.map((edge) => edge.sourceId)).toContain("pg_bpc-157");
    });
  });

  it("changes nothing the second time, and updates only what was edited", async () => {
    await cairn(source, "export", folder);
    await cairn(target, "import", folder);
    expect(await cairn(target, "import", folder)).toBe(0);
    expect(stdout).toContain("pages        0 created, 0 updated, 4 unchanged");
    expect(stdout).toContain("rows         0 created, 0 updated, 1 unchanged");

    const file = join(folder, "pages", "longevity.md");
    await writeFile(file, (await readFile(file, "utf8")).replace("Another category.", "Edited offline."), "utf8");
    expect(await cairn(target, "import", folder, "--note", "Edited in a text editor")).toBe(0);
    expect(stdout).toContain("pages        0 created, 1 updated, 3 unchanged");
    const history = await target.pages.history(target.workspaceId, "pg_cat_longevity", {});
    expect(history[0]!.note).toBe("Edited in a text editor");
  });

  it("shows the plan without writing anything on a dry run", async () => {
    await cairn(source, "export", folder);
    expect(await cairn(target, "import", folder, "--dry-run")).toBe(0);
    expect(stdout).toContain("dry run, nothing written");
    expect(stdout).toContain("pages        4 created");
    expect(await target.store.getPage(target.workspaceId, "pg_bpc-157")).toBeNull();
  });

  it("exports one page and everything under it, and imports it as top level", async () => {
    expect(await cairn(source, "export", folder, "--root", "pg_cat_healing")).toBe(0);
    expect(stdout).toContain("exported 3 pages, 0 collections");
    const manifest = JSON.parse(await readFile(join(folder, "cairn-export.json"), "utf8"));
    expect(manifest.root).toBe("pg_cat_healing");

    await cairn(target, "import", folder);
    expect((await target.pages.get(target.workspaceId, "pg_cat_healing")).parentId).toBeNull();
    expect((await target.pages.get(target.workspaceId, "pg_tb-500")).parentId).toBe("pg_cat_healing");
    expect(await target.store.getPage(target.workspaceId, "pg_cat_longevity")).toBeNull();

    expect(await cairn(source, "export", folder, "--root", "pg_cat_healing", "--collections", "--force")).toBe(0);
    expect(stdout).toContain("1 collections");
    expect(await cairn(source, "export", join(folder, "none"), "--root", "pg_nope")).toBe(1);
    expect(stderr).toContain("not_found");
  });

  it("moves a page to top level when its parent is nowhere to be found", async () => {
    await cairn(source, "export", folder);
    const file = join(folder, "pages", "longevity.md");
    await writeFile(file, (await readFile(file, "utf8")).replace("parent: null", 'parent: "pg_gone"'), "utf8");
    expect(await cairn(target, "import", folder)).toBe(0);
    expect(stdout).toContain("1 page(s) moved to top level");
    expect((await target.pages.get(target.workspaceId, "pg_cat_longevity")).parentId).toBeNull();
  });

  it("refuses a folder that is not an export", async () => {
    expect(await cairn(target, "import", folder)).toBe(2);
    expect(stderr).toContain("cairn-export.json");
  });

  it("keeps a collection's place in the tree and its row links (ADR-024)", async () => {
    const ws = source.workspaceId;
    await source.collections.create(
      ws,
      { name: "Aa links", parentId: "pg_cat_healing", fields: [{ name: "title", type: "text", required: true }, { name: "to", type: "relation", target: "col_peptides", multiple: true }] },
      BY,
      "col_aa_links",
    );
    await source.collections.upsertRow(ws, "col_aa_links", { values: { title: "Stack", to: ["row_bpc"] } }, BY, { id: "row_stack" });

    expect(await cairn(source, "export", folder)).toBe(0);
    const exported = JSON.parse(await readFile(join(folder, "collections", "aa-links.json"), "utf8"));
    expect(exported.parent_id).toBe("pg_cat_healing");

    // aa-links.json sorts before peptides.json, the collection it points at.
    expect(await cairn(target, "import", folder)).toBe(0);
    expect((await target.collections.get(target.workspaceId, "col_aa_links")).parentId).toBe("pg_cat_healing");
    expect((await target.collections.rowBacklinks(target.workspaceId, "col_peptides", "row_bpc")).map((e) => e.sourceId)).toEqual(["col_aa_links/row_stack"]);
  });
});
