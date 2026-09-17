import { describe, expect, it } from "vitest";
import { backupName, backupTime, type Backup } from "../src/backup/archive.js";
import { climb, type Ladder, type RestoreAttempt } from "../src/recovery/ladder.js";
import { ageOf, isPermanent, momentsIn } from "../src/recovery/litestream.js";

// The recovery ladder decides what Cairn starts on (ADR-051). Every rung below
// the first loses something, so the order matters more than any single rung:
// these tests hold the order, and hold the two refusals, which are that an
// unreachable replica never falls through to a backup and that nothing Cairn
// cannot read back is ever served.

const DB = "/data/cairn.sqlite";

const ok: RestoreAttempt = { ok: true, permanent: false, empty: false, message: "" };
const nothing: RestoreAttempt = { ok: true, permanent: false, empty: true, message: "" };
const damagedReplica: RestoreAttempt = {
  ok: false,
  permanent: true,
  empty: false,
  message: "decode page 1460: EOF",
};
const unreachable: RestoreAttempt = {
  ok: false,
  permanent: false,
  empty: false,
  message: "dial tcp: i/o timeout",
};

interface World {
  /** Files that exist, mapped to whether SQLite can vouch for them. */
  files: Map<string, boolean>;
  /** What each restore attempt returns, keyed by timestamp or "" for plain. */
  restores: Map<string, RestoreAttempt>;
  /** What the restore leaves on disk when it succeeds, keyed the same way. */
  leaves: Map<string, boolean>;
  moments: string[];
  backups: Backup[] | null;
  /** Backups whose bytes come down sound. Any other fetch lands damaged. */
  goodBackups: Set<string>;
  /** Backups whose fetch throws. */
  unfetchable: Set<string>;
}

interface Watched {
  ladder: Ladder;
  world: World;
  lines: string[];
  fetched: string[];
  restoreCalls: (string | undefined)[];
}

function build(partial: Partial<World> = {}): Watched {
  const world: World = {
    files: new Map(),
    restores: new Map(),
    leaves: new Map(),
    moments: [],
    backups: null,
    goodBackups: new Set(),
    unfetchable: new Set(),
    ...partial,
  };
  const lines: string[] = [];
  const fetched: string[] = [];
  const restoreCalls: (string | undefined)[] = [];

  const ladder: Ladder = {
    exists: async (path) => world.files.has(path),
    sound: async (path) => world.files.get(path) === true,
    restore: async (destination, timestamp) => {
      restoreCalls.push(timestamp);
      const key = timestamp ?? "";
      const attempt = world.restores.get(key) ?? damagedReplica;
      if (attempt.ok && !attempt.empty) {
        world.files.set(destination, world.leaves.get(key) ?? true);
      }
      return attempt;
    },
    moments: async () => world.moments,
    latestMoment: async () => world.moments[0] ?? null,
    backups: () => (world.backups === null ? null : Promise.resolve(world.backups)),
    fetchBackup: async (name, destination) => {
      fetched.push(name);
      if (world.unfetchable.has(name)) throw new Error("403 from the archive");
      world.files.set(destination, world.goodBackups.has(name));
    },
    moveAside: async (path) => {
      const kept = `${path}.broken-2026-09-16`;
      world.files.set(kept, world.files.get(path) ?? false);
      world.files.delete(path);
      return kept;
    },
    place: async (from, to) => {
      world.files.set(to, world.files.get(from) ?? false);
      world.files.delete(from);
    },
    discard: async (path) => {
      world.files.delete(path);
    },
    say: (line) => lines.push(line),
    oops: (line) => lines.push(line),
  };

  return { ladder, world, lines, fetched, restoreCalls };
}

function backup(name: string): Backup {
  return { name, at: backupTime(name) as Date, bytes: 1024 };
}

const OLD = backupName(new Date("2026-09-15T02:00:00Z"));
const NEW = backupName(new Date("2026-09-16T08:00:00Z"));

