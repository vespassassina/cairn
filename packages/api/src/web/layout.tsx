/** @jsxImportSource hono/jsx */
import type { Child, FC } from "hono/jsx";
import { raw } from "hono/html";
import type { Actor, Diff, DiffLine } from "@cairn/core";
import { ASSET_VERSION, documentTitle, HEAD_TAGS } from "./assets.js";

/**
 * Shared pieces of the review console (ADR-009). artifactkit classes for
 * everything it has a component for, `cairn-*` only for what it does not.
 */

export type Section = "collections" | "recent" | "tables" | "freshness" | "review" | "inbox" | "settings" | "search" | "none";

/** The facts fault 8 (ADR-056/057) puts in the console footer. */
export interface FooterFacts {
  instance: string;
  pageCount: number;
  /** Epoch ms of the newest backup, 0 if none exists yet, or null if unknown/off. */
  lastBackupAt: number | null;
}

/**
 * A single provider for the footer facts, set once by `registerConsole`.
 *
 * A prop would have to thread through all 21 call sites that build a
 * `<Layout>` in console.tsx. Exactly one console runs per process, and tests
 * run their `it()` blocks sequentially, so a module-level singleton carries
 * the same value a prop would, without touching every call site for one
 * footer line (ADR-056/057 fault 8).
 */
let footerFactsProvider: (() => Promise<FooterFacts>) | null = null;

export function setFooterFactsProvider(provider: () => Promise<FooterFacts>): void {
  footerFactsProvider = provider;
}

function backupLine(lastBackupAt: number | null): string {
  if (lastBackupAt === null) return "backup status unknown";
  if (lastBackupAt === 0) return "no backup yet";
  return `last backup ${ageOf(new Date(lastBackupAt).toISOString())}`;
}

export const Layout: FC<{
  title: string;
  section: Section;
  query?: string;
  /**
   * The page being looked at, if any. "New page" then starts under it, which
   * is where someone reading a page almost always wants the next one.
   */
  here?: string | null;
  children: Child;
}> = async ({ title, section, query, here, children }) => {
  const facts = footerFactsProvider ? await footerFactsProvider() : null;
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        {raw(HEAD_TAGS)}
        <title>{documentTitle(title)}</title>
        <link rel="stylesheet" href={`/assets/console.css?v=${ASSET_VERSION}`} />
      </head>
      <body>
        <div class="ak-wrap">
          <header class="cairn-top">
            <a class="cairn-brand" href="/">
              Cairn
            </a>
            <nav aria-label="Sections">
              <a href="/" aria-current={section === "collections" ? "page" : undefined}>
                Collections
              </a>
              <a href="/changes" aria-current={section === "recent" ? "page" : undefined}>
                Recent changes
              </a>
              <a href="/t" aria-current={section === "tables" ? "page" : undefined}>
                Tables
              </a>
              <a href="/freshness" aria-current={section === "freshness" ? "page" : undefined}>
                Freshness
              </a>
              <a href="/review" aria-current={section === "review" ? "page" : undefined}>
                Review
              </a>
              <a href="/inbox" aria-current={section === "inbox" ? "page" : undefined}>
                Inbox
              </a>
            </nav>
            <form action="/search" method="get" role="search">
              <input
                class="ak-input"
                type="search"
                name="q"
                id="q"
                value={query ?? ""}
                placeholder="Search pages   /"
                aria-label="Search pages"
              />
              <a class="ak-btn" href={here ? `/new?parent=${encodeURIComponent(here)}` : "/new"}>
                New page
              </a>
            </form>
          </header>
          <main>{children}</main>
          <footer class="ak-footer">
            <p>
              Every change is kept and can be restored. Agents write directly; this is where you
              review what they wrote.
            </p>
            {facts ? (
              <p class="ak-small">
                {facts.instance} · {facts.pageCount} page{facts.pageCount === 1 ? "" : "s"} ·{" "}
                {backupLine(facts.lastBackupAt)}
              </p>
            ) : null}
          </footer>
        </div>
        <script src={`/assets/console.js?v=${ASSET_VERSION}`} defer></script>
      </body>
    </html>
  );
};

/** Who made a change, in words as well as colour. */
export const ActorPill: FC<{ actor: Actor }> = ({ actor }) =>
  actor.kind === "agent" ? (
    <span>
      <span class="ak-pill ak-pill-info">agent</span>{" "}
      <span class="ak-small">{actor.label}</span>
    </span>
  ) : (
    <span>
      <span class="ak-pill ak-pill-off">person</span>{" "}
      <span class="ak-small">{actor.label}</span>
    </span>
  );

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export const When: FC<{ at: string }> = ({ at }) => (
  <time datetime={at}>{DATE.format(new Date(at))}</time>
);

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long ago, in words: "today", "5 days ago", "3 months ago". */
export function ageOf(at: string, now: number = Date.now()): string {
  const days = Math.floor((now - Date.parse(at)) / DAY_MS);
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  if (days < 730) return `${Math.floor(days / 30.44)} months ago`;
  return `${Math.floor(days / 365.25)} years ago`;
}

