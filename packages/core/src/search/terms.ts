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

/**
 * Generic English words that reverse the direction of whatever they sit next
 * to: negation ("not", "without") and decrease ("less", "reduced",
 * "suppress"). Not a domain lexicon (ADR-042): it knows no peptide, no drug,
 * no topic, only that these words flip a plain reading of the words after
 * them. "less hungry" is not "hungry", and a search should not credit it as
 * though it were.
 */
// Contractions ("isn't", "doesn't") are left out: `tokenize` splits them on
// the apostrophe into two tokens ("isn", "t"), and the fragment before it
// ("isn", "does", "can") is too short and common on its own to add as a
// negator without flagging plain, non-negated text.
const NEGATORS = new Set(
  [
    "not", "no", "never", "without", "non",
    "less", "least", "fewer", "lack", "lacks", "lacking",
    "reduce", "reduces", "reduced", "reducing",
    "decrease", "decreases", "decreased", "decreasing",
    "suppress", "suppresses", "suppressed", "suppressing",
    "minus", "rarely", "hardly", "barely",
  ],
);

/**
 * True when every occurrence of `term` in `text` sits within `window` words
 * of a negator (ADR-042): the term is only ever reached through a reversed
 * reading, such as "more than simply feeling less hungry" for the term
 * "hungry". False the moment one occurrence is plain, so a page that states
 * something both ways still gets credit for the plain statement.
 *
 * A word-for-word check, not a stemmed one: it catches the exact word a
 * query asked for, the same words `tokenize` would find, not every
 * inflection FTS5's stemmer would. That is enough for the direction words
 * this exists to catch, and simpler than duplicating SQLite's stemmer here.
 */
export function isNegatedEverywhere(text: string, term: string, window = 4): boolean {
  const tokens = tokenize(text);
  const needle = foldTerm(term);
  let found = false;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== needle) continue;
    found = true;
    const start = Math.max(0, i - window);
    if (!tokens.slice(start, i).some((word) => NEGATORS.has(word))) return false;
  }
  return found;
}
