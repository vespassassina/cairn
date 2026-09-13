import { rowNodeId } from "../ids.js";
import { relationTarget } from "../query/validate.js";
import type { Collection, EdgeInput, Id, Page, Row } from "../types.js";

/**
 * Link, mention and tag extraction. Pure functions over Markdown.
 *
 * Explicit over inferred (PRD principle 4): edges come from what the user
 * wrote. No model guesses at relationships in v1.
 */

/**
 * `[label](cairn:id)` and `[label](/pages/id)`. The id is a page, a
 * collection, or a row as `collection-id/row-id` (ADR-024).
 */
const MARKDOWN_LINK = /\[([^\]\n]*)\]\((?:cairn:|\/pages\/)([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?)\)/g;
/** `[[id]]` or `[[id|label]]`, with the same ids. */
const WIKI_LINK = /\[\[([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?)(?:\|([^\]\n]*))?\]\]/g;
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

/**
 * The links a row declares: one per value of each relation field, labelled
 * with the field's name. A relation to pages points at the page id; one to a
 * collection points at the row, as `collection-id/row-id` (ADR-024).
 */
export function extractRowReferences(collection: Collection, row: Row): EdgeInput[] {
  const source = rowNodeId(collection.id, row.id);
  const edges: EdgeInput[] = [];
  const seen = new Set<string>();
  for (const field of collection.fields) {
    if (field.type !== "relation") continue;
    const value = row.values[field.name];
    const ids = Array.isArray(value) ? value : typeof value === "string" && value !== "" ? [value] : [];
    const target = relationTarget(field);
    for (const id of ids) {
      const targetId = target === "pages" ? id : rowNodeId(target, id);
      // One edge per target: the store keys edges on source, target and type.
      if (targetId === source || seen.has(targetId)) continue;
      seen.add(targetId);
      edges.push({ sourceId: source, targetId, type: "relation", label: field.name });
    }
  }
  return edges;
}
