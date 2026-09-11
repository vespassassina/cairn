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
