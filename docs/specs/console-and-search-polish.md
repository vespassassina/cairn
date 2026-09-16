# Spec: the console on a phone, search results by page, and eight smaller faults

ADR-056 and ADR-057, plus a set of faults that need no decision, only fixing. All found in the review of 2026-09-16.

## Goal

Cairn stops being annoying in the small ways that a person notices every day and an agent cannot report.

## Success test

Open the console on a phone and read a page without pinching or scrolling sideways. Search for a common topic and get ten different pages. Make every one of the eight faults below happen on purpose, and get a message that says what went wrong and what to do about it.

## Scope

1. The single column breakpoint and the faults around it, in `packages/api/src/web/assets.ts` and the console templates.
2. Grouping search results by page, in `packages/adapter-sqlite/src/search-index.ts` and above it.
3. Eight smaller faults, listed below.

## Non-goals

1. Any script in the console. ADR-009 forbids a client-side application and ADR-056 decision 6 keeps it that way.
2. A separate mobile template or route.
3. Changing which pages search ranks highest. ADR-057 decision 4.
4. Table views beyond a plain table, on any screen size. ADR-009, restated by ADR-056 consequence 4.

## Constraints

1. Hard rule 7: no search change merges without running `pnpm eval` and recording before and after recall@5 per backend. This spec contains a search change.
2. Hard rule 14: the result shape changes on all three surfaces together.
3. Hard rule 6: the MCP tool's budget is spent on distinct pages before extra passages.
4. Coding style rule 5: an error that misled someone is a bug. Fix it, test the message, and add a `docs/LESSONS.md` entry. Four of the eight faults below are misleading errors and each earns an entry.

## Design

### The phone layout

`.cairn-page` gains a second media query below 700 pixels: one column, and the tree, the body and the rail stack in that order.

The tree becomes a `details` element closed by default at that width, with a summary reading "Pages in this collection". It is already built from native `details` elements for its branches, so this is the same mechanism one level up and needs no script.

`.cairn-top .ak-input` drops its `min-width:260px` below the breakpoint and takes the full width of its row. The header already wraps.

`position:sticky` is switched off on `.cairn-tree` and `.cairn-rail` in the single column layout, and the tree's `max-height:calc(100vh - ...)` with it.

Tree links and navigation links get at least 44 pixels of height below the breakpoint. They are currently 13 pixel text with 2 pixels of padding.

Long titles wrap. Code blocks and tables scroll inside their own box, never widening the page.

### Search results by page

The index keeps returning chunk hits. Above it, results are grouped: one entry per page, its best passage first, up to three passages attached, and a count of any beyond three. A limit counts pages.

`diversify` is replaced by the grouping, because separating first hits from the rest exists only to approximate this.

The MCP tool spends its token budget on distinct pages first, dropping a page's second and third passage before dropping a page.

The eval harness gains one number beside recall@5: the mean count of distinct pages in the first five results.

### The eight smaller faults

1. **The version conflict error carries REST wording into the CLI.** `packages/api/src/rest/routes.ts` line 184 says "Read it again, merge your change, and retry with the new ETag in If-Match." The CLI prints it verbatim, and a person at a terminal has no ETag and no If-Match. The operation returns a reason the surface renders in its own words: the CLI says to read the page again and retry, naming the command. The REST wording stays as it is for REST. The message also repeats itself in the CLI output, which is the surface printing both its own line and the server's.

2. **`cairn rows --where "nosuch eq 1"` prints "no rows".** `matchesCondition` in `packages/core/src/query/filter.ts` reads `row.values[condition.field] ?? null` and compares, so an unknown field is indistinguishable from a field that is null everywhere. The filter is validated against the table's schema before it runs, and an unknown field is refused by name, with the fields the table does have listed.

3. **A write without a change note is accepted silently.** Every instruction says a note is required. The CLI prints a warning on stderr naming `--note`, and the console shows "no note given" where the note would be. MCP tools keep requiring it as they already do. A hard failure on the CLI is rejected because it would break scripts for a rule that is about hygiene, not correctness.

