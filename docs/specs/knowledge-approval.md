# Spec: knowledge approval

The owner's direction of 2026-09-24: a person marks a page's knowledge approved, neutral or disapproved; agents still retrieve everything but take the mark into account; approving and reviewing are easy; the mark survives small edits; a side-by-side diff between versions is one click away. ADR to write on agreement: ADR-078.

## Goal

The owner can say, per page, "this is right", "I have not looked" or "this is wrong", in one click from anywhere the page is shown, and every agent sees that judgement and acts on it.

## Success test

Approve a page in the console. Ask Claude through MCP a question the page answers: the page ranks first and the tool result shows `approval: approved`. Disapprove it. Ask again: the page is absent from search, and `get_page` on it returns the body with a notice that the owner disapproved it and when. Let an agent fix a typo on an approved page: it stays approved. Let an agent rewrite a paragraph: it drops to neutral, shows "was approved, changed by <agent>" in the review queue, and the "changes since approval" button opens a side-by-side diff.

## Scope

1. Page model: an approval mark, who set it, when, and on which version.
2. Carry-over rule on every page write.
3. Console: mark buttons on the page view and in a review queue at `/review`; side-by-side diff view.
4. Search ranking and filtering in `searchPages`, shared by every surface (hard rule 14).
5. `get_page`, REST `GET /pages/:id` and `cairn read` show the mark; MCP instructions, workspace summary and skill say what it means (rule 8).
6. Sync, export and import carry the mark.

## Non-goals

1. Rows and tables carry no mark in v1. A table row with a wrong value is edited or deleted; if row-level approval is wanted later it gets its own ADR.
2. No per-section or per-sentence marks. The unit is the page.
3. Agents cannot set or change the mark. Like publishing, it is the owner's act. An agent that disagrees writes a note in the body or a change note.
4. No workflow states beyond the three. "Draft" is neutral; "needs re-review" is neutral with a previous mark.
5. No notification. The review queue is pulled, not pushed.

## Constraints

Hard rules 3 (version tokens on the approval write), 7 (eval before and after the ranking change, per backend), 9 (the mark is source data on the page, not derived), 11 (search reads are eventual), 14 (one operation, every surface), 19 (no new setting expected). Documentation rule 8 (instructions, summary and skill say the same thing; `pnpm context-cost` if the numbers move).

## Design

### Model

`Page` gains:

```ts
approval: "approved" | "neutral" | "disapproved";   // default "neutral"
approvalAt: string | null;        // when a person last set it
approvalVersion: Version | null;  // the version the person looked at
approvalPrevious: "approved" | "disapproved" | null; // set when a large edit reset the mark
```

`packages/core/src/types.ts`, the SQLite schema with a migration adding three columns, the conformance suite in `packages/core/test/conformance`. Revisions record the mark as it was after the write, so history shows when it changed.

### Setting the mark

`setApproval(context, pageId, state, version, by)` in `packages/api/src/operations.ts`. Refuses an agent actor with an error saying only a person can approve and how a person does it (console or `cairn approve`). Writes a revision with note `Approval: approved` (or the other states), `approvalVersion` = the page's current version, `approvalPrevious` = null.

Surfaces: console `POST /p/:id/approval` (a three-button form on the page view and on each review-queue row); REST `POST /pages/:id/approval` with the owner session or an OAuth token whose subject is the owner; CLI `cairn approve <id>`, `cairn disapprove <id>`, `cairn unmark <id>`, which the CLI sends as a person actor only when a person is at the keyboard (open question 1). No MCP tool, stated in the instructions the same way publishing is.

### Carry-over rule

On every write to a page whose `approval` is not neutral, `updatePage` compares the new body with the body at `approvalVersion`:

1. Small change: the title is unchanged, and the characters changed (added plus removed, from the same line diff `DiffView` uses) are at most 5 % of the approved body and at most 200 characters. The mark, `approvalAt` and `approvalVersion` stay. The revision note is suffixed with `(approval kept: small change)`.
2. Anything else: `approval` becomes `neutral`, `approvalPrevious` remembers the old state, `approvalVersion` stays so the console can diff against it. The revision note is suffixed with `(approval reset: was approved)`.

A person's own write follows the same rule, so an owner who rewrites a page re-approves it explicitly. A person can pass `keep_approval: true` on the console edit form to override.

### Reading

