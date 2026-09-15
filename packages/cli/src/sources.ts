/**
 * Recognising a source as a link (roadmap "Citations kept correct").
 *
 * Duplicated from `packages/core/src/sources.ts`'s `sourceHref`, not
 * imported: hard rule 16 keeps the CLI's runtime dependencies to `fetch`,
 * Web Crypto and a short list of `node:` modules, so `@cairn/core` cannot be
 * a runtime import here even though the CLI already depends on it for tests.
 * Kept in step with core by `packages/cli/test/sources.test.ts`, which runs
 * the same cases against both.
 */

const URL_SOURCE = /^https?:\/\/\S+$/i;

/** A bare or `doi:`-prefixed DOI, such as `10.1038/s41586-021-03819-2`. */
const DOI_SOURCE = /^(?:doi:\s*)?(10\.\d{4,9}\/\S+)$/i;

/** A PubMed id, such as `PMID: 12345678` or `pmid:12345678`. */
const PMID_SOURCE = /^pmid:?\s*(\d+)$/i;

/**
 * The address to link to when a source names one directly: a web address as
 * is, a DOI or a PubMed id resolved to their canonical address. `null` for a
 * plain citation, such as "Smith 2021, J Pept Sci", which names no address to
 * follow.
 */
export function sourceHref(source: string): string | null {
  if (URL_SOURCE.test(source)) return source;
  const doi = DOI_SOURCE.exec(source);
  if (doi) return `https://doi.org/${doi[1]}`;
  const pmid = PMID_SOURCE.exec(source);
  if (pmid) return `https://pubmed.ncbi.nlm.nih.gov/${pmid[1]}/`;
  return null;
}

/** The shape ADR-038 gives every Cairn's published page: `<origin>/w/<id>`. */
const CAIRN_PAGE_ADDRESS = /^https?:\/\/[^\s/]+\/w\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?$/i;

/**
 * Whether a resolved address is shaped like another Cairn's published page,
 * rather than an ordinary citation (ADR-039). Duplicated from
 * `packages/core/src/sources.ts` for the same reason `sourceHref` is above.
 */
export function isCairnPageAddress(address: string): boolean {
  return CAIRN_PAGE_ADDRESS.test(address);
}
