import type { EdgeInput, Id, Page } from "../types.js";

/**
 * Link, mention and tag extraction. Pure functions over Markdown.
 *
 * Explicit over inferred (PRD principle 4): edges come from what the user
 * wrote. No model guesses at relationships in v1.
 */

/** `[label](cairn:page-id)` and `[label](/pages/page-id)`. */
const MARKDOWN_LINK = /\[([^\]\n]*)\]\((?:cairn:|\/pages\/)([A-Za-z0-9_-]+)\)/g;
/** `[[page-id]]` or `[[page-id|label]]`. */
const WIKI_LINK = /\[\[([A-Za-z0-9_-]+)(?:\|([^\]\n]*))?\]\]/g;
/** `@page-id`, for a mention rather than a link. */
const MENTION = /(?:^|\s)@([A-Za-z0-9_-]+)/g;
/** `#tag`, not a Markdown heading (headings are `#` followed by a space). */
const INLINE_TAG = /(?:^|\s)#([A-Za-z0-9][A-Za-z0-9_-]*)/g;

/** Fenced and inline code, where a `#tag` or `[[link]]` means nothing. */
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

function withoutCode(markdown: string): string {
  // Replaced by spaces rather than removed, so offsets stay comparable.
  return markdown.replace(CODE, (block) => " ".repeat(block.length));
}

export interface ExtractedReferences {
  edges: EdgeInput[];
  tags: string[];
}

/**
 * Every edge a page declares: links and mentions to other pages, its parent,
 * and its tags. Deduplicated on source, target and type, so a page that links
 * to another twice produces one edge.
 */
export function extractReferences(page: Page): ExtractedReferences {
  const text = withoutCode(page.body);
  const edges: EdgeInput[] = [];
  const seen = new Set<string>();
  const tags = new Set<string>(page.tags);

  const add = (targetId: Id, type: EdgeInput["type"], label: string | null) => {
    if (targetId === page.id && type !== "tag") return;
    const key = `${type}:${targetId}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ sourceId: page.id, targetId, type, label });
  };

  if (page.parentId) add(page.parentId, "parent", null);

  for (const [, label, targetId] of text.matchAll(MARKDOWN_LINK)) {
    add(targetId!, "link", label || null);
  }
  for (const [, targetId, label] of text.matchAll(WIKI_LINK)) {
    add(targetId!, "link", label ?? null);
  }
  for (const [, targetId] of text.matchAll(MENTION)) {
    add(targetId!, "mention", null);
  }
  for (const [, tag] of text.matchAll(INLINE_TAG)) {
    tags.add(tag!);
  }

  // A tag edge points at the tag itself, so `get_neighbours` can walk to
  // everything sharing it without a separate index.
  for (const tag of tags) add(`tag:${tag}`, "tag", tag);

  return { edges, tags: [...tags] };
}