`get_page`, REST and `cairn read` return `approval`, `approval_at`, `approval_previous`. For a disapproved page the body is returned in full, preceded by one line: `Disapproved by the owner on 2026-09-24. Do not build on this page; say so if asked about it.` For neutral with `approval_previous: approved`: `Was approved; changed since by <actor> on <date>, not yet re-reviewed.`

### Search

In `searchPages`, after grouping into pages: multiply each page's score by 1.25 when approved, by 1.0 when neutral, and drop disapproved pages unless `include_disapproved: true` is passed (MCP `search`, REST `?include_disapproved=1`, CLI `--include-disapproved`). The console's search passes nothing and hides them too. Each page hit carries `approval`. The multiplier is a constant in `operations.ts` with the eval result beside it.

### Instructions, summary and skill

One paragraph in `packages/api/src/mcp/instructions.ts`, mirrored in `skills/cairn/SKILL.md`: approved means the owner checked it, prefer it; neutral means unchecked, treat like today; disapproved means wrong, never build on it and never copy it into another page. The summary gains a count: `12 approved, 3 changed since approval, 1 disapproved`.

### Review queue

`/review` in the console lists, in this order: pages neutral with a previous mark (changed since approval), then neutral pages last written by an agent, newest first, then never-approved pages by inbound links. Each row: title, collection, actor and date of the last write, a "since approval" diff link when there is a baseline, and three buttons that post the mark and return to the same row. The home page shows the count and links here. The Freshness screen stays; verification (facts re-checked) and approval (owner judgement) are different things and the page view shows both.

### Side-by-side diff

`/p/:id/v/:version?view=side` renders the same `Diff` as two columns: the previous version left, this version right, changed lines highlighted, unchanged context folded as today. CSS grid, stacks to one column under 700 px, no script. A button "Side by side" on every version page next to the existing inline diff, and "Changes since approval" on a page whose `approvalVersion` differs from its version, which opens the side view between those two versions (`?from=<approvalVersion>`).

### Sync, export, import

`pageContent()` in `packages/cli/src/sync.ts` carries the four fields. Export writes them into the page's front matter; import reads them. Unlike `public`, the mark is knowledge about the content, so it belongs to the content.

## Acceptance criteria

1. A new page has `approval: "neutral"` on every surface; the conformance suite covers the three columns.
2. `POST /p/:id/approval` from the console sets the mark and writes a revision whose note names the new state; the page view shows it with who and when.
3. `setApproval` with an agent actor fails with a message naming the console and `cairn approve`.
4. A write changing 3 characters of a 2,000-character approved page keeps the mark; a write changing 200 characters of a 1,000-character page resets it to neutral with `approvalPrevious: "approved"`; a title change resets it. Table-driven test.
5. `searchPages` ranks an approved page above an otherwise identical neutral one, and excludes a disapproved page unless `include_disapproved` is set; the same query gives the same order through MCP, REST, CLI and the console (extend `parity.test.ts` to the console).
6. `pnpm eval` before and after, per backend, recorded in the changelog; recall@5 does not drop.
7. `get_page` on a disapproved page returns the notice line first; on a changed-since-approval page the "was approved" line.
8. `/review` lists changed-since-approval pages first, and each row's buttons work without JavaScript.
9. `/p/:id/v/:version?view=side` renders two columns whose line counts match the inline diff; a phone viewport shows them stacked.
10. Two Cairns synced after an approval on one show the mark on both; export then import on an empty Cairn preserves it.
11. Instructions, summary and skill updated together; `pnpm context-cost` rerun and the README numbers updated if they moved.
12. Changelog, roadmap, `docs/CLI.md`, `docs/AGENT-OPERATE.md` (the review queue is an operation step).

## Risks and open questions

1. How the CLI tells a person from an agent. Today its writes carry the client name and a hook marks agent sessions. Proposed default: `cairn approve` refuses to run when `CLAUDE_CODE` or the hook's session marker is present, and otherwise sends `actor.kind: person`. Decide in ADR-078.
2. The 5 % / 200 character threshold is a guess. Log every carry-over decision in the revision note so a wrong threshold shows up in `/changes`.
3. Ranking boost interacts with reciprocal rank fusion; if 1.25 barely moves results, the eval will say so and the constant changes, not the design.
4. A disapproved page that other pages link to: the backlinks panel shows it, and `get_neighbours` returns it with its mark. Agents are told; nothing is hidden from the graph.
