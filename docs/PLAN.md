# Plan: notes, approval, dropbox and the mobile app

From the product review of 2026-09-24 and the owner's direction the same day. Specs: `docs/specs/knowledge-approval.md`, `docs/specs/dropbox.md`, `docs/specs/mobile-capture-app.md`, `docs/specs/console-for-notes.md`. Status: specs and plan agreed by the owner on 2026-09-24. Sprint 0 done the same day; waiting on gate 1.

Rules: one outcome and one test per task; a sprint is a working increment; each sprint opens with its ADR and closes with the four logs, `pnpm build`, `pnpm test`, and for search changes `pnpm eval`. Tasks tick here as they close. Sizes are agent working sessions: S under one, M one to two, L three or more.

## Epics

1. **E1 Knowledge approval.** Marks, carry-over, review queue, ranking, side-by-side diff. Spec: knowledge-approval.
2. **E2 Dropbox.** Inbox, drop endpoint, drop tokens, console and CLI, agent processing. Spec: dropbox.
3. **E3 Console for notes.** Preview, Markdown extensions, ticks, Today, templates, owner home, delete/move/tables. Spec: console-for-notes.
4. **E4 Mobile capture app.** `/m`, manifest, share target, service worker, guides. Spec: mobile-capture-app.
5. **E5 Links for people.** Link by title, link picker, unlinked mentions, embeds. Spec to write; ADR needed. After E1 to E4.

Order: E1 before E2 so drops enter a workspace that already tells approved from unchecked. E2 before E4 because the app posts to the drop endpoint. E3 can run beside E2.

## Sprint 0: decisions (S)

1. [x] ADR-078 knowledge approval: model, person-only writes, carry-over thresholds, ranking constant, how the CLI knows a person is at the keyboard. Test: the ADR answers the spec's open questions 1 to 3.
2. [x] ADR-079 dropbox and drop tokens: Inbox as a well-known collection, server-side upload, token scope and kind. Test: answers dropbox open question 1.
3. [x] ADR-080 the mobile app: amends ADR-009 with one service worker and states its boundary. Test: ADR-009's rule 3 is quoted and the exception is one sentence.
4. [x] ADR-081 console for notes: Markdown extensions, the preview script, `CAIRN_TIME_ZONE`. Test: `docs/decisions/README.md` indexes all four; changelog entry.
5. [x] Roadmap section "Notes and approval" with every item at `next`. Test: `docs/ROADMAP.md` diff.

## Sprint 1: approval (E1, L)

Increment: the owner can approve, disapprove and review; agents rank and hide accordingly.

1. [x] Core model: four columns, migration, types, conformance test. Test: criterion 1.
2. [x] `setApproval` operation, person-only, revision note; REST route and the three CLI commands. Test: criteria 2 and 3.
3. [x] Carry-over rule in the core page write, table-driven thresholds. Test: criterion 4.
4. `searchPages`: boost and disapproved filter, `include_disapproved` on MCP, REST, CLI; parity test extended to the console. Test: criterion 5.
5. `pnpm eval` before and after per backend, numbers in the changelog. Test: criterion 6.
6. `get_page`, REST and `cairn read` show the mark and the notice lines. Test: criterion 7.
7. Console: approval buttons on the page view, `/review` queue, home count. Test: criterion 8.
8. Side-by-side diff view and the two buttons. Test: criterion 9.
9. Sync, export, import carry the mark. Test: criterion 10.
10. Instructions, summary, skill, `pnpm context-cost`, `docs/CLI.md`, `docs/AGENT-OPERATE.md`, changelog, roadmap. Test: criteria 11 and 12.

## Sprint 2: dropbox (E2, M)

Increment: text and files reach the Inbox from a shell and the console; agents process them.

1. Inbox well-known collection and `createDrop` operation with title rules. Test: unit test on title, body, tags, sources.
2. `POST /api/v1/drops`, multipart and JSON, server-side attachment upload, limits, `attachments_off`. Test: criteria 1 and 2.
3. Drop tokens table, `Authorization` check, scope refusal, `last_used_at`, revocation. Test: criteria 3 and 4.
4. Console `/inbox`, `/inbox/new`, file-away form, home count, `/settings/drop-tokens`. Test: criterion 5.
5. CLI `cairn drop`, `cairn drops`, `cairn drop-token`, `pnpm smoke:cli`. Test: criterion 6.
6. Summary count, instructions and skill paragraph, `pnpm context-cost`. Test: criterion 7.
7. Guides: `docs/AGENT-OPERATE.md`, `docs/CLI.md`, the person's guide with the `curl` recipe; changelog, roadmap. Test: criteria 8 and 9.

## Sprint 3: console for notes (E3, L)

Increment: a person writes and organises notes in the console.

1. Preview column, `POST /p/:id/preview`, Cmd+Enter. Test: criterion 1.
2. Callouts, toggles, task lists in the renderer; public wiki parity. Test: criterion 2.
3. Tickable checkboxes with revision and conflict handling. Test: criterion 3.
4. `CAIRN_TIME_ZONE`, `/today`, previous/next, date links, `cairn today` and `get_today_note` aligned, guide test. Test: criteria 4 and 5.
5. Template picker on `/new`. Test: criterion 6.
6. Owner home. Test: criterion 7.
7. Delete, undelete, move, table creation in the console; parity test. Test: criterion 8.
8. Action row fold and Freshness ranking. Test: criteria 9 and 10.
9. Screenshots at 375 and 1024, light and dark; changelog, roadmap, guides. Test: criterion 11.

## Sprint 4: mobile capture app (E4, M)

Increment: Cairn installs on a phone and captures offline.

1. `/m` layout and capture screen posting to `createDrop`. Test: criteria 1 and 2.
2. `/m/share` and the manifest with the share target. Test: criteria 3 and 5.
3. `/m/today`, `/m/recent`, `/m/search`, `/m/p/:id` with append, `/m/login`. Test: criterion 4.
4. Service worker: shell cache, queue, retry, Background Sync. Test: criterion 6.
5. JavaScript-off pass on every screen. Test: criterion 7.
6. Screenshots, guides for Android and iPhone including the Shortcut, changelog, roadmap. Test: criteria 8 and 9.

## Sprint 5: links for people (E5, L, after a yes on its own spec)

1. Spec and ADR-082: `[[Title]]` resolution rules, ambiguity error, edges still stored by id.
2. Resolver in the indexer and the renderer; error listing candidates.
3. Link picker in the editor backed by `searchPages`.
4. Unlinked mentions in the backlinks panel.
5. Embeds `![[page]]` and `![[page#heading]]` with a backlink edge.

## Gates and review points

1. After sprint 0: the owner reads the four ADRs and says yes or changes them. Nothing else starts.
2. After sprint 1: `pnpm eval` numbers reviewed; if recall@5 dropped, the ranking constant or the approach changes before sprint 2.
3. After sprint 3: a week of the owner writing daily notes in the console; the notes list what got in the way, and sprint 4 is re-planned against it.
4. After sprint 4: two weeks of phone capture; the Phase 1 kill criterion ("reach for it four days a week") is measured again with the drops count as evidence.

## Assumptions marked

1. Attachments are enabled on the owner's Azure Cairn (`CAIRN_ATTACHMENTS_TO` set); if not, sprint 2 task 2 is tested with S3-compatible local storage and the Azure setting is a deploy step.
2. The owner runs `cairn approve` only by hand; agent sessions carry the hook's marker (ADR-053), which is what the CLI uses to refuse.
3. The 5 % / 200 character carry-over threshold and the 1.25 ranking boost are starting values, expected to change once, from evidence.
