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

const URL_SOURCE = /^https?:\/\/\S+$/i;

/** A bare or `doi:`-prefixed DOI, such as `10.1038/s41586-021-03819-2`. */
const DOI_SOURCE = /^(?:doi:\s*)?(10\.\d{4,9}\/\S+)$/i;

/** A PubMed id, such as `PMID: 12345678` or `pmid:12345678`. */
const PMID_SOURCE = /^pmid:?\s*(\d+)$/i;

/** Whether a string reads as a web address, for showing it as a link. */
export function isUrlSource(source: string): boolean {
  return URL_SOURCE.test(source);
}

/**
 * The address to link to when a source names one directly: a web address as
 * is, a DOI or a PubMed id resolved to their canonical address. `null` for a
 * plain citation, such as "Smith 2021, J Pept Sci", which names no address to
 * follow (roadmap "Citations kept correct").
 */
export function sourceHref(source: string): string | null {
  if (URL_SOURCE.test(source)) return source;
  const doi = DOI_SOURCE.exec(source);
  if (doi) return `https://doi.org/${doi[1]}`;
  const pmid = PMID_SOURCE.exec(source);
  if (pmid) return `https://pubmed.ncbi.nlm.nih.gov/${pmid[1]}/`;
  return null;
}
