/**
 * The Cairn export format, version 2 (ADR-016; version 2 is ADR-026).
 *
 * A folder anyone can read without Cairn, and that `cairn import` can read
 * back without losing anything that matters:
 *
 *   cairn-export.json          manifest: format, version, when, what
 *   pages/<slug>.md            one page: a small front matter, then its Markdown
 *   pages/<slug>/<child>.md    its children, so folders mirror the page tree
 *   tables/<slug>.json         one table: schema and rows
 *
 * Version 1 differed only in names: the folder was `collections/` and the
 * manifest counted `collections`. `cairn import` reads both.
 *
 * Sources (ADR-027) are a `sources` line in a page's front matter and a
 * `sources` list on a row, written only when there are some. Readers ignore
 * keys they do not know, so this needed no new version. A page's verification
 * time (ADR-028) is a `verified` line, the same way, only when it has one.
 *
 * Ids travel in the front matter, not the file name, so links survive an
 * import and files can be renamed freely. Derived data (links, search chunks)
 * is not exported; an import rebuilds it.
 *
 * Pure functions only: no file access, so both directions are easy to test.
 */

export const FORMAT = "cairn-export";
export const FORMAT_VERSION = 2;

/** Where an export of this format version keeps its tables. */
export function tablesFolder(version: number): string {
  return version >= 2 ? "tables" : "collections";
}
export const MANIFEST = "cairn-export.json";

/** What an export carries. Not `public`: publication stays on the server it was set on (ADR-032). */
export interface ExportPage {
  id: string;
  title: string;
  parent_id: string | null;
  tags: string[];
  body: string;
  /** Where its facts came from (ADR-027). Absent when there are none. */
  sources?: string[];
  /** When its facts were last confirmed (ADR-028). Absent or null when never. */
  verified_at?: string | null;
  /**
   * The owner's mark (ADR-078). Absent when neutral. `approval_version` is
   * not carried: it names a revision of the exporting server, and an import
   * points the mark at the page it writes.
   */
  approval?: "approved" | "neutral" | "disapproved";
  approval_at?: string | null;
  approval_previous?: "approved" | "disapproved" | null;
  updated_at?: string;
  updated_by?: { kind: string; name: string };
  version?: string;
}

export interface ExportTable {
  id: string;
  name: string;
  /** The page it sits under (ADR-024). Absent in exports made before it existed. */
  parent_id?: string | null;
  /** One short line (ADR-058). Absent in exports made before it existed. */
  description?: string | null;
  fields: unknown[];
  rows: Array<{ id: string; values: Record<string, unknown>; sources?: string[] }>;
}

export interface Manifest {
  format: typeof FORMAT;
  version: number;
  exported_at: string;
  source: string;
  root: string | null;
  counts: { pages: number; tables: number; rows: number };
}

// File names.

/** Names Windows refuses for a file, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** A readable, portable file name from a title: lower case, dashes, bounded. */
export function slugify(title: string, fallback: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "") // drop accents left by NFKD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  if (slug === "" || RESERVED.test(slug)) return fallback.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return slug;
}

/** The slug, else the slug and the id, else those with a counter: never a clash. */
function freeName(slug: string, id: string, isTaken: (name: string) => boolean): string {
  if (!isTaken(slug)) return slug;
  const withId = `${slug}-${slugify(id, id)}`;
  if (!isTaken(withId)) return withId;
  let n = 2;
  while (isTaken(`${withId}-${n}`)) n += 1;
  return `${withId}-${n}`;
}

/**
 * A relative path for every page, parents' folders holding their children.
 * Two siblings with the same title get their id appended, so no file is
 * overwritten. Pages must come parents first, as the export endpoint sends them.
 */
export function assignPaths(pages: ExportPage[]): Map<string, string> {
  const paths = new Map<string, string>();
  const folderOf = new Map<string, string>();
  const taken = new Set<string>();

  for (const page of pages) {
    const parentFolder = page.parent_id !== null ? folderOf.get(page.parent_id) : undefined;
    const base = parentFolder ?? "pages";
    const name = freeName(slugify(page.title, page.id), page.id, (candidate) => taken.has(`${base}/${candidate}`));
    taken.add(`${base}/${name}`);
    paths.set(page.id, `${base}/${name}.md`);
    folderOf.set(page.id, `${base}/${name}`);
  }
  return paths;
}

export function tablePath(table: { id: string; name: string }, taken: Set<string>): string {
  const name = freeName(slugify(table.name, table.id), table.id, (candidate) => taken.has(candidate));
  taken.add(name);
  return `tables/${name}.json`;
}

// Front matter. A strict subset of YAML: one `key: value` per line, values
// written as JSON, so any title or tag round-trips exactly and the result
// still reads as ordinary front matter in Obsidian and on GitHub.

