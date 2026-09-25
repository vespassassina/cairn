import {
  ARTIFACTKIT_DIGEST,
  COMPONENTS_CSS,
  CORE_JS,
  PRINT_CSS,
  THEME_CSS,
} from "./artifactkit.generated.js";

/**
 * Static assets for the review console, served from memory.
 *
 * artifactkit supplies the visual language. The Cairn stylesheet below adds
 * only what artifactkit has no component for, and uses artifactkit's tokens
 * for every colour and space: no colour is defined here (ADR-009 rule 3).
 */

const CAIRN_CSS = `
/* The owner's theme: a dark, desaturated night blue (2026-09-15). Outside any
   @layer, so it beats artifactkit's own tokens without !important. */
:root{
  --t-bg:       #161A22;
  --t-ink:      #E8EAEE;
  --t-accent:   #6AA9D8;
  --t-accent-2: #4E86AC;
  --t-lift:     #FFFFFF;
  --t-lift-amt: 7%;
}

/* Top bar: the console's one piece of chrome. */
.cairn-top{ display:flex; gap:var(--ak-s4); align-items:center; flex-wrap:wrap;
  padding:var(--ak-s3) 0; margin-bottom:var(--ak-s5); border-bottom:1px solid var(--ak-rule) }
.cairn-top .cairn-brand{ font-weight:700; color:var(--ak-ink); text-decoration:none; letter-spacing:.02em }
.cairn-top nav{ display:flex; gap:var(--ak-s3); flex-wrap:wrap }
.cairn-top nav a{ color:var(--ak-ink-muted); text-decoration:none; padding:2px 0;
  border-bottom:2px solid transparent }
.cairn-top nav a[aria-current="page"]{ color:var(--ak-ink); border-bottom-color:var(--ak-accent) }
.cairn-top form{ margin-left:auto; display:flex; gap:var(--ak-s2) }
.cairn-top .ak-input{ min-width:260px }

/* Page view: tree, page, and a rail for links and metadata. */
.cairn-page{ display:grid; gap:var(--ak-s5); grid-template-columns:220px minmax(0,1fr) 240px; align-items:start }
@media (max-width: 1100px){ .cairn-page{ grid-template-columns:200px minmax(0,1fr) } .cairn-rail{ grid-column:2 } }
.cairn-rail{ font-size:13px; position:sticky; top:var(--ak-s4) }
.cairn-rail h3{ font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--ak-ink-soft);
  margin:var(--ak-s4) 0 var(--ak-s2) }
.cairn-rail ul{ list-style:none; margin:0; padding:0 }
.cairn-rail li{ padding:2px 0 }

/* Page tree. Native details elements, so it works without JavaScript. */
.cairn-tree{ font-size:13px; position:sticky; top:var(--ak-s4); max-height:calc(100vh - 2 * var(--ak-s4)); overflow:auto }
.cairn-tree ul{ list-style:none; margin:0; padding:0 0 0 var(--ak-s3) }
.cairn-tree > ul{ padding-left:0 }
.cairn-tree summary{ cursor:pointer; list-style-position:outside }
.cairn-tree a{ color:var(--ak-ink-muted); text-decoration:none; display:inline-block; padding:2px 0 }
.cairn-tree a:hover{ color:var(--ak-ink) }
.cairn-tree a[aria-current="page"]{ color:var(--ak-accent); font-weight:600 }

/* The tree's own <details> wrapper (ADR-056). Above the phone breakpoint its
   summary is never shown, and its content stays visible whether or not the
   element itself is "open": the collapse only exists below the breakpoint.
   Recent Chromium collapses a closed <details> by giving its whole content
   an internal ::details-content box with content-visibility:hidden, not by
   setting display:none on the children directly, so overriding display on
   .cairn-tree alone left it visible-but-zero-sized: both need overriding,
   and only above the breakpoint, or the tree would default to open on the
   phone layout too. */
.cairn-tree-toggle > summary{ display:none }
@media (min-width: 701px){
  .cairn-tree-toggle:not([open]) > .cairn-tree{ display:block }
  .cairn-tree-toggle:not([open])::details-content{
    content-visibility:visible; block-size:auto; overflow:visible;
  }
}

/* Side-by-side diff (ADR-078), before the phone block below so its one-column
   override wins. The diff colours themselves are further down with the inline diff.: each row a two-column grid, older text left. */
.cairn-side .cairn-side-row{ display:grid; grid-template-columns:1fr 1fr; padding:0 }
.cairn-side .cairn-side-row > div{ min-width:0; border-left:1px solid var(--ak-rule) }
.cairn-side .cairn-side-row > div:first-child{ border-left:0 }
.cairn-side .cairn-side-head > div{ font-family:var(--ak-sans); font-size:11px; letter-spacing:.06em;
  text-transform:uppercase; color:var(--ak-ink-soft); background:var(--ak-fill); padding-top:2px; padding-bottom:2px }
.cairn-side .cairn-side-empty{ background:var(--ak-fill) }

/* The Inbox (ADR-079): one block per drop, thumbnails from this origin. Above
   the phone block so its overrides win. */
.cairn-drops{ display:grid; gap:var(--ak-s4) }
.cairn-drop{ border-top:1px solid var(--ak-rule); padding-top:var(--ak-s3) }
.cairn-drop h2{ margin:0 0 var(--ak-s1) }
.cairn-drop-excerpt{ white-space:pre-wrap; margin:var(--ak-s2) 0 }
.cairn-drop-files{ display:flex; flex-wrap:wrap; gap:var(--ak-s2); align-items:center; margin:var(--ak-s2) 0 }
.cairn-thumb{ width:72px; height:72px; object-fit:cover; border-radius:4px; border:1px solid var(--ak-rule); display:block }
.cairn-drop-actions{ display:flex; flex-wrap:wrap; gap:var(--ak-s3); align-items:center; margin-top:var(--ak-s2) }
.cairn-drop-actions .ak-select{ max-width:20rem }
.cairn-token{ user-select:all; word-break:break-all }

/* Single column below 700px: the tree, the body and the rail stack in that
   order, source order already matching (ADR-056). */
@media (max-width: 700px){
  .cairn-page{ grid-template-columns:1fr }
  .cairn-rail{ grid-column:1 }
  .cairn-top .ak-input{ min-width:0; width:100% }
  .cairn-tree,.cairn-rail{ position:static; max-height:none; overflow:visible }
  /* artifactkit's .ak-pagehead is flex-nowrap; at this width the title and
     the Edit/History buttons together no longer fit one row (ADR-056). */
  .ak-pagehead{ flex-wrap:wrap }
  /* Side-by-side diff: one column, before over after, row by row. */
  .cairn-side .cairn-side-row{ grid-template-columns:1fr }
  .cairn-side .cairn-side-row > div{ border-left:0 }
  .cairn-side .cairn-side-head{ display:none }
  .cairn-tree-toggle > summary{
    display:flex; align-items:center; cursor:pointer; min-height:44px;
    font-size:13px; font-weight:600;
  }
  .cairn-tree a,.cairn-top nav a{ min-height:44px; display:flex; align-items:center }
}

/* A link to a page that does not exist yet. Dashed as well as coloured, so
   colour is not the only signal. */
.ak-prose a.cairn-missing{ color:var(--ak-neg); text-decoration-style:dashed }

/* Diffs. Every line carries a +, - or space prefix, so colour is not the
   only signal either. */
.cairn-diff{ font-family:var(--ak-mono); font-size:12.5px; border:1px solid var(--ak-rule);
  border-radius:var(--ak-radius); overflow:auto; margin:0 0 var(--ak-s4) }
.cairn-diff div{ padding:0 var(--ak-s3); white-space:pre-wrap; word-break:break-word }
.cairn-diff .cairn-add{ background:var(--ak-pos-wash) }
.cairn-diff .cairn-del{ background:var(--ak-neg-wash) }
.cairn-diff .cairn-gap{ color:var(--ak-ink-soft); background:var(--ak-fill) }

/* Editor. */
.cairn-editor .ak-textarea{ font-family:var(--ak-mono); font-size:13px; min-height:55vh; line-height:1.5 }
.cairn-editor label{ display:block; font-size:11px; letter-spacing:.06em; text-transform:uppercase;
  color:var(--ak-ink-soft); margin:var(--ak-s3) 0 var(--ak-s1) }
.cairn-editor .ak-input{ width:100% }
.cairn-editor .cairn-sources-input{ min-height:5em; width:100% }

/* Sources (ADR-027). */
.cairn-sources{ margin:0; padding-left:1.2em; font-size:13px; color:var(--ak-ink-muted) }
.cairn-sources li{ margin:var(--ak-s1) 0; word-break:break-word }

/* Freshness (ADR-028). */
.cairn-editor .cairn-verify{ margin:var(--ak-s3) 0 0 }
.cairn-editor .cairn-verify label{ display:inline; font-size:14px; letter-spacing:normal; text-transform:none; color:var(--ak-ink) }
.cairn-unverified{ color:var(--ak-ink-soft) }
.cairn-actions{ display:flex; gap:var(--ak-s2); align-items:center; margin-top:var(--ak-s4) }

/* Recent changes and history. */
.cairn-changes .ak-tl-item p{ margin:var(--ak-s1) 0 0 }
.cairn-note{ color:var(--ak-ink-muted); font-style:italic }
.cairn-inline{ display:inline }

/* Search snippets. */
.cairn-hit{ padding:var(--ak-s3) 0; border-bottom:1px solid var(--ak-rule) }
.cairn-hit mark{ background:var(--ak-accent-wash); color:inherit; padding:0 1px }
.cairn-passage{ margin-top:var(--ak-s2) }
.cairn-passage p{ margin:0 }

/* Row form. */
.cairn-fields{ display:grid; grid-template-columns:minmax(120px, 200px) 1fr; gap:var(--ak-s3) var(--ak-s4); align-items:center }
.cairn-fields .ak-input, .cairn-fields .ak-select{ width:100% }
.cairn-checks{ display:flex; gap:var(--ak-s3); flex-wrap:wrap }

.cairn-login{ max-width:420px; margin:12vh auto 0 }

/* Collections inside a page, below its text (ADR-024), and grouped by root. */
.cairn-tables{ margin-top:var(--ak-s6); border-top:1px solid var(--ak-rule); padding-top:var(--ak-s3) }
.cairn-table-card{ padding:var(--ak-s3) 0; border-bottom:1px solid var(--ak-rule) }
.cairn-table-card h2{ margin:0 0 var(--ak-s1) }
.cairn-table-card p{ margin:0 }
.cairn-tables .ak-disclosure{ margin-top:var(--ak-s4) }
.cairn-group{ margin-bottom:var(--ak-s6) }
.cairn-group .ak-breadcrumb{ margin-bottom:var(--ak-s1) }

/* Home: one card per collection (ADR-026). */
.cairn-collections{ display:grid; gap:var(--ak-s4); grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); margin-bottom:var(--ak-s6) }
.cairn-collection{ display:block; padding:var(--ak-s4); border:1px solid var(--ak-rule); border-radius:var(--ak-radius);
  background:var(--ak-surface); color:var(--ak-ink); text-decoration:none }
.cairn-collection:hover{ border-color:var(--ak-accent) }
.cairn-collection h2{ color:var(--ak-accent); margin-bottom:var(--ak-s2); overflow-wrap:anywhere }
.cairn-collection p{ margin:0 0 var(--ak-s2) }

/* Long titles wrap instead of forcing a scrollbar; a page's own markdown
   tables scroll inside their own box rather than widening the page, matching
   what .ak-prose pre already does for code blocks (ADR-056). */
.ak-pagehead{ min-width:0 }
.ak-pagehead > div{ min-width:0 }
.ak-pagehead h1{ overflow-wrap:anywhere }
/* The title's min-width:0 above also shrinks its sibling .ak-row (the
   action buttons), and a plain flex row with no wrap answers that by
   squeezing each button's own text instead of moving to a new line: four
   buttons wrapped "PDF (page + subtree)" into three narrow lines that
   overflowed into the rail next to it. Wrapping the row itself, as a
   whole button at a time, is what the row is short on room for. */
.ak-pagehead .ak-row{ flex-wrap:wrap; justify-content:flex-end }
.ak-prose table{ display:block; overflow-x:auto; max-width:100% }

/* On paper: no chrome, just the article. artifactkit's print.css already
   hides .ak-btn and anything [data-ak-noprint]; this drops the console's
   own chrome, which artifactkit has no class for. */
@media print{
  .cairn-top, .cairn-tree-toggle, .cairn-rail, .ak-breadcrumb, .ak-footer{ display:none !important }
  .cairn-page{ display:block }
  .ak-prose + .ak-prose{ break-before:page }
}
`;

