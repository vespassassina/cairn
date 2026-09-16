import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteDocumentStore } from "@cairn/adapter-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupName, backupTime, FolderArchive } from "../src/backup/archive.js";
import { BackupEngine, expired, type BackupPolicy } from "../src/backup/engine.js";

// The rules the owner set (ADR-049): back up after a write when the last one
// is older than three hours, keep two days of them but never fewer than three,
// and read the age of the newest one at launch rather than assuming.

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-backup-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const POLICY: BackupPolicy = {
  afterMs: 3 * 60 * 60 * 1000,
  keepMs: 2 * 24 * 60 * 60 * 1000,
  keepAtLeast: 3,
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function held(agesInHours: number[], now: number) {
  return agesInHours.map((hours) => {
    const at = new Date(now - hours * HOUR);
    return { name: backupName(at), at, bytes: 1 };
  });
}

/** A real store with something in it, so snapshots are of a real database. */
async function storeWithPages(file: string): Promise<SqliteDocumentStore> {
  const store = new SqliteDocumentStore({ location: file });
  await store.init();
  return store;
}

describe("backup names", () => {
  it("round-trips the time, and sorts oldest first as a string", () => {
    const early = new Date("2026-09-16T08:05:01.000Z");
    const later = new Date("2026-09-16T14:22:59.000Z");
    expect(backupTime(backupName(early))?.toISOString()).toBe(early.toISOString());
    // Sorting the names must sort the backups, because that is how the
    // archive orders them without reading any file metadata.
    expect([backupName(later), backupName(early)].sort()).toEqual([
      backupName(early),
      backupName(later),
    ]);
  });

  it("ignores a file that is not one of ours", () => {
    expect(backupTime("notes.txt")).toBeNull();
    expect(backupTime("cairn-nonsense.sqlite")).toBeNull();
  });
});

describe("retention", () => {
  const now = Date.UTC(2026, 8, 16, 12, 0, 0);

  it("deletes backups past two days", () => {
    const backups = held([1, 10, 30, 50, 70], now);
    const gone = expired(backups, now, POLICY).map((b) => b.name);
    // 50 and 70 hours are past two days; 1, 10 and 30 are not.
    expect(gone).toEqual([backups[4]!.name, backups[3]!.name]);
  });

  it("keeps the newest three however old they are", () => {
    // A Cairn nobody touched for a week. Every backup is past retention, and
    // emptying the archive is exactly the wrong answer.
    const backups = held([200, 300, 400, 500], now);
    const gone = expired(backups, now, POLICY).map((b) => b.name);
    expect(gone).toEqual([backups[3]!.name]);
    expect(gone).toHaveLength(1);
  });

  it("deletes nothing when there are only three", () => {
    expect(expired(held([100, 200, 300], now), now, POLICY)).toEqual([]);
  });

  it("deletes nothing when nothing is old enough", () => {
    expect(expired(held([1, 2, 3, 4, 5, 6], now), now, POLICY)).toEqual([]);
  });
});

describe("the archive", () => {
  it("leaves files that are not backups alone", async () => {
    const archive = new FolderArchive(dir);
    await writeFile(join(dir, "README.txt"), "mine", "utf8");
    await writeFile(join(dir, backupName(new Date())), "x", "utf8");
    const listed = await archive.list();
    expect(listed).toHaveLength(1);
  });

  it("reports an archive that does not exist yet as empty, not as an error", async () => {
    const archive = new FolderArchive(join(dir, "not-created-yet"));
    await expect(archive.list()).resolves.toEqual([]);
  });
});

describe("snapshots", () => {
  it("makes a copy that opens, and leaves no write-ahead log", async () => {
    const file = join(dir, "cairn.sqlite");
    const store = await storeWithPages(file);
    const to = join(dir, "copy.sqlite");

    const { bytes } = await store.snapshot(to);

    expect(bytes).toBeGreaterThan(0);
    const copy = new DatabaseSync(to, { readOnly: true });
    expect(copy.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
    copy.close();
    // Self-contained: it can be uploaded or moved as one file.
    expect(existsSync(`${to}-wal`)).toBe(false);
    await store.close();
  });

  it("refuses a damaged database, and leaves nothing behind that looks like a backup", async () => {
    const file = join(dir, "cairn.sqlite");
    const store = await storeWithPages(file);
    await store.close();

    // Enough rows that the file has pages in the middle which are really in
    // use: scribbling on a free page proves nothing, because a vacuum never
    // reads one.
    const raw = new DatabaseSync(file);
    raw.exec("CREATE TABLE bulk(id INTEGER PRIMARY KEY, body TEXT)");
    const insert = raw.prepare("INSERT INTO bulk VALUES(?, ?)");
    for (let i = 0; i < 5000; i++) insert.run(i, "body ".repeat(60) + i);
    raw.close();

    // Scribble over a page well inside the file, the way a bad write would.
    const handle = await (await import("node:fs/promises")).open(file, "r+");
    await handle.write(Buffer.alloc(4096, 0x5a), 0, 4096, 4096 * 40);
    await handle.close();

    const damaged = new SqliteDocumentStore({ location: file });
    const to = join(dir, "copy.sqlite");
    await expect(damaged.snapshot(to)).rejects.toThrow(/database/i);
    // The trap this guards: a refused vacuum still writes a partial file. A
    // truncated file that looks like a backup is the whole failure mode.
    expect(existsSync(to), "a partial copy was left where a backup would be looked for").toBe(false);
    expect(existsSync(`${to}.partial`)).toBe(false);
    await damaged.close().catch(() => {});
  });
});

describe("the engine", () => {
  it("does not back up on a write until the last backup is three hours old", async () => {
    const file = join(dir, "cairn.sqlite");
    const store = await storeWithPages(file);
    const archive = new FolderArchive(join(dir, "backups"));
    let clock = Date.UTC(2026, 8, 16, 12, 0, 0);
    const engine = new BackupEngine({
      source: store,
      archive,
      policy: POLICY,
      log: () => {},
      now: () => clock,
      scratchDir: dir,
    });

    await engine.start();
    // Nothing in the archive, so the first write is due at once: a Cairn with
    // no backup at all should not wait three hours for its first.
    expect(engine.due()).toBe(true);
    await engine.backupNow("the first one");
    expect(engine.due()).toBe(false);

    clock += 2 * HOUR;
    expect(engine.due()).toBe(false);
    clock += 1 * HOUR + 1000;
    expect(engine.due()).toBe(true);

    await store.close();
  });

  it("reads the age of the newest backup at launch, rather than assuming", async () => {
    const file = join(dir, "cairn.sqlite");
    const store = await storeWithPages(file);
    const archive = new FolderArchive(join(dir, "backups"));
    const clock = Date.UTC(2026, 8, 16, 12, 0, 0);

    // A backup taken an hour ago by the container that ran before this one.
    const previous = join(dir, "previous.sqlite");
    await store.snapshot(previous);
    await archive.put(backupName(new Date(clock - HOUR)), previous);

    const engine = new BackupEngine({
      source: store,
      archive,
      policy: POLICY,
      log: () => {},
      now: () => clock,
      scratchDir: dir,
    });
    await engine.start();

    // Without reading the archive this would be due, and a platform that
    // starts a fresh container per idle period would back up every time.
    expect(engine.due()).toBe(false);
    await store.close();
  });

  it("applies retention when it backs up", async () => {
    const file = join(dir, "cairn.sqlite");
    const store = await storeWithPages(file);
    const backups = join(dir, "backups");
    const archive = new FolderArchive(backups);
    const clock = Date.UTC(2026, 8, 16, 12, 0, 0);

    const seed = join(dir, "seed.sqlite");
    await store.snapshot(seed);
    for (const hours of [200, 150, 100, 50, 4]) {
      await archive.put(backupName(new Date(clock - hours * HOUR)), seed);
    }

    const engine = new BackupEngine({
      source: store,
      archive,
      policy: POLICY,
      log: () => {},
      now: () => clock,
      scratchDir: dir,
    });
    await engine.start();
    const outcome = await engine.backupNow("a test");

    expect(outcome).not.toBeNull();
    const left = (await readdir(backups)).sort();
    // Six existed; those past two days go, except that the three newest are
    // always spared. The newest three here are the new one, the 4 hour one
    // and the 50 hour one, so the 100, 150 and 200 hour ones go.
    expect(left).toHaveLength(3);
    expect(outcome!.removed).toHaveLength(3);
    await store.close();
  });

  it("keeps serving, and stays due, when a backup fails", async () => {
    const file = join(dir, "cairn.sqlite");
    const store = await storeWithPages(file);
    const lines: string[] = [];
    const engine = new BackupEngine({
      source: store,
      // An archive that refuses everything, standing in for storage being
      // unreachable or a credential having expired.
      archive: {
        where: "nowhere",
        list: async () => [],
        put: () => Promise.reject(new Error("storage said no")),
        get: async () => {},
        remove: async () => {},
      },
      policy: POLICY,
      log: (line) => lines.push(line),
      now: () => Date.UTC(2026, 8, 16, 12, 0, 0),
      scratchDir: dir,
    });

    await engine.start();
    await expect(engine.backupNow("a test")).resolves.toBeNull();
    expect(lines.join("\n")).toContain("storage said no");
    // The clock must not restart on a failure, or a broken archive would go
    // unnoticed for three hours at a time.
    expect(engine.due()).toBe(true);
    // And nothing is left in the scratch folder.
    expect((await readdir(dir)).filter((n) => n.startsWith("cairn-2"))).toEqual([]);
    await store.close();
  });

  it("never throws into the write that triggered it", async () => {
    const store = await storeWithPages(join(dir, "cairn.sqlite"));
    const engine = new BackupEngine({
      source: store,
      archive: {
        where: "nowhere",
        list: () => Promise.reject(new Error("unreadable")),
        put: () => Promise.reject(new Error("storage said no")),
        get: async () => {},
        remove: async () => {},
      },
      policy: POLICY,
      log: () => {},
      scratchDir: dir,
    });
    await engine.start();

    // The contract: synchronous, returns nothing, throws nothing.
    expect(() => engine.afterWrite()).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    await store.close();
  });
});