export function pageFile(page: ExportPage): string {
  const header: Array<[string, unknown]> = [
    ["id", page.id],
    ["title", page.title],
    ["parent", page.parent_id],
    ["tags", page.tags],
  ];
  if (page.sources && page.sources.length > 0) header.push(["sources", page.sources]);
  if (page.verified_at) header.push(["verified", page.verified_at]);
  if (page.approval && page.approval !== "neutral") {
    header.push(["approval", page.approval]);
    if (page.approval_at) header.push(["approval_at", page.approval_at]);
  } else if (page.approval_previous) {
    header.push(["approval_previous", page.approval_previous]);
  }
  if (page.updated_at) header.push(["updated", page.updated_at]);
  if (page.updated_by) header.push(["updated_by", `${page.updated_by.kind}: ${page.updated_by.name}`]);
  if (page.version) header.push(["version", page.version]);
  const lines = header.map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  // Always exactly one newline after the body, which parsePageFile removes.
  return `---\n${lines.join("\n")}\n---\n\n${page.body}\n`;
}

/** The inverse of pageFile. Throws with the file's problem, never guesses. */
export function parsePageFile(text: string, file: string): ExportPage {
  const normalised = text.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(normalised);
  if (!match) throw new Error(`${file}: no front matter. An exported page starts with a --- block.`);
  const fields = new Map<string, unknown>();
  for (const line of match[1]!.split("\n")) {
    if (line.trim() === "") continue;
    const at = line.indexOf(":");
    if (at <= 0) throw new Error(`${file}: cannot read front matter line "${line}"`);
    const key = line.slice(0, at).trim();
    const raw = line.slice(at + 1).trim();
    try {
      fields.set(key, JSON.parse(raw));
    } catch {
      fields.set(key, raw); // Hand-edited plain text, such as title: My page.
    }
  }

  const id = fields.get("id");
  const title = fields.get("title");
  if (typeof id !== "string" || id === "") throw new Error(`${file}: front matter has no id`);
  if (typeof title !== "string" || title === "") throw new Error(`${file}: front matter has no title`);
  const parent = fields.get("parent");
  const tags = fields.get("tags");
  const sources = fields.get("sources");
  const verified = fields.get("verified");
  const approval = fields.get("approval");
  const approvalAt = fields.get("approval_at");
  const approvalPrevious = fields.get("approval_previous");
  if (approval !== undefined && approval !== "approved" && approval !== "neutral" && approval !== "disapproved") {
    throw new Error(`${file}: approval is "${String(approval)}"; it must be approved, neutral or disapproved`);
  }
  if (approvalPrevious !== undefined && approvalPrevious !== "approved" && approvalPrevious !== "disapproved") {
    throw new Error(`${file}: approval_previous is "${String(approvalPrevious)}"; it must be approved or disapproved`);
  }
  const body = match[2]!;

  return {
    id,
    title,
    parent_id: typeof parent === "string" && parent !== "" ? parent : null,
    tags: Array.isArray(tags) ? tags.map(String) : [],
    ...(Array.isArray(sources) && sources.length > 0 ? { sources: sources.map(String) } : {}),
    ...(typeof verified === "string" && verified !== "" ? { verified_at: verified } : {}),
    ...(approval === "approved" || approval === "disapproved"
      ? { approval, approval_at: typeof approvalAt === "string" && approvalAt !== "" ? approvalAt : null }
      : approvalPrevious !== undefined
        ? { approval: "neutral" as const, approval_previous: approvalPrevious }
        : {}),
    // pageFile ends every body with one newline; give back what was stored.
    body: body.endsWith("\n") ? body.slice(0, -1) : body,
  };
}

/** Parents before children, and pages whose parent is missing last-resort top level. */
export function orderForImport(pages: ExportPage[]): ExportPage[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const ordered: ExportPage[] = [];
  const done = new Set<string>();
  const visit = (page: ExportPage, trail: Set<string>) => {
    if (done.has(page.id) || trail.has(page.id)) return;
    trail.add(page.id);
    const parent = page.parent_id !== null ? byId.get(page.parent_id) : undefined;
    if (parent) visit(parent, trail);
    done.add(page.id);
    ordered.push(page);
  };
  for (const page of pages) visit(page, new Set());
  return ordered;
}

/**
 * Tables in an order that creates each one after the tables its
 * relation fields point at, since a relation to a table that does not
 * exist yet is refused (ADR-024). A cycle keeps the order it was given.
 */
export function orderTables<T extends { id: string; fields: unknown[] }>(tables: T[]): T[] {
  const byId = new Map(tables.map((table) => [table.id, table]));
  const ordered: T[] = [];
  const done = new Set<string>();
  const visit = (table: T, trail: Set<string>) => {
    if (done.has(table.id) || trail.has(table.id)) return;
    trail.add(table.id);
    for (const field of table.fields as Array<{ type?: unknown; target?: unknown }>) {
      if (field.type !== "relation" || typeof field.target !== "string") continue;
      const target = byId.get(field.target);
      if (target && target.id !== table.id) visit(target, trail);
    }
    done.add(table.id);
    ordered.push(table);
  };
  for (const table of tables) visit(table, new Set());
  return ordered;
}
