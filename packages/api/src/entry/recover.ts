import { execFile } from "node:child_process";
import { access, rename, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { loadConfig } from "../config.js";
import { openArchive } from "../backup/open.js";
import type { Backup } from "../backup/archive.js";
import { climb, type Ladder, type RestoreAttempt } from "../recovery/ladder.js";
import { ageOf, isPermanent, momentsIn } from "../recovery/litestream.js";

/**
 * Bring a database back before the server opens it (ADR-051).
 *
 * Run by `docker/start.sh` ahead of the server, because the decision it makes
 * needs the replica, the archive and SQLite, and shell is the wrong place for
 * any of that. The ladder itself is in `recovery/ladder.ts` and knows nothing
 * about Litestream or clouds; this file is the part that is platform specific,
 * which by hard rule 13 is what belongs under `entry/`.
 *
 * It prints what it did and exits 0 when Cairn may start, or non-zero when it
 * may not. It never starts the server itself.
 */

const run = promisify(execFile);

/** How long to keep trying a restore that looks like a network problem. */
const TRIES = Number(process.env["CAIRN_RESTORE_TRIES"] ?? 12);
const WAIT_MS = Number(process.env["CAIRN_RESTORE_WAIT_MS"] ?? 10_000);

function say(line: string): void {
  process.stdout.write(`cairn: ${line}\n`);
}

function oops(line: string): void {
  process.stderr.write(`cairn: ${line}\n`);
}

/** Every moment `litestream ltx` reports for `replica`, newest first. */
async function listMoments(replica: string, options: { verbose: boolean }): Promise<string[]> {
  try {
    const { stdout, stderr } = await run("litestream", ["ltx", "-level", "all", replica]);
    const text = `${stdout}${stderr}`;
    if (options.verbose) {
      // Worth printing whole: when recovery fails this is the record of what
      // the replica actually held, and on Azure the container's log is the
      // only place the owner can see it (ADR-046).
      process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
    }
    return momentsIn(text);
  } catch (error) {
    oops(`litestream ltx could not list the replica: ${(error as Error).message}`);
    return [];
  }
}

async function main(): Promise<number> {
  const config = loadConfig();
  const database = config.database;
  const replica = process.env["CAIRN_REPLICA_URL"] ?? "";
  if (replica === "") {
    // Without a replica there is nothing to restore from, and the start script
    // handles the local-only case itself.
    say("no replica is configured, so there is nothing to restore");
    return 0;
  }

  const archive =
    config.backups.to === null
      ? null
      : openArchive(config.backups.to, {
          ...(config.backups.region === null ? {} : { region: config.backups.region }),
          ...(config.backups.endpoint === null ? {} : { endpoint: config.backups.endpoint }),
        });

  const ladder: Ladder = {
    exists: async (path) => access(path).then(() => true).catch(() => false),

    sound: async (path) => {
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(path, { readOnly: true });
        const row = db.prepare("pragma integrity_check").get() as { integrity_check?: string };
        return row.integrity_check === "ok";
      } catch {
        return false;
      } finally {
        try {
          db?.close();
        } catch {
          // Already closed, or never opened.
        }
      }
    },

    restore: async (destination, timestamp): Promise<RestoreAttempt> => {
      const args = ["restore", "-if-replica-exists", "-o", destination];
      if (timestamp !== undefined) args.push("-timestamp", timestamp);
      args.push(replica);

      // Access to storage can take a minute to arrive after a first deploy,
      // while Azure grants the app's identity its role, and a network error is
      // worth another try. Damage is neither of those: retrying it only burns
      // the restart and hides the reason (ADR-046).
      let attempt = 1;
      for (;;) {
        try {
          const { stdout, stderr } = await run("litestream", args);
          const text = `${stdout}${stderr}`;
          // -if-replica-exists succeeds quietly when there is nothing there,
          // and leaves no file behind. That is "empty", not "restored".
          const empty = !(await access(destination).then(() => true).catch(() => false));
          return { ok: true, permanent: false, empty, message: text.trim() };
        } catch (error) {
          const text =
            `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}` ||
            (error as Error).message;
          if (isPermanent(text)) {
            return { ok: false, permanent: true, empty: false, message: text.trim() };
          }
          if (attempt >= TRIES) {
            return {
              ok: false,
              permanent: false,
              empty: false,
              message:
                `${text.trim()} (after ${attempt} attempts over ${(TRIES * WAIT_MS) / 1000} seconds). ` +
                "This reads as a network or permission problem rather than damaged data. Check that the " +
                "app's managed identity still holds Storage Blob Data Contributor on that account, and " +
                "that the storage account allows this container's network.",
            };
          }
          oops(`restore attempt ${attempt} failed, and looks temporary; retrying in ${WAIT_MS / 1000} seconds`);
          await new Promise((wake) => setTimeout(wake, WAIT_MS));
          attempt += 1;
        }
      }
    },

    moments: () => listMoments(replica, { verbose: true }),

    // Same listing as `moments`, but quiet: called on every ordinary restore,
    // not only a failed one, so dumping the whole replica history here would
    // put it in the log of every routine restart rather than only the ones
    // where it is evidence of something.
    latestMoment: async () => (await listMoments(replica, { verbose: false }))[0] ?? null,

    backups: (): Promise<Backup[]> | null => (archive === null ? null : archive.list()),

    fetchBackup: async (name, destination) => {
      if (archive === null) throw new Error("backups are off");
      await archive.get(name, destination);
    },

    moveAside: async (path) => {
      const kept = `${path}.broken-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await rename(path, kept);
      // The write-ahead log and shared memory belong to the file we moved, and
      // leaving them beside a different database is how SQLite is handed a
      // mismatched pair.
      for (const suffix of ["-wal", "-shm"]) {
        await rm(`${path}${suffix}`, { force: true }).catch(() => {});
      }
      return kept;
    },

    place: async (from, to) => {
      await rename(from, to);
    },

    discard: async (path) => {
      for (const suffix of ["", "-wal", "-shm"]) {
        await rm(`${path}${suffix}`, { force: true }).catch(() => {});
      }
    },

    say,
    oops,
  };

  const outcome = await climb(database, ladder);

  if (outcome.kind === "unreachable") {
    oops(`error: Cairn could not reach the replica at ${replica}, so it cannot tell whether its database is sound.`);
    oops("It stops rather than fall back to an older copy, because an unreachable replica is usually a");
    oops("network or permission problem and the replica itself may be perfectly healthy. Starting from a");
    oops("backup here would throw away good data to work around a firewall rule.");
    return 1;
  }

  if (outcome.kind === "stop") {
    oops("error: Cairn has no database it can vouch for, and will not start on one it cannot.");
    oops("Nothing has been deleted. What to try, in the order worth trying:");
    oops(`1. Pick a point from the replica listing above and restore it by hand:`);
    oops(`     litestream restore -timestamp <RFC3339> -o ${database} ${replica}`);
    oops("2. If another Cairn holds this workspace, take it from there:");
    oops("     cairn export <folder>   on the Cairn that has the data");
    oops("     cairn import <folder>   into this one, once it is running");
    oops(
      `3. Start empty only once you are certain nothing else holds a newer copy, because the first write overwrites the replica. Move ${database} aside and redeploy.`,
    );
    return 1;
  }

  if (outcome.kind === "restored" && outcome.latest !== null) {
    const age = ageOf(outcome.latest);
    if (age !== null) {
      say(`the replica's newest point is ${age} old, which bounds what a crash right before this start could have cost`);
    }
  }

  if (outcome.kind === "backup") {
    // This is the one outcome that silently changes what the replica will hold,
    // so it is said plainly rather than left in a log line nobody reads.
    oops(
      `warning: Cairn recovered from the backup ${outcome.name}, not from the replica. ` +
        "Anything written after that backup is not in this database. Once Cairn starts, " +
        "Litestream will replicate this database and the replica's own history is replaced by it, " +
        "which is the intended outcome here because the replica could not be read back at all.",
    );
    if (outcome.broken !== null) {
      oops(`The database that would not open is kept at ${outcome.broken}. Nothing removes it but you.`);
    }
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    oops(`error: recovery itself failed: ${error instanceof Error ? error.message : String(error)}`);
    oops("Cairn will not start, because it cannot tell whether its database is sound.");
    process.exit(1);
  });