describe("the recovery ladder", () => {
  it("keeps a sound local database and never touches the replica", async () => {
    const { ladder, world, restoreCalls } = build();
    world.files.set(DB, true);

    expect(await climb(DB, ladder)).toEqual({ kind: "local" });
    expect(restoreCalls).toEqual([]);
  });

  it("restores from the replica when there is nothing on disk", async () => {
    const { ladder, world } = build();
    world.restores.set("", ok);

    expect(await climb(DB, ladder)).toEqual({ kind: "restored", latest: null });
    expect(world.files.get(DB)).toBe(true);
  });

  it("says how far behind a plain restore could be, not only a rewound one", async () => {
    // The rewound and backup outcomes already name a moment; the ordinary
    // restore, hit on every routine redeploy, used to say nothing about
    // timing at all.
    const { ladder, world } = build();
    world.restores.set("", ok);
    world.moments = ["2026-09-16T10:30:12Z", "2026-09-16T09:00:00Z"];

    expect(await climb(DB, ladder)).toEqual({ kind: "restored", latest: "2026-09-16T10:30:12Z" });
  });

  it("starts empty, not from a backup, when the replica holds nothing yet", async () => {
    // A first deploy looks exactly like total loss unless this case is told
    // apart, and restoring a backup here would be restoring someone else's.
    const { ladder, world, fetched } = build();
    world.restores.set("", nothing);
    world.backups = [backup(OLD)];
    world.goodBackups.add(OLD);

    expect(await climb(DB, ladder)).toEqual({ kind: "empty" });
    expect(fetched).toEqual([]);
  });

  it("walks back to the newest point in the replica that reads back", async () => {
    const { ladder, world, lines } = build();
    world.restores.set("", damagedReplica);
    world.moments = ["2026-09-16T10:00:00Z", "2026-09-16T09:00:00Z"];
    world.restores.set("2026-09-16T10:00:00Z", ok);
    world.leaves.set("2026-09-16T10:00:00Z", false);
    world.restores.set("2026-09-16T09:00:00Z", ok);

    expect(await climb(DB, ladder)).toEqual({
      kind: "rewound",
      moment: "2026-09-16T09:00:00Z",
      skipped: 1,
    });
    expect(lines.join("\n")).toContain("1 later point was unreadable");
  });

  it("does not claim anything was left behind when the newest point worked", async () => {
    const { ladder, world, lines } = build();
    world.restores.set("", damagedReplica);
    world.moments = ["2026-09-16T10:00:00Z"];
    world.restores.set("2026-09-16T10:00:00Z", ok);

    expect(await climb(DB, ladder)).toMatchObject({ kind: "rewound", skipped: 0 });
    expect(lines.join("\n")).toContain("Nothing later than that was left behind");
  });

  it("stops rather than fall back when the replica cannot be reached", async () => {
    // The rung below would fork the data. An unreachable replica is usually a
    // firewall rule or a role that has not propagated, and the replica itself
    // is fine, so falling back would throw away good work to route around it.
    const { ladder, world, fetched } = build();
    world.restores.set("", unreachable);
    world.backups = [backup(NEW)];
    world.goodBackups.add(NEW);

    expect(await climb(DB, ladder)).toEqual({
      kind: "unreachable",
      message: "dial tcp: i/o timeout",
    });
    expect(fetched).toEqual([]);
  });

  it("falls back to the newest backup once the replica is exhausted", async () => {
    const { ladder, world, fetched } = build();
    world.restores.set("", damagedReplica);
    world.backups = [backup(OLD), backup(NEW)];
    world.goodBackups.add(OLD).add(NEW);

    expect(await climb(DB, ladder)).toEqual({ kind: "backup", name: NEW, broken: null });
    expect(fetched).toEqual([NEW]);
    expect(world.files.get(DB)).toBe(true);
  });

  it("keeps the database that would not open, rather than deleting it", async () => {
    const { ladder, world } = build();
    world.files.set(DB, false);
    world.restores.set("", damagedReplica);
    world.backups = [backup(NEW)];
    world.goodBackups.add(NEW);

    const outcome = await climb(DB, ladder);
    expect(outcome).toMatchObject({ kind: "backup", name: NEW });
    const broken = (outcome as { broken: string | null }).broken;
    expect(broken).not.toBeNull();
    expect(world.files.has(broken as string)).toBe(true);
  });

  it("passes over a backup it cannot read back, and takes the next one", async () => {
    const { ladder, world, fetched } = build();
    world.restores.set("", damagedReplica);
    world.backups = [backup(OLD), backup(NEW)];
    world.goodBackups.add(OLD);

    expect(await climb(DB, ladder)).toMatchObject({ kind: "backup", name: OLD });
    expect(fetched).toEqual([NEW, OLD]);
  });

  it("passes over a backup it cannot fetch at all", async () => {
    const { ladder, world, fetched } = build();
    world.restores.set("", damagedReplica);
    world.backups = [backup(OLD), backup(NEW)];
    world.goodBackups.add(OLD);
    world.unfetchable.add(NEW);

    expect(await climb(DB, ladder)).toMatchObject({ kind: "backup", name: OLD });
    expect(fetched).toEqual([NEW, OLD]);
  });

  it("stops when backups are off, and says which setting turns them on", async () => {
    const { ladder, world, lines } = build();
    world.restores.set("", damagedReplica);

    expect(await climb(DB, ladder)).toEqual({ kind: "stop" });
    expect(lines.join("\n")).toContain("CAIRN_BACKUP_TO");
  });

  it("stops when nothing anywhere could be read back", async () => {
    const { ladder, world } = build();
    world.restores.set("", damagedReplica);
    world.backups = [backup(NEW)];

    expect(await climb(DB, ladder)).toEqual({ kind: "stop" });
  });

  it("never serves a database that failed its integrity check", async () => {
    // The whole point of ADR-046, restated here because every rung can break
    // it: a restore that succeeds and reads back damaged is not a success.
    const { ladder, world } = build();
    world.files.set(DB, false);
    world.restores.set("", ok);
    world.leaves.set("", false);

    const outcome = await climb(DB, ladder);
    expect(outcome.kind).not.toBe("local");
    expect(outcome.kind).not.toBe("restored");
    expect(outcome).toEqual({ kind: "stop" });
  });
});