4. **Snippets drop apostrophes**, producing "the page s history". The cause is not established. The index is built with `porter unicode61 remove_diacritics 2`, and FTS5's `snippet()` is supposed to return the original text, so either the stored chunk text has already been normalised on the way in or a typographic apostrophe is being handled differently from a straight one. Find the cause before writing the fix, and the test uses both apostrophe characters.

5. **The `search` tool description calls `mode` an input.** It is an output, the flag that says whether the answer came from hybrid or keyword search, per hard rule 5. The description is corrected, and the skill file and the MCP instructions are checked for the same error.

6. **A search that returns nothing says only that.** It names what was searched and suggests the next move, which is fewer words or a different spelling, per coding style rule 1.

7. **An unreachable Cairn does not say which instance it tried or why that one.** Coding style rule 2 requires saying when a default was used, and talking to the first registered instance because none was named is exactly that case.

8. **The console gives no way to reach `cairn status`'s facts.** The health information exists at an endpoint and nowhere a person looks. One line in the console footer: the instance, the page count, and when the last backup ran.

## Acceptance criteria

1. Screenshots of the collections, page, search, tables and freshness views at 375 by 812, each with no horizontal scroll and a body at least 320 pixels wide.
2. The same five views at 320 pixels with no horizontal scroll.
3. The same five views at 1280 pixels, unchanged from today.
4. The tree is collapsed by default below 700 pixels and opens on tap with no script loaded. Asserted by a contract test on the rendered HTML, and by screenshot.
5. Tree and navigation links are at least 44 pixels high below the breakpoint.
6. No script tag is added to any console template. Asserted by the existing console tests.
7. A search for a topic held by three pages returns three results, not ten, and says three is all there was.
8. No page appears twice in one result list, on any of the three surfaces. One test per surface.
9. At most three passages are attached to a page, with a count of the rest.
10. `pnpm eval` run before and after, per backend, with recall@5 and the new distinct-page count recorded in `docs/CHANGELOG.md`. Recall is expected unchanged and must be shown, not assumed.
11. The CLI conflict error contains no mention of ETag or If-Match, says what to do in a terminal, and appears once.
12. `cairn rows --where "nosuch eq 1"` names the unknown field and lists the table's fields.
13. A write without a note warns on stderr naming `--note`, and still succeeds.
14. A snippet containing either apostrophe character keeps it, with the cause of the fault written into the `docs/LESSONS.md` entry.
15. The `search` tool description, the MCP instructions and `skills/cairn/SKILL.md` all describe `mode` as an output.
16. An empty search result names the query and suggests a next move.
17. An unreachable Cairn names the instance, the address, and says it was chosen because none was given.
18. The console footer shows the instance, the page count and the last backup time.
19. `docs/LESSONS.md` gains an entry for each of faults 1, 2, 4 and 7, with cause, fix and lesson.
20. `pnpm build`, `pnpm typecheck`, `pnpm test` and `pnpm smoke:cli` pass.

## Risks and open questions

1. The result shape change is breaking for REST and for the MCP tool output. Both are pre-1.0 with one consumer, and ADR-057 consequence 2 takes the break now rather than carrying it.
2. Recall is expected not to move, because no page enters or leaves the top five. Hard rule 7 exists because expectations like that are wrong often enough to be worth measuring, and criterion 10 is not optional.
3. The console now has two layouts to check on every change. Criteria 1 to 3 are the standing check, not a one-off.
4. Fault 4 has no established cause, so its effort is unknown. If it turns out to be in how chunks are stored, it touches indexing and needs a rebuild, which makes it larger than the other seven and possibly its own piece of work.
5. Open: whether the rail is worth showing at all on a phone, or whether backlinks and metadata below a long page will simply never be reached. Stacked for now, because hiding information is a worse default than putting it last.
