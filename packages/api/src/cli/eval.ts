import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ConfigError, loadConfig, userPath } from "../config.js";
import type { SearchMode } from "@cairn/core";
import { closeContext, createContext, type AppContext } from "../context.js";

/**
 * The eval runner (PRD section 11, P1.6).
 *
 * recall@5 is the share of queries where at least one expected page appears in
 * the top 5. The number is reported per search backend, because BM25 scoring
 * differs between Cosmos, FTS5 and a JavaScript index (ADR-005).
 *
 * No search change merges without a before and after number (hard rule 7).
 *
 * A query marked `expected: none` has no answer in the workspace. It is scored
 * separately, as "no answer": right when search returns nothing. Recall alone
 * rewards returning something for everything (ADR-021).
 */

export interface EvalQuery {
  id: string;
  query: string;
  expected: string[];
  /** True for `expected: none`: the right result is no pages at all. */
  absent?: boolean;
  lang?: string;
  notes?: string;
}

export interface QueryResult {
  id: string;
  query: string;
  hit: boolean;
  absent: boolean;
  /** 1-based rank of the first expected page, or null if it never appeared. */
  rank: number | null;
  returned: string[];
}

export interface EvalReport {
  backend: string;
  mode: string;
  k: number;
  scored: number;
  unscored: number;
  recall: number;
  /** Queries with no answer, and how many of them returned nothing. */
  absent: number;
  absentEmpty: number;
  results: QueryResult[];
}

/**
 * A deliberately small YAML reader for the one shape `eval/queries.yaml` uses.
 * A parser dependency for six fields is not worth it, and this fails loudly on
 * anything it does not understand.
 */
export function parseQueries(yaml: string): EvalQuery[] {
  const queries: EvalQuery[] = [];
  let current: Partial<EvalQuery> | null = null;
  let inExpected = false;

  const push = () => {
    if (!current) return;
    if (!current.id || !current.query) {
      throw new Error(`eval query missing id or query: ${JSON.stringify(current)}`);
    }
    queries.push({ ...current, expected: current.expected ?? [] } as EvalQuery);
  };

  for (const raw of yaml.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (line.trim() === "queries:") continue;

    const item = /^\s*-\s+id:\s*(.+)$/.exec(line);
    if (item) {
      push();
      current = { id: unquote(item[1]!), expected: [] };
      inExpected = false;
      continue;
    }

    const expectedItem = /^\s*-\s+(.+)$/.exec(line);
    if (inExpected && expectedItem && current) {
      current.expected = [...(current.expected ?? []), unquote(expectedItem[1]!)];
      continue;
    }

    const field = /^\s*(\w+):\s*(.*)$/.exec(line);
    if (field && current) {
      const [, key, value] = field;
      inExpected = key === "expected";
      if (key === "expected") {
        current.absent = value!.trim() === "none";
        current.expected = value!.trim().startsWith("[")
          ? parseInlineList(value!)
          : [];
      } else if (key === "query" || key === "lang" || key === "notes") {
        current[key] = unquote(value!);
      }
    }
  }
  push();
  return queries;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  return /^".*"$|^'.*'$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function parseInlineList(value: string): string[] {
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  if (inner === "") return [];
  return inner.split(",").map((entry) => unquote(entry));
}

export async function runEval(
  context: AppContext,
  queries: EvalQuery[],
  k = 5,
  requested: SearchMode = "keyword",
): Promise<EvalReport> {
  const results: QueryResult[] = [];
  let scored = 0;
  let hits = 0;
  let absent = 0;
  let absentEmpty = 0;
  let mode = "keyword";

  for (const query of queries) {
    const result = await context.search.search(context.workspaceId, {
      query: query.query,
      limit: k,
      mode: requested,
    });
    mode = result.mode;

    // Results are grouped by page, because recall is about finding the page.
    const pages: string[] = [];
    for (const hit of result.hits) {
      if (!pages.includes(hit.pageId)) pages.push(hit.pageId);
    }

    if (query.absent) {
      absent += 1;
      if (pages.length === 0) absentEmpty += 1;
      results.push({ id: query.id, query: query.query, hit: pages.length === 0, absent: true, rank: null, returned: pages });
      continue;
    }

    // A query with no expected pages yet cannot be scored. It is reported
    // separately rather than counted as a miss, which would flatter or punish
    // the number for no reason.
    if (query.expected.length === 0) {
      results.push({ id: query.id, query: query.query, hit: false, absent: false, rank: null, returned: pages });
      continue;
    }

    scored += 1;
    const rank = pages.findIndex((pageId) => query.expected.includes(pageId));
    const hit = rank !== -1 && rank < k;
    if (hit) hits += 1;
    results.push({
      id: query.id,
      query: query.query,
      hit,
      absent: false,
      rank: rank === -1 ? null : rank + 1,
      returned: pages,
    });
  }

  return {
    backend: context.search.constructor.name,
    mode,
    k,
    scored,
    unscored: queries.length - scored - absent,
    recall: scored === 0 ? 0 : hits / scored,
    absent,
    absentEmpty,
    results,
  };
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`backend    ${report.backend}`);
  lines.push(`mode       ${report.mode}`);
  lines.push(`scored     ${report.scored} queries (${report.unscored} have no expected pages yet)`);
  lines.push(
    `recall@${report.k}   ${report.scored === 0 ? "n/a" : report.recall.toFixed(2)}`,
  );
  if (report.absent > 0) {
    lines.push(`no answer  ${report.absentEmpty} of ${report.absent} returned nothing, as they should`);
  }
  lines.push("");

  for (const result of report.results) {
    const status = result.absent
      ? result.hit ? "empty" : "noise"
      : result.rank === null ? (result.hit ? "?" : "-") : result.hit ? "hit" : "miss";
    const rank = result.rank ? ` (rank ${result.rank})` : "";
    lines.push(`${status.padEnd(5)} ${result.id}  ${result.query}${rank}`);
    if (!result.hit) {
      lines.push(`      returned: ${result.returned.slice(0, 5).join(", ") || "nothing"}`);
    }
  }

  if (report.unscored > 0) {
    lines.push("");
    lines.push(
      `${report.unscored} queries have no expected page ids. Fill them in eval/queries.yaml, ` +
        "using the page ids from the returned lists above, or the number means nothing.",
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const config = loadConfig();
  // The default set lives at the repo root, next to cairn.config.json.
  const path = process.argv[2]
    ? userPath(process.argv[2])
    : join(config.configFile ? dirname(config.configFile) : process.cwd(), "eval", "queries.yaml");
  const context = await createContext(config);
  try {
    const queries = parseQueries(await readFile(path, "utf8"));
    // Every chunk needs its vector before hybrid search is measured.
    await context.search.settled();
    process.stdout.write(`${formatReport(await runEval(context, queries, 5, "keyword"))}\n`);
    const status = context.search.status();
    if (status.vectors === "ready") {
      process.stdout.write(`\n${formatReport(await runEval(context, queries, 5, "hybrid"))}\n`);
    } else {
      process.stdout.write(`\nhybrid     not measured: semantic search is ${status.vectors}${status.detail ? ` (${status.detail})` : ""}\n`);
    }
  } finally {
    await closeContext(context);
  }
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`configuration error: ${error.message}\n`);
      process.exit(2);
    }
    throw error;
  });
}
