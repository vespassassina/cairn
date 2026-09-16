/**
 * The two things Cairn has to read out of Litestream's own output (ADR-051).
 *
 * Kept apart from the entry point so both can be tested without a litestream
 * binary, and apart from the ladder so the ladder stays free of any knowledge
 * of which replication tool is underneath it.
 */

/**
 * Whether a failed restore is worth trying again.
 *
 * Retrying helps for a network error, or for a role that Azure has granted but
 * not yet propagated, which on a first deploy can take a minute. It never helps
 * for damage: retrying that only burns the container's restarts and buries the
 * reason under identical failures (ADR-046).
 */
export function isPermanent(text: string): boolean {
  return /decode|corrupt|malformed|checksum|EOF/i.test(text);
}

/**
 * Every RFC3339 timestamp `litestream ltx` printed, newest first.
 *
 * Deliberately loose: it takes timestamps from anywhere in the output rather
 * than depending on a column order, because the point is to have moments to try
 * and a wrong guess costs one failed restore, while a parser tied to a layout
 * costs the whole rung the first time the layout changes.
 */
export function momentsIn(text: string): string[] {
  const found = new Set<string>();
  for (const [stamp] of text.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g)) {
    found.add(stamp);
  }
  return [...found].sort().reverse();
}
