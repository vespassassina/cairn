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

/**
 * Which published page, if any, gates reading `pageId` with a publish token
 * (ADR-066). A token is attached to the page it was issued on, and it gates
 * that page's whole subtree, so this walks upward from `pageId`, same shape
 * as `publishedIds`, and returns the nearest ancestor (or the page itself)
 * that carries an active token. `null` means the page needs no token.
 */
export function gateRootOf(pageId: Id, pages: readonly Page[], tokenPageIds: ReadonlySet<Id>): Page | null {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const seen = new Set<Id>();
  let current = byId.get(pageId);
  while (current && !seen.has(current.id)) {
    if (tokenPageIds.has(current.id)) return current;
    seen.add(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return null;
}

/** Every published page whose read requires a publish token (ADR-066). */
export function gatedIds(pages: readonly Page[], tokenPageIds: ReadonlySet<Id>): Set<Id> {
  const gated = new Set<Id>();
  for (const page of pages) {
    if (gateRootOf(page.id, pages, tokenPageIds)) gated.add(page.id);
  }
  return gated;
}
