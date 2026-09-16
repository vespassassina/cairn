# Spec: agent navigation

ADR-055 and ADR-058. Written 2026-09-16, after a review found that an agent connecting to the owner's 104 page Cairn was told the names of no collections at all, and had no way to ask what was inside one.

## Goal

An agent that connects to a Cairn learns what it holds, and can then walk into it.

## Success test

Connect a fresh MCP client to the owner's laptop Cairn. The instructions name at least three collections with their page counts. Ask the agent what is in one of them, and it answers by listing that collection's children, without searching and without being told which tool to use.

## Scope

1. The budget arithmetic in `packages/api/src/mcp/instructions.ts` and the layout in `packages/api/src/mcp/summary.ts`.
2. Shortening `SERVER_INSTRUCTIONS` to fit its new ceiling.
3. A `list_children` capability on MCP, REST and the CLI.
4. Children reported when a page is read, on all three surfaces.
5. MCP gains `delete_page`, a changes feed, and a table schema update.
6. `create_table` takes a change note, and a table carries a description.
7. A test that fails when the three surfaces drift apart.

## Non-goals

1. Returning a whole subtree in one call. ADR-058 decision 2.
2. Sorting children by anything but title. ADR-058 consequence 5.
3. Changing what search ranks or returns. That is `console-and-search-polish.md`.

## Constraints

1. Hard rule 6: every MCP tool truncates to a token budget and returns a cursor when it does. `list_children` is a list and needs one.
2. Hard rule 14: a capability added to one surface is added to the others, or an ADR says why not. This spec both obeys that and makes it enforceable.
3. Hard rule 3: every write uses optimistic concurrency via version tokens. `delete_page` is a write.
4. Hard rule 13: route handlers use web-standard Request and Response.
5. The documentation rule on instruction text: the MCP instructions, the summary and `skills/cairn/SKILL.md` must say the same things, and `pnpm context-cost` is re-run when they change.

## Design

### The summary budget

`INSTRUCTIONS_BUDGET` becomes 2400. Two new constants sit beside it: `SUMMARY_BUDGET` at 700 and `FIXED_INSTRUCTIONS_CEILING` at 1500.

`buildInstructions` stops computing the summary's allowance as a remainder. It builds the summary to `SUMMARY_BUDGET` and appends it. A test asserts `SERVER_INSTRUCTIONS.length <= FIXED_INSTRUCTIONS_CEILING`, so a future edit to the fixed text fails the build rather than silently shrinking the summary.

`SERVER_INSTRUCTIONS` is cut from 1895 characters to 1500 or fewer. What goes is whatever `skills/cairn/SKILL.md` already says at length; what stays is what a client with no skill file still needs. The skill and the summary are reviewed in the same change so all three keep saying the same things.

In `summary.ts`, `fitLines` and the `tagReserve` squeeze are replaced by a simple order of spending. The page count is one short line. Then collections by name, most pages first, each with its count, at least three before any "and N more". Then tables with their descriptions. Then tags, at least three or the line is dropped. A section that cannot show three items is dropped entirely rather than truncated to a stub, per ADR-055 decision 4.

The 60 second cache in `cachedInstructions` is unchanged.

### `list_children`

One operation in `packages/api/src/operations.ts`, reached by three surfaces, per hard rule 14.

It takes a parent identifier or nothing, a cursor and a limit. It returns each immediate child with its identifier, title, whether it has children, and when it last changed, plus a cursor when there is more. With no parent it returns the top-level pages, which are the collections, so `cairn collections` becomes a thin call to it rather than a separate path.

MCP: a `list_children` tool with a token budget and a cursor, per hard rule 6.
REST: `GET /api/v1/pages?parent=` already exists and gains the child count and the changed timestamp per row, plus the cursor.
CLI: `cairn ls [page]`, printing one child per line.

### Children when a page is read

`get_page` on MCP, `GET /pages/:id` on REST and `cairn read` each report up to eight children and the count of the rest, pointing at `list_children` for the remainder.

### MCP parity

`delete_page`: identifier, version token, change note. Refuses a page that still has children and says how many. Its description says history is kept and names `get_revision` as the way back. It calls the same operation `DELETE /pages/:id` and `cairn delete` already call.

The changes feed: an MCP tool over the same operation as `GET /changes` and `cairn changes`, with a cursor.

Table schema update: an MCP tool over whatever REST and the CLI already use, with a change note.

`create_table` gains a required `change_note`, matching every other write.

A table gains a `description`, one short line, set at creation and editable, returned by `list_tables`, shown in the console and spent in the workspace summary.

### The parity test

A new test enumerates the operation names exposed by the MCP tool registry, by the REST route table and by the CLI command switch, maps them onto the operations in `operations.ts`, and fails when an operation reaches one surface and not the others. Exceptions live in an allow list in the test file, and every entry carries the ADR or spec that justifies it. The first entries are restore, which ADR-045 settled, and `status`, `hook`, `sync`, `instances`, `start` and `import`, which describe or change this machine rather than a Cairn and are named against `presence.md`.

## Acceptance criteria

1. A test builds a summary for a generated workspace of 100 pages, 12 top-level collections with long names, 2 tables and 20 tags, and asserts at least three collections are named with their counts.
2. The same test asserts the tag line is either absent or holds at least three tags, and that no section appears as a bare "and N more".
3. The whole instructions text stays within 2400 characters for that workspace, and within it for an empty workspace too.
4. `SERVER_INSTRUCTIONS.length` is at most 1500, asserted by a test.
5. `pnpm context-cost` is run and the README numbers updated in the same commit.
6. A live MCP initialize against the owner's laptop Cairn names at least three collections. This is the criterion the current code fails, and it is checked by hand as well as by test.
7. `list_children` returns immediate children only, in title order, with a working cursor, on all three surfaces. One contract test per surface with a realistic payload.
8. `list_children` with no parent returns the same set as `cairn collections`, asserted against each other.
9. Reading a page reports its children on all three surfaces, capped at eight with a count of the rest.
10. `delete_page` over MCP deletes a childless page given a correct version token and a change note, and the revision remains fetchable by `get_revision` afterwards.
11. `delete_page` refuses a page with children, names the count, and refuses a stale version token.
12. `create_table` without a change note is refused, with a message naming the argument.
13. The changes feed and the table schema update are reachable over MCP, each with a contract test.
14. The parity test passes, and fails when a capability is removed from one surface in a deliberate mutation of it.
15. `pnpm build`, `pnpm typecheck`, `pnpm test` and `pnpm smoke:cli` pass.

## Risks and open questions

1. Cutting 400 characters from the fixed instructions without losing meaning is the hardest part of this work, and it is where the change could quietly make Cairn worse. The skill file has to take the weight, and the three texts are read together before the commit.
2. Every session pays about 150 more tokens at initialize. That is the trade ADR-012 always implied and ADR-055 decision 3 accepts.
3. The REST response for `GET /pages` changes shape by gaining fields. Additive, so no consumer breaks.
4. `delete_page` on MCP is a destructive capability on the primary interface. The version token, the change note, the refusal on children and the description naming the way back are the whole mitigation, and criteria 10 and 11 are what prove them.
5. Open: whether the workspace summary should spend some of its 700 characters on table descriptions once tables have them. It should, and the order of spending in the design puts tables second, but the right split only becomes clear once real descriptions exist.
