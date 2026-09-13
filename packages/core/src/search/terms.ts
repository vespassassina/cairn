/**
 * How a keyword query becomes search terms, and how many of them a page must
 * contain to count as a match. Every search backend applies these rules, so
 * the same query means the same thing on each (ADR-005, ADR-021).
 *
 * Why: matching any one word of a query made every question return pages,
 * including questions Cairn has no answer to. "which ESC firmware did I flash"
 * found peptide pages through "which" and "flash". An empty result is the
 * honest answer there, and it tells an agent to try other words.
 */

/**
 * Function words in English, Italian and Dutch, folded to plain ASCII. They
 * carry no topic, so they never count towards a match. Kept short on
 * purpose: a word wrongly listed here can never be searched for on its own
 * terms.
 */
const STOPWORDS = new Set(
  [
    // English
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my no not of on or our should so than that the their them then there these they this those to was we were what when where which who why will with would you your",
    // Italian
    "a ad al alla alle ai agli che chi ci come con cosa da dal dalla dei del della delle degli di dove e ed gli ha hanno il in la le lo ma mi nei nel nella non o per perche piu quando se si sono su sul sulla ti tra fra un una uno",
    // Dutch
    "aan bij dat de deze die dit door een en geen hebben heeft het hoe ik in is je jij met naar niet of om op over te u uit van voor waar waarom wat we wie wij zijn ze zij",
  ]
    .join(" ")
    .split(" "),
);

/**
 * Lower-case, and strip diacritics, the way FTS5's `unicode61` tokenizer
 * folds text, so a term compares equal to the stop-word lists.
 */
export function foldTerm(token: string): string {
  return token.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

/**
 * Split text into folded tokens: runs of letters and digits. The same
 * boundaries as FTS5's `unicode61`, so "GLP-1" is `glp` and `1`. A backend
 * that stems (SQLite does, ADR-021) stems these terms itself.
 */
export function tokenize(text: string): string[] {
  return text
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)
    .map(foldTerm);
}

/**
 * The distinct terms of a query, without function words. A query made only
 * of function words keeps them, so it still means something.
 */
export function queryTerms(query: string): string[] {
  const all = [...new Set(tokenize(query))];
  const content = all.filter((term) => !STOPWORDS.has(term));
  return content.length > 0 ? content : all;
}

/**
 * How many of a query's terms a page must contain: all of them for one or
 * two, more than half for more. Terms may be in different sections of the
 * page.
 */
export function requiredMatches(termCount: number): number {
  return termCount <= 2 ? termCount : Math.floor(termCount / 2) + 1;
}

/**
 * True when a query is a title's own words, ignoring case, accents and
 * punctuation: "bpc 157" is "BPC-157". A search for exactly a page's title is
 * a lookup by name, and that page ranks first in every backend, whatever
 * BM25 or the vectors say about other pages that mention it.
 */
export function sameWords(query: string, title: string): boolean {
  const words = tokenize(query);
  return words.length > 0 && words.join(" ") === tokenize(title).join(" ");
}
