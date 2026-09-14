import type { Id, Page } from "./types.js";

/**
 * Which pages are published (ADR-032).
 *
 * A page is published if it is marked public, or if any page above it is:
 * marking a collection publishes the wiki beneath it. Nothing else publishes
 * a page, so a page whose ancestors are all private is private however it is
 * reached.
 *
 * A page whose parent is missing, or whose tree loops, is treated as private.
 * The safe answer to "I cannot tell" is always no.
 */
export function publishedIds(pages: readonly Page[]): Set<Id> {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const published = new Set<Id>();

  for (const page of pages) {
    const seen = new Set<Id>();
    let current: Page | undefined = page;
    while (current && !seen.has(current.id)) {
      if (current.public) {
        published.add(page.id);
        break;
      }
      seen.add(current.id);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }
  return published;
}

/** The published pages, in the order given. */
export function publishedPages(pages: readonly Page[]): Page[] {
  const published = publishedIds(pages);
  return pages.filter((page) => published.has(page.id));
}