/** When a page's facts were last confirmed (ADR-028), or that they never were. */
export const Verified: FC<{ at: string | null }> = ({ at }) =>
  at === null ? (
    <span class="cairn-unverified">Never verified</span>
  ) : (
    <span>
      Verified{" "}
      <time datetime={at} title={DATE.format(new Date(at))}>
        {ageOf(at)}
      </time>
    </span>
  );

/**
 * A diff with a little context around each change. Every line carries a
 * prefix, so the change reads without colour.
 */
/**
 * The lines worth showing: every changed line with `context` lines around
 * it, as runs. A gap between runs is folded. Shared by the inline and the
 * side-by-side views, so the two always show the same lines.
 */
function foldedRuns(diff: Diff, context: number): DiffLine[][] {
  const keep = new Set<number>();
  diff.lines.forEach((line, i) => {
    if (line.op === "equal") return;
    for (
      let j = Math.max(0, i - context);
      j <= Math.min(diff.lines.length - 1, i + context);
      j += 1
    ) {
      keep.add(j);
    }
  });
  const runs: DiffLine[][] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (last === -1 || i > last + 1) runs.push([]);
    runs[runs.length - 1]!.push(diff.lines[i]!);
    last = i;
  }
  return runs;
}

const DiffSummary: FC<{ diff: Diff }> = ({ diff }) => (
  <p class="ak-small">
    {diff.added} added, {diff.removed} removed
    {diff.coarse ? " (too large to compare line by line)" : ""}
  </p>
);

const prefixOf = (op: DiffLine["op"]) => (op === "add" ? "+ " : op === "remove" ? "- " : "  ");
const classOf = (op: DiffLine["op"]) => (op === "add" ? "cairn-add" : op === "remove" ? "cairn-del" : "");

export const DiffView: FC<{ diff: Diff; context?: number }> = ({ diff, context = 3 }) => {
  if (diff.added === 0 && diff.removed === 0) {
    return <p class="ak-small">No change to the text.</p>;
  }
  const rows: Child[] = [];
  foldedRuns(diff, context).forEach((run, n) => {
    if (n > 0) rows.push(<div class="cairn-gap">…</div>);
    for (const line of run) rows.push(<div class={classOf(line.op)}>{prefixOf(line.op) + line.text}</div>);
  });

  return (
    <div>
      <DiffSummary diff={diff} />
      <div class="cairn-diff" role="region" aria-label="Changes">
        {rows}
      </div>
    </div>
  );
};

/**
 * The same diff as two columns (ADR-078): the older text left, the newer
 * right. Inside a run, each stretch of removed lines is paired row by row
 * with the added lines that follow it, so a changed line sits beside its
 * replacement; the longer side's extra lines face an empty cell. Same
 * folding as DiffView, so both views show the same lines. CSS grid, no
 * script; the stylesheet stacks the columns on a phone.
 */
export const SideBySideDiff: FC<{ diff: Diff; context?: number }> = ({ diff, context = 3 }) => {
  if (diff.added === 0 && diff.removed === 0) {
    return <p class="ak-small">No change to the text.</p>;
  }
  const rows: Child[] = [];
  const row = (left: DiffLine | null, right: DiffLine | null) =>
    rows.push(
      <div class="cairn-side-row">
        {left ? <div class={classOf(left.op)}>{prefixOf(left.op) + left.text}</div> : <div class="cairn-side-empty"></div>}
        {right ? <div class={classOf(right.op)}>{prefixOf(right.op) + right.text}</div> : <div class="cairn-side-empty"></div>}
      </div>,
    );
  foldedRuns(diff, context).forEach((run, n) => {
    if (n > 0) rows.push(<div class="cairn-gap">…</div>);
    let i = 0;
    while (i < run.length) {
      const line = run[i]!;
      if (line.op === "equal") {
        row(line, line);
        i += 1;
        continue;
      }
      const removed: DiffLine[] = [];
      const added: DiffLine[] = [];
      while (i < run.length && run[i]!.op === "remove") removed.push(run[i++]!);
      while (i < run.length && run[i]!.op === "add") added.push(run[i++]!);
      for (let k = 0; k < Math.max(removed.length, added.length); k += 1) row(removed[k] ?? null, added[k] ?? null);
    }
  });

  return (
    <div>
      <DiffSummary diff={diff} />
      <div class="cairn-diff cairn-side" role="region" aria-label="Changes, side by side">
        <div class="cairn-side-row cairn-side-head">
          <div>Before</div>
          <div>After</div>
        </div>
        {rows}
      </div>
    </div>
  );
};

export const Banner: FC<{ kind?: "warn" | "bad" | "ok"; children: Child }> = ({
  kind = "warn",
  children,
}) => (
  <div
    class={`ak-banner${kind === "bad" ? " ak-banner-bad" : kind === "ok" ? " ak-banner-ok" : ""}`}
    role={kind === "bad" ? "alert" : "status"}
  >
    {children}
  </div>
);
