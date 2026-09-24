# Spec: the console for notes

From the product review of 2026-09-24 (`docs/REVIEW-2026-09-24.md`) and the owner's direction the same day: make the console a place a person writes notes in, not only reviews an agent's writing; upgrade the editor preview. ADR to write on agreement: ADR-081 (Markdown extensions and console additions inside ADR-009).

## Goal

A person opens the console on a laptop and can write today's note, start a page from a template, see what they are writing as it will render, tick a checklist, delete or move a page, and land on a home page made for them, all without leaving ADR-009's limits.

## Success test

Open `/`: today's note, inbox count, review count, recent pages and five stale pages are there; "Connect an agent" is folded away. Press Today, write three lines with a callout, a toggle and two checklist items, press Preview: the right column shows them rendered. Save with Cmd+Enter. On the page view, tick one checklist item: the page saves a revision and the box stays ticked. New page from the "Meeting" template: the body arrives filled. Delete a scratch page from its view and undelete it from `/deleted`.

## Scope

1. Editor: preview column, save shortcut, callouts, toggles, task lists, tickable checkboxes on the page view.
2. Today in the navigation, previous/next day, `[[2026-09-24]]` resolving to that day's note, a time zone setting.
3. Template picker on New page.
4. Home page for the owner.
5. Delete, undelete, move and table creation from the console; upload through the dropbox form.
6. Action row: Publish and PDF under a "More" fold.
7. Freshness ranked by inbound links.

## Non-goals

1. No rich editor, no drag handles, no slash commands. ADR-009 rule 1 stands; BlockNote stays in Phase 2.
2. No link-by-title and no embeds here. They change the link contract and get their own spec and ADR (plan epic E5).
3. No page properties. Own ADR later.
4. No board, calendar or timeline views (PRD non-goal 1).

## Constraints

ADR-009 (forms, server rendering, progressive script only), ADR-075 (templates and daily notes), ADR-065 accepted but unbuilt (Mermaid stays out of this spec), hard rule 14 (delete, move, table creation already exist on the other surfaces; the console catches up), hard rule 17 (no raw control characters), hard rule 19 (the time zone setting is a new `CAIRN_` setting: `docs/AGENT-OPERATE.md` and the guide test).

## Design

### Editor and preview

The edit form becomes two columns on wide screens: the textarea left, the rendered preview right, one column stacked on phones. A "Preview" button posts the form with `preview=1` (exists today) and re-renders with the preview filled, nothing lost. With script: on a pause of 800 ms, `fetch("/p/:id/preview", { method: "POST", body })` returns the rendered fragment and replaces the column; the same route the button uses, so no second renderer. Cmd+Enter or Ctrl+Enter submits. The script lives in `console.js` under the existing dirty guard, ten lines.

### Markdown extensions

In `packages/api/src/web/markdown.ts`, plugins for `markdown-it`, raw HTML still off:

1. Callouts: GitHub alert syntax, `> [!NOTE]`, `> [!TIP]`, `> [!WARNING]`, rendered as `<aside class="ak-callout ak-callout-note">` with the label.
2. Toggles: a container `::: details Title` to `:::`, rendered as `<details><summary>Title</summary>`.
3. Task lists: `- [ ]` and `- [x]` as disabled checkboxes in the read view, each with `data-line`.

The same renderer serves the console, the published wiki and the preview, so the public wiki gains them for free; the static export too.

### Tickable checkboxes

On the page view, each task item is a tiny form: a checkbox and a hidden `line` and `version`, posting to `POST /p/:id/tick`. With script, the checkbox submits on change; without, a "Save ticks" button appears at the end of the list. The server flips `[ ]` to `[x]` on that line, writes a revision with note `Ticked: <item text>` (or `Unticked`), and redirects back to the anchor. Version conflict shows the usual two-versions page.

### Today

Nav gains "Today" linking to `/today`: shows the note if it exists, else a page with one button "Start today's note" posting to `getOrCreateDailyNote`. The daily note's view has previous and next day links (existing pages only; the next day is a button). `[[2026-09-24]]` in any body resolves to that day's note when it exists, as a link to `/today?date=` otherwise. `CAIRN_TIME_ZONE` (IANA name, default `UTC`) decides what "today" is, for the console, the CLI's `cairn today` and the MCP tool alike; documented in `docs/AGENT-OPERATE.md`, with `Europe/Rome` as the example.

### Template picker

`/new` reads the Templates collection and shows a select, "Blank" first. Choosing one and submitting calls `createPageFromTemplate` (ADR-075) with the given title and parent.

### Owner home

`/` for a signed-in owner: today's note (first lines, "open", "append"), counts for the Inbox and the review queue, the last ten changed pages, the five stale pages with most inbound links, then the collections grid. "Connect an agent" moves into a `<details>` at the bottom, open only when the workspace has no agent write yet.

### Delete, undelete, move, tables

Page view gains Delete (confirmation page, then `deletePage`) and Move (a form with a parent picker backed by search); `/deleted` lists deleted pages with Undelete. `/t/new` creates a table from a small schema form (name, fields as rows). All four call the operations the other surfaces use.

### Action row and Freshness

Edit, Add child, Today stay visible; Publish, PDF, Print, History fold under "More" (`<details>`), open by default on wide screens through CSS only. Freshness sorts never-verified pages by inbound link count, then age.

## Acceptance criteria

1. The edit form with `preview=1` returns the rendered body beside the textarea with the draft intact; `POST /p/:id/preview` returns the fragment for the same body; Cmd+Enter submits (script test with jsdom is enough).
2. The three extensions render as specified; raw HTML inside them is still escaped; the public wiki renders them identically.
3. Ticking a box writes one revision with the item text in the note and flips only that line; a stale version gives the conflict page.
4. `/today` with no note shows the start button and, after posting, the note; with `CAIRN_TIME_ZONE=Europe/Rome` at 23:30 UTC the note is dated tomorrow's CET date; `cairn today` and `get_today_note` agree with the console. `agent-guides.test.ts` sees the setting documented.
5. `[[2026-09-24]]` links to that day's note when it exists.
6. `/new` lists the templates and creates from the chosen one with placeholders filled.
7. The owner home renders every block from fixtures, and the "Connect an agent" fold is open only when no agent has written.
8. Delete, undelete, move and table creation each have a console contract test and reuse the shared operation (parity test extended to the console for these).
9. Action row: at 375 px only Edit, Add child and More are visible; at 1024 px everything is.
10. Freshness order test with three pages of different inbound counts.
11. Changelog, roadmap, `docs/CLI.md` if `cairn today` gains `--date`, `docs/AGENT-OPERATE.md` for the time zone, screenshots for the review.

## Risks and open questions

1. `markdown-it` container and task-list plugins add dependencies; check licences and size, or write the three as small rules in-house (they are).
2. The preview fetch is the second progressive script after table sort; ADR-081 states that scripts remain enhancements and every path works without them.
3. Time zone changes the daily-note title for existing users who set it after the fact: two notes for one day around the switch. Document; do not migrate.
