/**
 * Server instructions, sent to the client at initialize (ADR-011).
 *
 * Tool descriptions say how to call a tool. These say when: tools are only
 * available, never required, so without this a client uses Cairn when asked
 * and otherwise forgets it exists. Claude Code places this text in the
 * context of every session, so it is kept short and stays under
 * INSTRUCTIONS_BUDGET, which a test enforces.
 *
 * The live workspace summary that follows this text (ADR-012) needs its own
 * guaranteed room, not whatever is left over: ADR-055 found that on a real
 * workspace the fixed text alone spent nearly the whole budget, and the
 * summary named no collections at all. FIXED_INSTRUCTIONS_CEILING is the
 * fixed text's own limit, checked by a test, so a future edit here fails the
 * build rather than silently starving the summary again. What this text
 * used to spell out at length now mostly lives in skills/cairn/SKILL.md,
 * which a CLI-capable agent reads in full; this stays the short form for a
 * client that has only these tools.
 */

// ADR-055: was 2200 (ADR-032's line about publishing). The summary now has
// its own 700 character floor (SUMMARY_BUDGET in summary.ts) rather than a
// remainder, so the total budget carries that cost explicitly. ADR-078 added
// the paragraph on the owner's mark: was 2400 and 1500. About 600 tokens
// total with the summary; see pnpm context-cost.
export const INSTRUCTIONS_BUDGET = 2800;

/** The fixed text's own ceiling, so it can never eat the summary's room. */
export const FIXED_INSTRUCTIONS_CEILING = 1900;

export const SERVER_INSTRUCTIONS = `Cairn is the owner's long-term memory: wiki pages in Markdown, linked with [[page-id]], and typed tables of rows. A top-level page with everything under it is a collection, one wiki.

Read before you answer. When a topic may be in Cairn, call search first, then get_page on the best hits. Search matches keywords and, for English text, meaning: try a few distinctive words before deciding nothing is there. Say which page it came from.

Write back what lasts: findings, decisions and their reasons, corrected facts. Search first and prefer update_page over a new page, so knowledge does not split across duplicates. Link related pages with [[page-id]]. Put structured records in a table with upsert_row, or a page from a template.

Every write needs change_note saying what changed and why, and sources when a fact came from somewhere: a URL, DOI, PubMed id or short citation, the original rather than a summary. Pass verified: true when you re-check a page and it still holds; find what needs one with list_stale_pages. Missing jargon? add_synonym, per collection. Writes apply at once and every one is kept as a revision the owner can review and restore, so write freely but accurately.

Writes carry the version you read. On version_conflict, read the page again, merge your change into the new text, and retry. Never overwrite blindly.

Pages are private. Only the owner publishes one, or marks it approved or disapproved; there is no tool for either, so say that when asked. Never store secrets, credentials or throwaway scratch work.

Search ranks approved pages higher and leaves disapproved ones out unless you pass include_disapproved. A page's approval_notice says the owner disapproved it, or that it was approved and has changed since: do not build on a disapproved page, and say so if asked about it; a changed page waits for the owner's re-review, not yours.`;
