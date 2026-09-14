import { ValidationError } from "./errors.js";

/**
 * Sources (ADR-027): where a page's or a row's facts came from. Each one is
 * a short text, a URL or a citation such as "Smith 2021, J Pept Sci", and
 * the list belongs to the record, so it syncs and exports with the content.
 */

/** Longest single source, in characters. A citation, not a quote. */
export const MAX_SOURCE_LENGTH = 500;

/** Most sources one page or row can hold. */
export const MAX_SOURCES = 100;

/**
 * Trim, drop empty entries and repeats, and keep the first-seen order.
 *
 * @throws ValidationError when one is too long or there are too many.
 */
export function normalizeSources(sources: readonly string[], field = "sources"): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of sources) {
    const source = raw.replace(/\s+/g, " ").trim();
    if (source === "" || seen.has(source)) continue;
    if (source.length > MAX_SOURCE_LENGTH) {
      throw new ValidationError([
        { field, message: `a source is at most ${MAX_SOURCE_LENGTH} characters: cite it, do not quote it` },
      ]);
    }
    seen.add(source);
    out.push(source);
  }
  if (out.length > MAX_SOURCES) {
    throw new ValidationError([{ field, message: `at most ${MAX_SOURCES} sources on one record` }]);
  }
  return out;
}

/** The sources a record had, with new ones added at the end. */
export function addSources(existing: readonly string[], added: readonly string[] | undefined): string[] | undefined {
  return added === undefined || added.length === 0 ? undefined : normalizeSources([...existing, ...added]);
}

/** Whether a string reads as a web address, for showing it as a link. */
export function isUrlSource(source: string): boolean {
  return /^https?:\/\/\S+$/i.test(source);
}