describe("reading the moments out of a litestream listing", () => {
  it("takes the timestamps and puts the newest first", () => {
    const text = [
      "replica  generation  level  min_txid  max_txid  timestamp",
      "abs       0e1f2a3b    0      1         42        2026-09-16T09:00:00Z",
      "abs       0e1f2a3b    0      43        90        2026-09-16T10:30:12Z",
    ].join("\n");

    expect(momentsIn(text)).toEqual(["2026-09-16T10:30:12Z", "2026-09-16T09:00:00Z"]);
  });

  it("keeps each moment once, however often it is printed", () => {
    const text = "2026-09-16T09:00:00Z x 2026-09-16T09:00:00Z";
    expect(momentsIn(text)).toEqual(["2026-09-16T09:00:00Z"]);
  });

  it("finds nothing in output that holds no timestamps", () => {
    expect(momentsIn("no snapshots found\n")).toEqual([]);
  });
});

describe("saying how old a moment is", () => {
  it("rounds to whole seconds under a minute", () => {
    const now = new Date("2026-09-16T10:00:02.400Z");
    expect(ageOf("2026-09-16T10:00:00.000Z", now)).toBe("about 2s");
  });

  it("calls anything under a second just that, not '0s'", () => {
    const now = new Date("2026-09-16T10:00:00.500Z");
    expect(ageOf("2026-09-16T10:00:00.000Z", now)).toBe("less than a second");
  });

  it("rounds to minutes, then hours", () => {
    expect(ageOf("2026-09-16T09:57:00Z", new Date("2026-09-16T10:00:00Z"))).toBe("about 3m");
    expect(ageOf("2026-09-16T07:00:00Z", new Date("2026-09-16T10:00:00Z"))).toBe("about 3h");
  });

  it("is null for a moment it cannot parse, rather than a wrong number", () => {
    expect(ageOf("not a timestamp", new Date())).toBeNull();
  });
});

describe("telling damage apart from a bad moment to ask", () => {
  it("calls damage permanent, because retrying it only hides the reason", () => {
    expect(isPermanent('error="decode database: decode page 1460: EOF"')).toBe(true);
    expect(isPermanent("ltx checksum mismatch")).toBe(true);
    expect(isPermanent("database disk image is malformed")).toBe(true);
  });

  it("calls a network or permission failure worth another try", () => {
    expect(isPermanent("dial tcp 10.0.0.1:443: i/o timeout")).toBe(false);
    expect(isPermanent("AuthorizationPermissionMismatch: 403")).toBe(false);
  });
});
