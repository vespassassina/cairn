import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where backups are kept (ADR-049).
 *
 * Deliberately small, and deliberately not the same place as the Litestream
 * replica. A replica and a backup fail differently: the replica is one copy of
 * one state, kept current, and it will hand back whatever it was given
 * including damage. The backups are several copies of several states, each one
 * read back before it was accepted. Keeping them in one container would let a
 * single wrong credential, a single mistaken deletion or a single bad write
 * take both.
 */

export interface Backup {
  /** Its name in the archive. Names sort oldest first, as strings. */
  name: string;
  /** When it was taken, read from the name rather than from file metadata. */
  at: Date;
  bytes: number;
}

export interface Archive {
  /** Every backup held, oldest first. */
  list(): Promise<Backup[]>;
  /** Take the local file at `path` into the archive under `name`. */
  put(name: string, path: string): Promise<void>;
  /** Write the backup `name` out to the local path `destination`. */
  get(name: string, destination: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** Said in messages, so a person is told where to look. */
  readonly where: string;
}

const PREFIX = "cairn-";
const SUFFIX = ".sqlite";

/**
 * A name that sorts chronologically and reads as a date, so `ls` is already
 * sorted and a person can see at a glance what they are looking at.
 * `cairn-2026-09-16T14-22-05Z.sqlite`.
 */
export function backupName(at: Date): string {
  const stamp = at.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  return `${PREFIX}${stamp}${SUFFIX}`;
}

/** The time in a backup's name, or null if the name is not one of ours. */
export function backupTime(name: string): Date | null {
  if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) return null;
  const stamp = name.slice(PREFIX.length, -SUFFIX.length);
  // Undo the colon substitution that made the name safe for every filesystem.
  const iso = stamp.replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, "T$1:$2:$3Z");
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Backups in a folder: a mounted volume on your own server, where the disk
 * outlives the container (ADR-020). On a platform whose disk does not, this is
 * not enough on its own and the blob archive is what to use.
 */
export class FolderArchive implements Archive {
  readonly where: string;

  constructor(private readonly dir: string) {
    this.where = dir;
  }

  async list(): Promise<Backup[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      // Nothing has been backed up yet. That is a fact, not a failure: the
      // first backup creates the folder.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const found: Backup[] = [];
    for (const name of names) {
      const at = backupTime(name);
      // Anything else in the folder belongs to someone else. Leave it alone,
      // and in particular never count it towards retention or delete it.
      if (at === null) continue;
      const { size } = await stat(join(this.dir, name));
      found.push({ name, at, bytes: size });
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  async put(name: string, path: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    // Copy aside and rename into place, so a backup never appears in the
    // listing until all of its bytes are there. A half-written file that
    // looks like a backup is the failure this design exists to avoid.
    const partial = join(this.dir, `${name}.partial`);
    await copyFile(path, partial);
    await rename(partial, join(this.dir, name));
  }

  async get(name: string, destination: string): Promise<void> {
    await copyFile(join(this.dir, name), destination);
  }

  async remove(name: string): Promise<void> {
    await rm(join(this.dir, name), { force: true });
  }
}
