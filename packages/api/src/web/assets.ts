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
/* Top bar: the console's one piece of chrome. */
.cairn-top{ display:flex; gap:var(--ak-s4); align-items:center; flex-wrap:wrap;
  padding:var(--ak-s3) 0; margin-bottom:var(--ak-s5); border-bottom:1px solid var(--ak-rule) }
.cairn-top .cairn-brand{ font-weight:700; color:var(--ak-ink); text-decoration:none; letter-spacing:.02em }
.cairn-top nav{ display:flex; gap:var(--ak-s3) }
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
.cairn-actions{ display:flex; gap:var(--ak-s2); align-items:center; margin-top:var(--ak-s4) }

/* Recent changes and history. */
.cairn-changes .ak-tl-item p{ margin:var(--ak-s1) 0 0 }
.cairn-note{ color:var(--ak-ink-muted); font-style:italic }
.cairn-inline{ display:inline }

/* Search snippets. */
.cairn-hit{ padding:var(--ak-s3) 0; border-bottom:1px solid var(--ak-rule) }
.cairn-hit mark{ background:var(--ak-accent-wash); color:inherit; padding:0 1px }

/* Row form. */
.cairn-fields{ display:grid; grid-template-columns:minmax(120px, 200px) 1fr; gap:var(--ak-s3) var(--ak-s4); align-items:center }
.cairn-fields .ak-input, .cairn-fields .ak-select{ width:100% }
.cairn-checks{ display:flex; gap:var(--ak-s3); flex-wrap:wrap }

.cairn-login{ max-width:420px; margin:12vh auto 0 }
`;

/** One stylesheet, so a page costs one request, cached by content digest. */
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