/**
 * The browser tab icon: a cairn, four stones stacked. An image rather than
 * CSS, so it carries its colours: artifactkit's accent, lightened when the
 * browser is dark so it stays visible on a dark tab bar.
 */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<style>path,ellipse{fill:#14496B}@media (prefers-color-scheme:dark){path,ellipse{fill:#6AA9D8}}</style>
<ellipse cx="16" cy="25" rx="12" ry="4.5"/>
<ellipse cx="15" cy="16" rx="8.5" ry="3.8"/>
<ellipse cx="16.5" cy="8.6" rx="5.5" ry="3"/>
<ellipse cx="15.8" cy="3.2" rx="3" ry="1.9"/>
</svg>
`;

/** PNG icons for home screens and app launchers, which do not take SVG. */
export const ICON_180_PNG = Uint8Array.from(atob("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"), (c) => c.charCodeAt(0));
export const ICON_512_PNG = Uint8Array.from(atob("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"), (c) => c.charCodeAt(0));

export const APP_NAME = "Cairn";
export const APP_DESCRIPTION = "A wiki and tables your agents can write to, with every change reviewable.";

/** Lets a browser add Cairn to a home screen or launcher under its own name. */
export const MANIFEST = JSON.stringify({
  name: APP_NAME,
  short_name: APP_NAME,
  description: APP_DESCRIPTION,
  start_url: "/",
  display: "browser",
  background_color: "#161A22",
  theme_color: "#161A22",
  icons: [
    { src: "/assets/favicon.svg", sizes: "any", type: "image/svg+xml" },
    { src: "/assets/icon-180.png", sizes: "180x180", type: "image/png" },
    { src: "/assets/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
});

/**
 * The tags every Cairn page starts its head with, after charset and before
 * its stylesheet. A string, so the OAuth pages, which are not JSX, share it.
 */
export const HEAD_TAGS = [
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  `<meta name="description" content="${APP_DESCRIPTION}">`,
  `<meta name="application-name" content="${APP_NAME}">`,
  `<meta name="apple-mobile-web-app-title" content="${APP_NAME}">`,
  '<meta name="theme-color" content="#161A22">',
  '<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">',
  '<link rel="apple-touch-icon" href="/assets/icon-180.png">',
  '<link rel="manifest" href="/assets/manifest.webmanifest">',
].join("");

/** A page's title: the app's name alone, or the page's name then the app's. */
export const documentTitle = (title: string) => (title === APP_NAME ? APP_NAME : `${title} · ${APP_NAME}`);

/** One stylesheet, so a page costs one request, cached by content digest. */
export const CONSOLE_CSS = [THEME_CSS, COMPONENTS_CSS, PRINT_CSS, CAIRN_CSS].join("\n");

/**
 * artifactkit's core, plus the console's wiring. Served as a file, never
 * inline, because the Content-Security-Policy forbids inline script.
 */
export const CONSOLE_JS = `${CORE_JS}
;(function () {
  ak.init({ id: "cairn-console", title: "Cairn" });
  document.querySelectorAll("table[data-ak-table]").forEach(function (table) {
    var filter = document.getElementById(table.getAttribute("data-filter") || "");
    ak.table(table, filter ? { filterInput: filter } : {});
  });
  var search = document.getElementById("q");
  document.addEventListener("keydown", function (event) {
    var typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || "");
    if (event.key === "/" && search && !typing) { event.preventDefault(); search.focus(); }
  });
  document.addEventListener("click", function (event) {
    var print = event.target.closest("[data-ak-action='print']");
    if (print) { window.print(); return; }
    var copy = event.target.closest("[data-ak-copy]");
    if (copy && navigator.clipboard) {
      navigator.clipboard.writeText(copy.getAttribute("data-ak-copy")).then(
        function () { ak.toast("Copied"); },
        // The browser can refuse the clipboard (no permission, no focus);
        // the command is printed right below the button either way, so
        // this is a fallback, not the only way to get it.
        function () { ak.toast("Couldn't copy — the command is printed below"); },
      );
    }
  });
  var editor = document.querySelector("form[data-dirty-guard]");
  if (editor) {
    var dirty = false;
    editor.addEventListener("input", function () { dirty = true; });
    editor.addEventListener("submit", function () { dirty = false; });
    window.addEventListener("beforeunload", function (event) { if (dirty) event.preventDefault(); });
  }
})();
`;

/** FNV-1a, enough to tell two builds of the assets apart. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Cache key for asset URLs. Covers artifactkit and Cairn's own additions, so a
 * sync or a style change reaches the browser at once.
 */
export const ASSET_VERSION = `${ARTIFACTKIT_DIGEST.slice(0, 6)}${fingerprint(CONSOLE_CSS + CONSOLE_JS)}`;
