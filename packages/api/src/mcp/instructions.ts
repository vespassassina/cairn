/**
 * Server instructions, sent to the client at initialize (ADR-011).
 *
 * Tool descriptions say how to call a tool. These say when: tools are only
 * available, never required, so without this a client uses Cairn when asked
 * and otherwise forgets it exists. Claude Code places this text in the
 * context of every session, so it is kept short and stays under
 * INSTRUCTIONS_BUDGET, which a test enforces.
 */

export const INSTRUCTIONS_BUDGET = 2000;

export const SERVER_INSTRUCTIONS = `Cairn is the owner's long-term memory: wiki pages in Markdown, linked with [[page-id]], and typed tables of rows. Pages form a tree; a top-level page with everything under it is a collection, one wiki.

Read before you answer. When a question or task touches a topic Cairn may hold, call search first, then get_page on the best hits. Search matches keywords and, for English text, meaning: use a few distinctive words, and retry with other words before deciding nothing is there. Say which page an answer came from.

Write back what lasts. When you learn something the owner will want again, such as a finding, a decision and its reason, or a corrected fact, save it without being asked. Search first and prefer update_page on an existing page over a new one, so knowledge is not split across duplicates. Link related pages with [[page-id]]. Put structured records in a table with upsert_row; a relation field links a row to pages or to other rows.

Every write needs a change_note saying what changed and why. When a fact came from somewhere, such as a paper, a web page or the owner, name it in sources: a URL or a short citation. Writes apply at once, with no approval step. Each one is kept as a revision that the owner reviews and can restore, so write freely but accurately.

Writes carry the version you read. On version_conflict, read the page again, merge your change into the new text, and retry. Never overwrite blindly.

Do not store secrets, credentials or throwaway scratch work.`;
