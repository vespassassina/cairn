import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  const peptides = await context.tables.create(
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
  await context.tables.upsertRow(ws, peptides.id, { values: { name: "BPC-157", categories: ["healing"] } }, BY, { id: "row_bpc" });
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
  it("writes Markdown in a tree that mirrors the pages, and JSON per table", async () => {
    expect(await cairn(source, "export", folder)).toBe(0);
    expect(stdout).toContain("exported 4 pages, 1 tables and 1 rows");

    expect((await readdir(folder)).sort()).toEqual(["cairn-export.json", "pages", "tables"]);
    expect((await readdir(join(folder, "pages"))).sort()).toEqual(["longevity.md", "recovery-healing", "recovery-healing.md"]);
    const bpc = await readFile(join(folder, "pages", "recovery-healing", "bpc-157.md"), "utf8");
    expect(bpc).toContain('id: "pg_bpc-157"');
    expect(bpc).toContain('parent: "pg_cat_healing"');
    expect(bpc).toContain("See [[pg_tb-500|TB-500]].");

    const table = JSON.parse(await readFile(join(folder, "tables", "peptides.json"), "utf8"));
    expect(table.rows).toEqual([{ id: "row_bpc", values: { name: "BPC-157", categories: ["healing"] } }]);
    const manifest = JSON.parse(await readFile(join(folder, "cairn-export.json"), "utf8"));
    expect(manifest).toMatchObject({ format: "cairn-export", version: 2, root: null, counts: { pages: 4, tables: 1, rows: 1 } });
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
    const row = await target.tables.getRow(target.workspaceId, "col_peptides", "row_bpc");
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

  it("carries sources through export and import, and only where there are some (ADR-027)", async () => {
    const ws = source.workspaceId;
    const page = await source.pages.get(ws, "pg_bpc-157");
    await source.pages.update(ws, page.id, { ...page, sources: ["https://pubmed.ncbi.nlm.nih.gov/12345/", "Smith 2021"] }, page.version, BY);
    const row = await source.tables.getRow(ws, "col_peptides", "row_bpc");
    await source.tables.upsertRow(ws, "col_peptides", { values: row.values, sources: ["Smith 2021"] }, BY, {
      id: row.id,
      expectedVersion: row.version,
    });
    await cairn(source, "export", folder);
    const file = (await readdir(join(folder, "pages"), { recursive: true })).find((name) => name.endsWith("bpc-157.md"))!;
    expect(await readFile(join(folder, "pages", file), "utf8")).toContain('sources: ["https://pubmed.ncbi.nlm.nih.gov/12345/","Smith 2021"]');
    expect(await readFile(join(folder, "pages", "longevity.md"), "utf8")).not.toContain("sources");

    expect(await cairn(target, "import", folder)).toBe(0);
    expect((await target.pages.get(target.workspaceId, "pg_bpc-157")).sources).toEqual([
      "https://pubmed.ncbi.nlm.nih.gov/12345/",
      "Smith 2021",
    ]);
    expect((await target.tables.getRow(target.workspaceId, "col_peptides", "row_bpc")).sources).toEqual(["Smith 2021"]);
    expect(await cairn(target, "import", folder)).toBe(0);
    expect(stdout).toContain("pages        0 created, 0 updated, 4 unchanged");
    expect(stdout).toContain("rows         0 created, 0 updated, 1 unchanged");
  });

  it("carries when a page was verified through export and import (ADR-028)", async () => {
    const ws = source.workspaceId;
    const page = await source.pages.get(ws, "pg_bpc-157");
    await source.pages.update(ws, page.id, { ...page, verifiedAt: "2026-03-01T10:00:00Z" }, page.version, BY);
    await cairn(source, "export", folder);
    const file = (await readdir(join(folder, "pages"), { recursive: true })).find((name) => name.endsWith("bpc-157.md"))!;
    expect(await readFile(join(folder, "pages", file), "utf8")).toContain('verified: "2026-03-01T10:00:00.000Z"');
    expect(await readFile(join(folder, "pages", "longevity.md"), "utf8")).not.toContain("verified");

    expect(await cairn(target, "import", folder)).toBe(0);
    expect((await target.pages.get(target.workspaceId, "pg_bpc-157")).verifiedAt).toBe("2026-03-01T10:00:00.000Z");
    expect((await target.pages.get(target.workspaceId, "pg_cat_longevity")).verifiedAt).toBeNull();
    expect(await cairn(target, "import", folder)).toBe(0);
    expect(stdout).toContain("pages        0 created, 0 updated, 4 unchanged");
  });

  it("carries the approval mark through export and import (ADR-078)", async () => {
    const ws = source.workspaceId;
    const page = await source.pages.get(ws, "pg_bpc-157");
    await source.pages.update(
      ws,
      page.id,
      { ...page, approval: "disapproved", approvalAt: "2026-09-24T10:00:00.000Z", approvalVersion: page.version },
      page.version,
      BY,
    );
    await cairn(source, "export", folder);
    const file = (await readdir(join(folder, "pages"), { recursive: true })).find((name) => name.endsWith("bpc-157.md"))!;
    const text = await readFile(join(folder, "pages", file), "utf8");
    expect(text).toContain('approval: "disapproved"');
    expect(text).toContain('approval_at: "2026-09-24T10:00:00.000Z"');
    expect(text).not.toContain("approval_version");
    expect(await readFile(join(folder, "pages", "longevity.md"), "utf8")).not.toContain("approval");

    expect(await cairn(target, "import", folder)).toBe(0);
    const imported = await target.pages.get(target.workspaceId, "pg_bpc-157");
    expect(imported.approval).toBe("disapproved");
    expect(imported.approvalAt).toBe("2026-09-24T10:00:00.000Z");
    expect(imported.approvalVersion).toBe(imported.version);
    expect((await target.pages.get(target.workspaceId, "pg_cat_longevity")).approval).toBe("neutral");
    expect(await cairn(target, "import", folder)).toBe(0);
    expect(stdout).toContain("pages        0 created, 0 updated, 4 unchanged");
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
    expect(stdout).toContain("exported 3 pages, 0 tables");
    const manifest = JSON.parse(await readFile(join(folder, "cairn-export.json"), "utf8"));
    expect(manifest.root).toBe("pg_cat_healing");

    await cairn(target, "import", folder);
    expect((await target.pages.get(target.workspaceId, "pg_cat_healing")).parentId).toBeNull();
    expect((await target.pages.get(target.workspaceId, "pg_tb-500")).parentId).toBe("pg_cat_healing");
    expect(await target.store.getPage(target.workspaceId, "pg_cat_longevity")).toBeNull();

    expect(await cairn(source, "export", folder, "--root", "pg_cat_healing", "--tables", "--force")).toBe(0);
    expect(stdout).toContain("1 tables");
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

  it("reads an export from before tables were called tables (format 1, ADR-026)", async () => {
    expect(await cairn(source, "export", folder)).toBe(0);
    await rename(join(folder, "tables"), join(folder, "collections"));
    const manifest = JSON.parse(await readFile(join(folder, "cairn-export.json"), "utf8"));
    const { tables, ...counts } = manifest.counts;
    await writeFile(join(folder, "cairn-export.json"), JSON.stringify({ ...manifest, version: 1, counts: { ...counts, collections: tables } }));

    expect(await cairn(target, "import", folder)).toBe(0);
    expect(stdout).toContain("tables       1 created");
    expect((await target.tables.getRow(target.workspaceId, "col_peptides", "row_bpc")).values).toEqual({ name: "BPC-157", categories: ["healing"] });
  });

  it("refuses a folder that is not an export", async () => {
    expect(await cairn(target, "import", folder)).toBe(2);
    expect(stderr).toContain("cairn-export.json");
  });

  it("writes a static site as HTML, with relative links and a sitemap (ADR-035)", async () => {
    expect(await cairn(source, "export", folder, "--format", "site")).toBe(0);
    expect(stdout).toContain("exported 4 pages as a static site");

    const index = await readFile(join(folder, "index.html"), "utf8");
    expect(index).toContain('<a href="pages/recovery-healing.html">Recovery &amp; healing</a>');
    expect(index).toContain('<a href="pages/longevity.html">Longevity</a>');

    const bpc = await readFile(join(folder, "pages", "recovery-healing", "bpc-157.html"), "utf8");
    expect(bpc).toContain("<h1>BPC-157</h1>");
    expect(bpc).toContain('<a href="tb-500.html">TB-500</a>');
    expect(bpc).toContain('<a href="../recovery-healing.html">Recovery &amp; healing</a>');

    expect(await readdir(join(folder, "tables")).catch(() => null)).toBeNull();

    await rm(join(folder, ".."), { recursive: true, force: true });
    folder = join(await mkdtemp(join(tmpdir(), "cairn-export-test-")), "export");
    expect(await cairn(source, "export", folder, "--format", "site", "--site-url", "https://wiki.example.com/")).toBe(0);
    const sitemap = await readFile(join(folder, "sitemap.xml"), "utf8");
    expect(sitemap).toContain("<loc>https://wiki.example.com/index.html</loc>");
    expect(sitemap).toContain("<loc>https://wiki.example.com/pages/longevity.html</loc>");
  });

  it("refuses an unknown --format", async () => {
    expect(await cairn(source, "export", folder, "--format", "pdf")).toBe(2);
    expect(stderr).toContain('--format must be "cairn" or "site"');
  });

  it("keeps a table's place in the tree and its row links (ADR-024)", async () => {
    const ws = source.workspaceId;
    await source.tables.create(
      ws,
      { name: "Aa links", parentId: "pg_cat_healing", fields: [{ name: "title", type: "text", required: true }, { name: "to", type: "relation", target: "col_peptides", multiple: true }] },
      BY,
      "col_aa_links",
    );
    await source.tables.upsertRow(ws, "col_aa_links", { values: { title: "Stack", to: ["row_bpc"] } }, BY, { id: "row_stack" });

    expect(await cairn(source, "export", folder)).toBe(0);
    const exported = JSON.parse(await readFile(join(folder, "tables", "aa-links.json"), "utf8"));
    expect(exported.parent_id).toBe("pg_cat_healing");

    // aa-links.json sorts before peptides.json, the table it points at.
    expect(await cairn(target, "import", folder)).toBe(0);
    expect((await target.tables.get(target.workspaceId, "col_aa_links")).parentId).toBe("pg_cat_healing");
    expect((await target.tables.rowBacklinks(target.workspaceId, "col_peptides", "row_bpc")).map((e) => e.sourceId)).toEqual(["col_aa_links/row_stack"]);
  });
});
