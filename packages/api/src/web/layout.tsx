/** @jsxImportSource hono/jsx */
import type { Child, FC } from "hono/jsx";
import { raw } from "hono/html";
import type { Actor, Diff } from "@cairn/core";
import { ASSET_VERSION, documentTitle, HEAD_TAGS } from "./assets.js";

/**
 * Shared pieces of the review console (ADR-009). artifactkit classes for
 * everything it has a component for, `cairn-*` only for what it does not.
 */

export type Section = "recent" | "pages" | "collections" | "search" | "none";

export const Layout: FC<{
  title: string;
  section: Section;
  query?: string;
  children: Child;
}> = ({ title, section, query, children }) => (
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
            <a href="/" aria-current={section === "recent" ? "page" : undefined}>
              Recent changes
            </a>
            <a href="/pages" aria-current={section === "pages" ? "page" : undefined}>
              Pages
            </a>
            <a href="/c" aria-current={section === "collections" ? "page" : undefined}>
              Collections
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
            <a class="ak-btn" href="/new">
              New page
            </a>
          </form>
        </header>
        <main>{children}</main>
        <footer class="ak-footer">
          Every change is kept and can be restored. Agents write directly; this is where you
          review what they wrote.
        </footer>
      </div>
      <script src={`/assets/console.js?v=${ASSET_VERSION}`} defer></script>
    </body>
  </html>
);

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

/**
 * A diff with a little context around each change. Every line carries a
 * prefix, so the change reads without colour.
 */
export const DiffView: FC<{ diff: Diff; context?: number }> = ({ diff, context = 3 }) => {
  if (diff.added === 0 && diff.removed === 0) {
    return <p class="ak-small">No change to the text.</p>;
  }
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

  const rows: Child[] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (last !== -1 && i > last + 1) {
      rows.push(<div class="cairn-gap">…</div>);
    }
    const line = diff.lines[i]!;
    const prefix = line.op === "add" ? "+ " : line.op === "remove" ? "- " : "  ";
    const cls = line.op === "add" ? "cairn-add" : line.op === "remove" ? "cairn-del" : "";
    rows.push(<div class={cls}>{prefix + line.text}</div>);
    last = i;
  }

  return (
    <div>
      <p class="ak-small">
        {diff.added} added, {diff.removed} removed
        {diff.coarse ? " (too large to compare line by line)" : ""}
      </p>
      <div class="cairn-diff" role="region" aria-label="Changes">
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
