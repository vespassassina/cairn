import { ValidationError } from "./errors.js";
import { MAX_AHEAD_MS } from "./freshness.js";

/**
 * Edit times (ADR-030): when the content of a page or row last changed, at
 * the place it was changed, kept apart from `updatedAt`, which is when this
 * server stored the write.
 *
 * Sync copies a record with the time it was edited on the other server, so
 * `editedAt` stays the time of the edit however many hops it takes, while
 * `updatedAt` and the revision's time say when it arrived here. Sync orders
 * two edits of one record by it.
 *
 * Two rules keep the order:
 *
 * 1. This server's clock never repeats and never goes back: each time it
 *    hands out is at least a millisecond after the last.
 * 2. A record's new time is at least a millisecond after its previous one,
 *    so a later edit of the same record never looks older, even when the
 *    previous time came from a server whose clock runs ahead.
 */

let last = 0;

/**
 * The time for a write of one record.
 *
 * @param previous The record's current `editedAt`, or null for a new record.
 * @param given An exact time from sync or import. Left out, this server's
 *   clock decides.
 * @throws ValidationError when `given` is not a time, or is further ahead of
 *   this server's clock than skew explains.
 */
export function editTime(previous: string | null | undefined, given?: string): string {
  let time: number;
  if (given === undefined) {
    time = Math.max(Date.now(), last + 1);
    last = time;
  } else {
    time = Date.parse(given);
    if (Number.isNaN(time)) {
      throw new ValidationError([{ field: "edited_at", message: "an ISO 8601 time, such as 2026-09-14T08:00:00.123Z" }]);
    }
    if (time > Date.now() + MAX_AHEAD_MS) {
      throw new ValidationError([{ field: "edited_at", message: "cannot be in the future" }]);
    }
  }
  const before = previous ? Date.parse(previous) : Number.NaN;
  if (!Number.isNaN(before)) time = Math.max(time, before + 1);
  return new Date(time).toISOString();
}
