/**
 * Server instructions, sent to the client at initialize (ADR-011).
 *
 * Tool descriptions say how to call a tool. These say when: tools are only
 * available, never required, so without this a client uses Cairn when asked
 * and otherwise forgets it exists. Claude Code places this text in the
 * context of every session, so it is kept short and stays under
 * INSTRUCTIONS_BUDGET, which a test enforces.
 */

// Raised from 2000 to 2200 with ADR-032's line about publishing, so the
// workspace summary that follows keeps the room it had. About 50 tokens.
export const INSTRUCTIONS_BUDGET = 2200;

export const SERVER_INSTRUCTIONS = `Cairn is the owner's long-term memory: wiki pages in Markdown, linked with [[page-id]], and typed tables of rows. Pages form a tree; a top-level page with everything under it is a collection, one wiki.

Read before you answer. When a question or task touches a topic Cairn may hold, call search first, then get_page on the best hits. Search matches keywords and, for English text, meaning: use a few distinctive words, and retry with other words before deciding nothing is there. Say which page an answer came from.

Write back what lasts. When you learn something the owner will want again, such as a finding, a decision and its reason, or a corrected fact, save it without being asked. Search first and prefer update_page on an existing page over a new one, so knowledge is not split across duplicates. Link related pages with [[page-id]], and a page in another Cairn with an ordinary link to its published address. Put structured records in a table with upsert_row; a relation field links a row to pages or to other rows.

Every write needs a change_note saying what changed and why. When a fact came from somewhere, such as a paper, a web page or the owner, name it in sources: a URL, a DOI, a PubMed id or a short citation, and cite the original, not a summary of it. A page's verified_at says when its facts were last confirmed; when you re-check one and it still holds, pass verified: true. Writes apply at once, with no approval step. Each one is kept as a revision that the owner reviews and can restore, so write freely but accurately.

Writes carry the version you read. On version_conflict, read the page again, merge your change into the new text, and retry. Never overwrite blindly.

Pages are private. Only the owner publishes one, in the console or with cairn publish; there is no tool for it, so say that when asked.

Do not store secrets, credentials or throwaway scratch work.`;
