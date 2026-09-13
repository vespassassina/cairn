import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDocumentStore, SqliteSearchIndex } from "../src/index.js";

/**
 * Several connections share one database file: the document store, the
 * search index, the auth store, and Litestream beside them (ADR-018). A write
 * that finds the file locked must wait for the lock, not fail with "database
 * is locked", which is what the first import into Azure did.
 */

const WS = "ws_busy";
const META = {
  version: "v1",
  actor: { kind: "user" as const, id: "owner", label: "Owner" },
  at: "2026-09-13T00:00:00.000Z",
};

/** Holds the write lock on `file` from another process for `ms`. */
async function holdWriteLock(file: string, ms: number): Promise<() => Promise<void>> {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("locked\\n");
    setTimeout(() => { db.exec("COMMIT"); db.close(); }, Number(process.argv[2]));
  `;
  const child = spawn(process.execPath, ["-e", script, file, String(ms)], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`lock holder exited with ${String(code)}`)));
  });
  return () => new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", () => resolve())));
}

describe("sqlite connections wait for a locked database", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function file(): string {
    const dir = mkdtempSync(join(tmpdir(), "cairn-busy-"));
    dirs.push(dir);
    return join(dir, "cairn.sqlite");
  }

  it("the document store writes once another process releases the lock", async () => {
    const location = file();
    const store = new SqliteDocumentStore({ location });
    await store.init();
    const done = await holdWriteLock(location, 500);
    const page = await store.putPage(WS, "pg_busy", { title: "Busy", body: "Written after the lock." }, null, META);
    expect(page.id).toBe("pg_busy");
    await done();
    await store.close();
  });

  it("the search index writes once another process releases the lock", async () => {
    const location = file();
    const index = new SqliteSearchIndex({ location });
    await index.init();
    const done = await holdWriteLock(location, 500);
    await index.replaceChunksForPage(WS, "pg_busy", [
      { id: "pg_busy:0", pageId: "pg_busy", ordinal: 0, text: "written after the lock", headingPath: ["Busy"] },
    ]);
    expect((await index.search(WS, { query: "lock" })).hits.map((h) => h.pageId)).toEqual(["pg_busy"]);
    await done();
    await index.close();
  });
});
