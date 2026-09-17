/**
 * Token budgeting for MCP results (CLAUDE.md hard rule 6).
 *
 * Every tool truncates to a budget, says that it did, and returns a cursor.
 * A result that quietly fills the context window is worse than a short one:
 * Claude cannot tell what it is missing.
 */

/**
 * Rough characters-per-token ratio for English prose. Deliberately
 * conservative. An exact tokenizer would add a dependency and a model
 * assumption for a limit that only needs to be approximately right.
 */
const CHARS_PER_TOKEN = 4;

export const DEFAULT_TOKEN_BUDGET = 2_000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export interface BudgetedList<T> {
  items: T[];
  truncated: boolean;
  /** How many items were dropped, so the caller can say so. */
  dropped: number;
}

/**
 * Take items until the budget is spent. Always keeps at least one item: a
 * single oversized result is more useful than an empty list.
 */
export function budgetList<T>(
  items: T[],
  render: (item: T) => string,
  budgetTokens: number = DEFAULT_TOKEN_BUDGET,
): BudgetedList<T> {
  const kept: T[] = [];
  let spent = 0;

  for (const item of items) {
    const cost = estimateTokens(render(item));
    if (kept.length > 0 && spent + cost > budgetTokens) break;
    kept.push(item);
    spent += cost;
  }

  return {
    items: kept,
    truncated: kept.length < items.length,
    dropped: items.length - kept.length,
  };
}

/** The parts of a page-grouped search hit that `budgetPages` needs to know about. */
export interface PassagedPage {
  passages: Array<{ headingPath: string[]; snippet: string; score: number }>;
  morePassages: number;
}

export interface BudgetedPages<T> {
  pages: T[];
  truncated: boolean;
}

/**
 * Spends a token budget on distinct pages first, then on extra passages
 * (ADR-057 decision 5, hard rule 6): a page's second or third passage is
 * dropped before a whole page is, so truncation never sacrifices page count
 * for depth on an earlier-ranked page.
 *
 * `render` turns a page into the text that will actually be sent, so the
 * estimate matches what the caller renders; it is called once per candidate
 * passage count, so it must be cheap and pure.
 */
export function budgetPages<T extends PassagedPage>(
  pages: readonly T[],
  render: (page: T) => string,
  budgetTokens: number = DEFAULT_TOKEN_BUDGET,
): BudgetedPages<T> {
  const leadOnly = (page: T): T => ({
    ...page,
    passages: page.passages.slice(0, 1),
    morePassages: page.passages.length - 1 + page.morePassages,
  });

  // Phase 1: greedily fit as many pages as possible, each priced at only its
  // lead passage, so the budget is spent on distinct pages before depth.
  let included = 0;
  let spent = 0;
  for (const page of pages) {
    const cost = estimateTokens(render(leadOnly(page)));
    if (included > 0 && spent + cost > budgetTokens) break;
    spent += cost;
    included += 1;
  }
  const truncated = included < pages.length;
  const kept = pages.slice(0, included).map(leadOnly);

  // Phase 2: with the leftover budget, restore full passages to already
  // included pages, in rank order, so an earlier page gets its depth back
  // before a later one does.
  const result: T[] = [];
  for (let i = 0; i < kept.length; i++) {
    const original = pages[i]!;
    const leadCost = estimateTokens(render(kept[i]!));
    const fullCost = estimateTokens(render(original));
    if (spent + (fullCost - leadCost) <= budgetTokens) {
      result.push(original);
      spent += fullCost - leadCost;
    } else {
      result.push(kept[i]!);
    }
  }

  return { pages: result, truncated };
}

export interface BudgetedText {
  text: string;
  truncated: boolean;
  /** Character offset to resume from, for the next call. */
  nextOffset: number | null;
}

/** Cut long text at a paragraph or line boundary where one is close. */
export function budgetText(
  text: string,
  budgetTokens: number = DEFAULT_TOKEN_BUDGET,
  offset = 0,
): BudgetedText {
  const body = text.slice(offset);
  const maxChars = budgetTokens * CHARS_PER_TOKEN;
  if (body.length <= maxChars) {
    return { text: body, truncated: false, nextOffset: null };
  }

  const window = body.slice(0, maxChars);
  const breakAt = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
  const cut = breakAt > maxChars * 0.6 ? breakAt : maxChars;

  return {
    text: body.slice(0, cut),
    truncated: true,
    nextOffset: offset + cut,
  };
}
