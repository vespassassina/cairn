import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Snapshotter } from "@cairn/core";
import { backupName, type Archive, type Backup } from "./archive.js";

/**
 * When Cairn backs itself up, and what it keeps (ADR-049).
 *
 * The owner set the shape of this, and one of their corrections closed a hole
 * worth recording. The first design was a timer every twelve hours. A timer
 * never fires in a container that is scaled to zero, which is the normal state
 * of the Azure Cairn, so a Cairn that was used twice a day would have been
 * backed up never. The rule instead is:
 *
 *   "every new write if last backup is older than 3 hours, we backup"
 *
 * Activity is what triggers it, so a Cairn that is used is backed up and a
 * Cairn that is not needs no backup, because nothing has changed. There is no
 * timer to miss, and no schedule to be wrong about.
 *
 * Two things follow that the owner also specified. At launch the age of the
 * newest backup is read from the archive, so a container that has just started
 * knows how long it has been rather than assuming it has been forever and
 * backing up on its first request. And a backup is taken on the way down, so
 * the work of the last few hours is not what gets lost.
 */

export interface BackupPolicy {
  /** Back up after a write when the newest backup is older than this. */
  afterMs: number;
  /** Delete backups older than this. */
  keepMs: number;
  /** However old they are, never leave fewer than this many. */
  keepAtLeast: number;
}

export const DEFAULT_POLICY: BackupPolicy = {
  afterMs: 3 * 60 * 60 * 1000,
  keepMs: 2 * 24 * 60 * 60 * 1000,
  keepAtLeast: 3,
};

export interface BackupEngineOptions {
  source: Snapshotter;
  archive: Archive;
  policy?: BackupPolicy;
  log: (line: string) => void;
  /** Overridable so tests need not wait three hours. */
  now?: () => number;
  /** Where the copy is built before it is handed to the archive. */
  scratchDir?: string;
}

export interface BackupOutcome {
  name: string;
  bytes: number;
  ms: number;
  /** Names removed by retention in the same run. */
  removed: string[];
}

/**
 * Which backups retention should delete: everything past `keepMs`, except
 * that the newest `keepAtLeast` are always kept however old they are.
 *
 * The minimum is what makes the rule safe. "Older than two days" on its own
 * would empty the archive completely for a Cairn nobody touched for a week,
 * and the week it was not touched is exactly when nobody would notice.
 * Separated out from the engine because the rule is worth testing on its own.
 */
export function expired(backups: Backup[], now: number, policy: BackupPolicy): Backup[] {
  const oldestFirst = [...backups].sort((a, b) => a.at.getTime() - b.at.getTime());
  const spared = policy.keepAtLeast > 0 ? oldestFirst.slice(-policy.keepAtLeast) : [];
  const safe = new Set(spared.map((backup) => backup.name));
  return oldestFirst.filter(
    (backup) => !safe.has(backup.name) && now - backup.at.getTime() > policy.keepMs,
  );
}

export class BackupEngine {
  private readonly policy: BackupPolicy;
  private readonly now: () => number;
  private readonly scratchDir: string;
  /** Null means "not known yet", which is different from "never". */
  private lastAt: number | null = null;
  private running: Promise<BackupOutcome | null> | null = null;

  constructor(private readonly options: BackupEngineOptions) {
    this.policy = options.policy ?? DEFAULT_POLICY;
    this.now = options.now ?? Date.now;
    this.scratchDir = options.scratchDir ?? tmpdir();
  }

  /**
   * Epoch milliseconds of the newest backup, 0 if none exists yet, or null if
   * `start()` has not run (or failed) so the age is not known at all. Read by
   * the console footer (ADR-056/057 fault 8) and `/health`.
   */
  lastBackupAt(): number | null {
    return this.lastAt;
  }

