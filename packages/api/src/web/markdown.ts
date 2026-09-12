import MarkdownIt from "markdown-it";

/**
 * Markdown to HTML for the review console.
 *
 * Page content is untrusted: agents write it, and a prompt-injected agent can
 * write anything (ADR-009 rule 4). Three things keep that safe.
 *
 * 1. Raw HTML is disabled, so any tag in a page is shown as text, never run.
 * 2. Link targets are limited to http, https, mailto, in-page anchors and
 *    Cairn page links. `javascript:`, `data:` and the rest are dropped.
 * 3. The console's Content-Security-Policy blocks inline script regardless.
 */

export interface LinkResolver {
  /** Title for a page id, or null if no such page exists. */
  title(pageId: string): string | null;
}

const PAGE_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_LINK = /^(https?:|mailto:|#|\/p\/|cairn:)/i;

export function pageHref(pageId: string): string {
  return `/p/${encodeURIComponent(pageId)}`;
}

/** `cairn:id` and `/pages/id` are the two link forms pages use (indexer/extract). */
function toConsoleHref(href: string): string {
  const cairn = /^cairn:([A-Za-z0-9_-]+)$/.exec(href);
  if (cairn) return pageHref(cairn[1]!);
  const legacy = /^\/pages\/([A-Za-z0-9_-]+)$/.exec(href);
  if (legacy) return pageHref(legacy[1]!);
  return href;
}

export function createMarkdownRenderer(): (body: string, links: LinkResolver) => string {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  md.validateLink = (url: string) => SAFE_LINK.test(url.trim());

  // `[[page-id]]` and `[[page-id|label]]` as an inline rule rather than a
  // text substitution, so a wiki link inside a code span or code block stays
  // literal, matching how the indexer reads links.
  md.inline.ruler.before("link", "wikilink", (state, silent) => {
    const start = state.pos;
    if (state.src.charCodeAt(start) !== 0x5b || state.src.charCodeAt(start + 1) !== 0x5b) {
      return false;
    }
    const end = state.src.indexOf("]]", start + 2);
    if (end === -1) return false;

    const inner = state.src.slice(start + 2, end);
    const [id, label] = inner.split("|", 2) as [string, string | undefined];
    if (!PAGE_ID.test(id)) return false;

    if (!silent) {
      const open = state.push("link_open", "a", 1);
      open.attrs = [["href", pageHref(id)]];
      const text = state.push("text", "", 0);
      text.content = label ?? "";
      text.meta = { wikiTitleFor: label ? null : id };
      state.push("link_close", "a", -1);
    }
    state.pos = end + 2;
    return true;
  });

  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  const defaultText = md.renderer.rules.text!;

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    const links = (env as { links: LinkResolver }).links;
    const href = toConsoleHref(String(token.attrGet("href") ?? ""));
    token.attrSet("href", href);

    const internal = /^\/p\/(.+)$/.exec(href);
    if (internal) {
      const pageId = decodeURIComponent(internal[1]!);
      if (links.title(pageId) === null) {
        // A link to a page that does not exist, shown as such rather than
        // hidden: it is often exactly what the owner needs to notice.
        token.attrJoin("class", "cairn-missing");
        token.attrSet("title", `No page ${pageId} yet`);
      }
    } else if (/^https?:/i.test(href)) {
      token.attrSet("rel", "noopener noreferrer nofollow");
      token.attrSet("target", "_blank");
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  md.renderer.rules.text = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    const titleFor = (token.meta as { wikiTitleFor?: string | null } | null)?.wikiTitleFor;
    if (titleFor) {
      const links = (env as { links: LinkResolver }).links;
      token.content = links.title(titleFor) ?? titleFor;
    }
    return defaultText(tokens, idx, options, env, self);
  };

  return (body, links) => md.render(body, { links });
}
