import type { Backup } from "../backup/archive.js";

/**
 * What Cairn does when it starts and the replica will not give it a database
 * it can vouch for (ADR-051).
 *
 * ADR-046 settled the rule: never serve, and never replicate, a database that
 * failed its integrity check. It gave that rule one answer, which was to stop.
 * Stopping is right when the alternative is overwriting the only good copy,
 * and it is a poor answer when a good copy is sitting in the archive.
 *
 * So there is a ladder, and the order is the whole point. Each rung loses more
 * than the one above it, so a rung is only tried when the one above it has
 * failed:
 *
 *   1. The local database, if there is one and it is sound. Nothing was lost.
 *   2. A plain restore from the replica. Seconds behind at most.
 *   3. The newest transaction in the replica that both restores and passes its
 *      integrity check. This walks back past the damage, and a truncated
 *      upload is always at the tail, so this usually costs one transaction.
 *   4. The newest backup that passes its integrity check. Up to
 *      CAIRN_BACKUP_AFTER_HOURS of work, so it is below the rung that costs
 *      one transaction, not above it.
 *   5. Stop, and say exactly what was tried and what to do.
 *
 * The rung that is deliberately absent is Litestream's own `auto-recover`,
 * which resets from the local database. On a container that scaled to zero
 * there is no local database, so it would answer a damaged replica by
 * replacing it with nothing (ADR-048).
 */

export interface RestoreAttempt {
  ok: boolean;
  /** True when retrying cannot help: decode, corruption, checksum, EOF. */
  permanent: boolean;
  /** True when the restore succeeded but the replica holds nothing yet. */
  empty: boolean;
  message: string;
}

export interface Ladder {
  /** Whether a file is there at all. */
  exists(path: string): Promise<boolean>;
  /** SQLite's own verdict. False for missing, truncated or malformed. */
  sound(path: string): Promise<boolean>;
  /** Restore from the replica, optionally as it stood at a moment. */
  restore(destination: string, timestamp?: string): Promise<RestoreAttempt>;
  /**
   * The moments the replica can be restored to, newest first. Used to walk
   * back past damage at the tail.
   */
  moments(): Promise<string[]>;
  /** The backups held, oldest first, or null when backups are off. */
  backups(): Promise<Backup[]> | null;
  /** Bring one backup down to a local path. */
  fetchBackup(name: string, destination: string): Promise<void>;
  /** Move a file out of the way, returning where it went. */
  moveAside(path: string): Promise<string>;
  /** Move a file into place, as the database Cairn will open. */
  place(from: string, to: string): Promise<void>;
  /** Delete a file that turned out to be no use. Never throws. */
  discard(path: string): Promise<void>;
  say(line: string): void;
  oops(line: string): void;
}

export type Outcome =
  | { kind: "local" }
  | { kind: "restored" }
  | { kind: "empty" }
  | { kind: "rewound"; moment: string; skipped: number }
  | { kind: "backup"; name: string; broken: string | null }
  | { kind: "unreachable"; message: string }
  | { kind: "stop" };

/** How far back to walk before accepting that the replica is not usable. */
const MOST_MOMENTS = 10;

export async function climb(database: string, ladder: Ladder): Promise<Outcome> {
  // Rung 1. A database already on disk, which on a mounted volume is the
  // ordinary case. If it is sound there is nothing to recover from and
  // nothing to think about.
  // Whatever is moved out of the way here, kept for the owner to look at.
  let broken: string | null = null;
  if (await ladder.exists(database)) {
    if (await ladder.sound(database)) {
      ladder.say(`the database already here is sound, so nothing needs restoring`);
      return { kind: "local" };
    }
    // Set aside now rather than later. Every rung below this one writes to the
    // same path, so the one moment this file can still be saved is before the
    // first restore is attempted. It is evidence, and the owner may want to
    // pull rows out of it by hand.
    ladder.oops(`the database already here did not pass its integrity check`);
    broken = await ladder.moveAside(database);
    ladder.oops(`it has been kept at ${broken}, and nothing removes it but you`);
  }

  // Rung 2. The ordinary restore.
  const plain = await ladder.restore(database);
  if (plain.ok && plain.empty) {
    ladder.say("the replica holds no database yet, so this Cairn starts empty and becomes its first copy");
    return { kind: "empty" };
  }
  if (plain.ok && (await ladder.sound(database))) {
    ladder.say("restored from the replica, and it passed its integrity check");
    return { kind: "restored" };
  }
  if (plain.ok) {
    ladder.oops("the database restored from the replica did not pass its integrity check");
  } else if (!plain.permanent) {
    // The replica could not be reached, which says nothing about whether it is
    // healthy. Climbing down to a backup here would fork the data over what may
    // be a firewall rule or a role that has not propagated yet, so stop instead.
    ladder.oops(`the replica could not be reached: ${plain.message}`);
    return { kind: "unreachable", message: plain.message };
  } else {
    ladder.oops(`the replica would not restore: ${plain.message}`);
  }

  // Rung 3. Walk back through the replica. A truncated upload is always at the
  // tail, so the transaction before the damage is usually sound, and one
  // transaction is a far smaller loss than hours from a backup.
  await ladder.discard(database);
  const moments = await ladder.moments();
  if (moments.length === 0) {
    ladder.oops("the replica could not be listed, so there is no earlier point to fall back to");
  }
  let tried = 0;
  for (const moment of moments.slice(0, MOST_MOMENTS)) {
    tried += 1;
    ladder.say(`trying the replica as it stood at ${moment}`);
    const attempt = await ladder.restore(database, moment);
    if (attempt.ok && !attempt.empty && (await ladder.sound(database))) {
      const skipped = tried - 1;
      ladder.say(
        `restored the replica as it stood at ${moment}, which passed its integrity check. ` +
          (skipped === 0
            ? "Nothing later than that was left behind."
            : `${skipped} later ${skipped === 1 ? "point was" : "points were"} unreadable and left behind.`),
      );
      return { kind: "rewound", moment, skipped: tried - 1 };
    }
    await ladder.discard(database);
  }
  if (moments.length > 0) {
    ladder.oops(`no point in the replica's last ${tried} could be restored and read back`);
  }

  // Rung 4. The archive. This is the first rung that loses real work, which is
  // why it is the last one before stopping.
  const held = await ladder.backups();
  if (held === null) {
    ladder.oops("backups are off (CAIRN_BACKUP_TO), so there is nothing left to fall back to");
    return { kind: "stop" };
  }
  const newestFirst = [...held].reverse();
  if (newestFirst.length === 0) {
    ladder.oops("there are no backups yet, so there is nothing left to fall back to");
    return { kind: "stop" };
  }

  for (const backup of newestFirst) {
    ladder.say(`trying the backup ${backup.name}`);
    const staged = `${database}.restoring`;
    try {
      await ladder.fetchBackup(backup.name, staged);
    } catch (error) {
      ladder.oops(`could not fetch ${backup.name}: ${message(error)}`);
      await ladder.discard(staged);
      continue;
    }
    if (!(await ladder.sound(staged))) {
      ladder.oops(`${backup.name} did not pass its integrity check either`);
      await ladder.discard(staged);
      continue;
    }

    // A failed restore can have left something at the path. That one is a
    // fragment of this run's own work, not the owner's data, so it goes.
    await ladder.discard(database);
    await ladder.place(staged, database);
    ladder.say(`recovered from the backup ${backup.name}, taken ${backup.at.toISOString()}`);
    return { kind: "backup", name: backup.name, broken };
  }

  ladder.oops("none of the backups could be read back either");
  return { kind: "stop" };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
