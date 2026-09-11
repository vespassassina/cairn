import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { ConfigError, loadConfig } from "../config.js";
import { closeContext, createContext, type AppContext } from "../context.js";

/**
 * Import a folder of Markdown, one page per file, with the folder tree
 * becoming the page hierarchy.
 *
 * Search quality only means something against real content, so this exists to
 * get real notes in before any tuning. It is also the shape the eventual
 * import from Obsidian and Notion will take (PRD P2.5).
 *
 * Re-running it updates the pages it created rather than duplicating them: the
 * page id is derived from the file's path, so the import is idempotent.
 */

const MARKDOWN = new Set([".md", ".markdown", ".mdx"]);
const SKIP_DIRS = new Set([".git", "node_modules", ".obsidian", ".trash"]);

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  folders: number;
}

/** A stable, readable id derived from the path, so re-import updates in place. */
export function pageIdForPath(relativePath: string): string {
  const slug = relativePath
    .replace(/\.(md|markdown|mdx)$/i, "")
    .split(sep)
    .join("/")
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\//g, "__")
    .slice(0, 80);
  return `pg_${slug || "untitled"}`;
}

/** First `# heading` if the file starts with one, otherwise the file name. */
export function titleFor(markdown: string, filePath: string): string {
  const firstHeading = /^#\s+(.+)$/m.exec(markdown.split("\n").slice(0, 5).join("\n"));
  return firstHeading?.[1]?.trim() || basename(filePath, extname(filePath));
}

async function* walk(root: string, current: string): AsyncIterable<string> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      yield* walk(root, path);
    } else if (MARKDOWN.has(extname(entry.name).toLowerCase())) {
      yield path;
    }
  }
}

export async function importFolder(
  context: AppContext,
  root: string,
  options: { onProgress?: (message: string) => void } = {},
): Promise<ImportResult> {
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, folders: 0 };
  const ws = context.workspaceId;
  const folderPages = new Map<string, string>();

  /** Create a page per folder, so the hierarchy survives the import. */
  const folderPageId = async (relativeDir: string): Promise<string | null> => {
    if (relativeDir === "" || relativeDir === ".") return null;
    const cached = folderPages.get(relativeDir);
    if (cached) return cached;

    const parentDir = relativeDir.split(sep).slice(0, -1).join(sep);
    const parentId = await folderPageId(parentDir);
    const id = pageIdForPath(`${relativeDir}/__folder`);
    const existing = await context.store.getPage(ws, id);
    const input = {
      title: basename(relativeDir),
      body: "",
      parentId,
      tags: [],
    };
    if (existing) {
      await context.pages.update(ws, id, input, existing.version);
    } else {
      await context.pages.create(ws, input, id);
      result.folders += 1;
    }
    folderPages.set(relativeDir, id);
    return id;
  };

  for await (const filePath of walk(root, root)) {
    const relativePath = relative(root, filePath);
    const body = await readFile(filePath, "utf8");
    if (body.trim() === "") {
      result.skipped += 1;
      continue;
    }

    const id = pageIdForPath(relativePath);
    const parentId = await folderPageId(relativePath.split(sep).slice(0, -1).join(sep));
    const input = {
      title: titleFor(body, filePath),
      body,
      parentId,
      tags: [],
    };

    const existing = await context.store.getPage(ws, id);
    if (existing) {
      await context.pages.update(ws, id, input, existing.version);
      result.updated += 1;
    } else {
      await context.pages.create(ws, input, id);
      result.created += 1;
    }
    options.onProgress?.(`${existing ? "updated" : "created"} ${id}  ${relativePath}`);
  }

  return result;
}

async function main(): Promise<void> {
  const folder = process.argv[2];
  if (!folder) {
    process.stderr.write("usage: pnpm import <folder-of-markdown>\n");
    process.exit(2);
  }
  const info = await stat(folder).catch(() => null);
  if (!info?.isDirectory()) {
    process.stderr.write(`not a folder: ${folder}\n`);
    process.exit(2);
  }

  const config = loadConfig();
  const context = await createContext(config);
  try {
    const result = await importFolder(context, folder, {
      onProgress: (message) => process.stdout.write(`${message}\n`),
    });
    process.stdout.write(
      `\nimported into ${config.database}\n` +
        `  created ${result.created}\n` +
        `  updated ${result.updated}\n` +
        `  folders ${result.folders}\n` +
        `  skipped ${result.skipped} (empty)\n`,
    );
  } finally {
    await closeContext(context);
  }
}

// Only run when invoked directly, so the functions above stay importable.
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`configuration error: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  });
}
