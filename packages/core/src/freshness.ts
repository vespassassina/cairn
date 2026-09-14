import { ValidationError } from "./errors.js";

/**
 * Freshness (ADR-028): when a page's facts were last confirmed, kept apart
 * from when it was last edited. A fix to a typo is an edit; re-reading the
 * sources and finding the page still right is a verification.
 */

/** How far ahead of this server's clock a given time may be, for clock skew. */
const MAX_AHEAD_MS = 24 * 60 * 60 * 1000;

/**
 * A verification time as stored: an ISO 8601 timestamp in UTC, or null.
 *
 * @throws ValidationError when it is not a time, or is in the future.
 */
export function normalizeVerifiedAt(value: string | null, field = "verified_at"): string | null {
  if (value === null) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw new ValidationError([{ field, message: "an ISO 8601 time, such as 2026-09-14T08:00:00Z, or null" }]);
  }
  if (time > Date.now() + MAX_AHEAD_MS) {
    throw new ValidationError([{ field, message: "cannot be in the future" }]);
  }
  return new Date(time).toISOString();
}