  /**
   * Read the age of the newest backup, once, at startup. Without this a fresh
   * container assumes it has never backed up and takes one on its first
   * request, which on a platform that starts a container per idle period means
   * a backup per idle period rather than one every three hours.
   */
  async start(): Promise<void> {
    try {
      const held = await this.options.archive.list();
      const newest = held.at(-1);
      this.lastAt = newest?.at.getTime() ?? 0;
      this.options.log(
        newest
          ? `backups: ${held.length} in ${this.options.archive.where}, newest ${newest.name}, ${describeAge(this.now() - newest.at.getTime())} old`
          : `backups: none yet, they will go to ${this.options.archive.where}`,
      );
    } catch (error) {
      // Not being able to read the archive must not stop Cairn serving. It
      // does mean the first write will try a backup, which is the right way
      // round: it surfaces the problem rather than hiding it.
      this.lastAt = 0;
      this.options.log(
        `warning: could not read the backups in ${this.options.archive.where}: ${message(error)}. ` +
          "Cairn carries on, and will try to back up on the next write. Check that the folder or container exists and can be written to.",
      );
    }
  }

  /** True when a backup is due. Cheap enough to call on every request. */
  due(): boolean {
    if (this.lastAt === null) return false;
    return this.now() - this.lastAt >= this.policy.afterMs;
  }

  /**
   * Called after a write. Never awaited by the caller and never able to throw
   * into it: a backup is a background chore, and a write that succeeded must
   * not be reported as failed because a later copy of it did not.
   */
  afterWrite(): void {
    if (!this.due() || this.running !== null) return;
    // The interval is a setting, so say the setting rather than the default:
    // a message that states the wrong number is worse than a vaguer one.
    void this.run(`a write, and the last backup was over ${describeAge(this.policy.afterMs)} ago`).catch(() => {
      // run() already logged. Swallowing here keeps an unhandled rejection
      // from taking the process down over a backup.
    });
  }

  /** Back up now, whatever the age of the last one. Used at shutdown. */
  async backupNow(reason: string): Promise<BackupOutcome | null> {
    if (this.running !== null) return this.running;
    return this.run(reason);
  }

  private run(reason: string): Promise<BackupOutcome | null> {
    const attempt = this.attempt(reason).finally(() => {
      this.running = null;
    });
    this.running = attempt;
    return attempt;
  }

  private async attempt(reason: string): Promise<BackupOutcome | null> {
    const at = new Date(this.now());
    const name = backupName(at);
    const scratch = join(this.scratchDir, name);
    try {
      const { bytes, ms } = await this.options.source.snapshot(scratch);
      await this.options.archive.put(name, scratch);
      // Only once it is safely in the archive does the clock restart. A failed
      // backup must leave the next write still due, not wait three more hours.
      this.lastAt = at.getTime();
      const removed = await this.prune();
      this.options.log(
        `backed up ${name}, ${formatBytes(bytes)} in ${ms}ms, because of ${reason}` +
          (removed.length > 0 ? `; removed ${removed.length} past retention` : ""),
      );
      return { name, bytes, ms, removed };
    } catch (error) {
      this.options.log(
        `warning: the backup failed: ${message(error)}. ` +
          `Cairn carries on serving, and will try again on the next write. Backups go to ${this.options.archive.where}.`,
      );
      return null;
    } finally {
      await rm(scratch, { force: true }).catch(() => {});
    }
  }

  /** Apply retention. Failing to delete is never a reason to fail a backup. */
  private async prune(): Promise<string[]> {
    const removed: string[] = [];
    try {
      const held = await this.options.archive.list();
      for (const backup of expired(held, this.now(), this.policy)) {
        await this.options.archive.remove(backup.name);
        removed.push(backup.name);
      }
    } catch (error) {
      this.options.log(
        `warning: could not tidy old backups in ${this.options.archive.where}: ${message(error)}. ` +
          "The backup itself was written, so this costs storage rather than safety.",
      );
    }
    return removed;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeAge(ms: number): string {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 1) return plural(Math.max(1, Math.round(ms / 60000)), "minute");
  if (hours < 48) return plural(Math.round(hours), "hour");
  return plural(Math.round(hours / 24), "day");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
