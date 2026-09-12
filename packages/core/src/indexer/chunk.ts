import type { ChunkInput, Page } from "../types.js";

/**
 * Chunking. Split on headings first, then on size, keeping the heading path so
 * search results can show where a match sits in a page.
 *
 * Sizes are a starting point, not a finding. PRD Q6 settles them against the
 * eval set, which is why they are parameters rather than constants in the
 * chunking logic.
 */
export interface ChunkOptions {
  /** Target characters per chunk. Roughly 250 tokens at the default. */
  maxChars: number;
  /** Characters repeated from the previous chunk, to keep context at seams. */
  overlapChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxChars: 1_000,
  overlapChars: 100,
};

const HEADING = /^(#{1,6})\s+(.*)$/;

interface Section {
  headingPath: string[];
  lines: string[];
}

function splitIntoSections(body: string): Section[] {
  const sections: Section[] = [];
  // Open headings, outermost first. A heading closes every open heading at
  // its own level or deeper, so siblings never nest, however the page starts.
  const open: Array<{ depth: number; title: string }> = [];
  let current: Section = { headingPath: [], lines: [] };

  for (const line of body.split("\n")) {
    const heading = HEADING.exec(line);
    if (!heading) {
      current.lines.push(line);
      continue;
    }
    if (current.lines.some((l) => l.trim() !== "")) sections.push(current);
    const depth = heading[1]!.length;
    while (open.length > 0 && open[open.length - 1]!.depth >= depth) open.pop();
    open.push({ depth, title: heading[2]!.trim() });
    current = { headingPath: open.map((h) => h.title), lines: [] };
  }
  if (current.lines.some((l) => l.trim() !== "")) sections.push(current);
  return sections;
}

/**
 * Split one section's text on paragraph boundaries where possible, falling
 * back to a hard cut for a single oversized paragraph.
 */
function splitBySize(text: string, options: ChunkOptions): string[] {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim() !== "");
  const parts: string[] = [];
  let buffer = "";

  const flush = () => {
    if (buffer.trim() !== "") parts.push(buffer.trim());
    buffer = "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > options.maxChars) {
      flush();
      for (let i = 0; i < paragraph.length; i += options.maxChars) {
        parts.push(paragraph.slice(i, i + options.maxChars).trim());
      }
      continue;
    }
    if (buffer.length + paragraph.length + 2 > options.maxChars) flush();
    buffer = buffer === "" ? paragraph : `${buffer}\n\n${paragraph}`;
  }
  flush();

  if (options.overlapChars <= 0) return parts;
  return parts.map((part, i) => {
    if (i === 0) return part;
    const previous = parts[i - 1]!;
    return `${previous.slice(-options.overlapChars)} ${part}`;
  });
}

/**
 * Chunks for one page, in document order. The page title leads the heading
 * path of every chunk so a title-only match still has somewhere to sit.
 *
 * Ids are derived from the page id and ordinal, not random, so re-chunking
 * unchanged content produces identical ids and the rebuild stays idempotent
 * (ADR-005 rule 2).
 */
export function chunkPage(
  page: Page,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): ChunkInput[] {
  const chunks: ChunkInput[] = [];

  for (const section of splitIntoSections(page.body)) {
    const text = section.lines.join("\n").trim();
    if (text === "") continue;
    // A Markdown file that opens with an H1 matching its title would otherwise
    // repeat it in every heading path.
    const headingPath =
      section.headingPath[0]?.trim().toLowerCase() === page.title.trim().toLowerCase()
        ? section.headingPath
        : [page.title, ...section.headingPath];

    for (const part of splitBySize(text, options)) {
      chunks.push({
        id: `${page.id}:${chunks.length}`,
        pageId: page.id,
        headingPath,
        text: part,
        ordinal: chunks.length,
      });
    }
  }

  // A page with a title and no body is still findable by title.
  if (chunks.length === 0) {
    chunks.push({
      id: `${page.id}:0`,
      pageId: page.id,
      headingPath: [page.title],
      text: page.title,
      ordinal: 0,
    });
  }

  return chunks;
}
