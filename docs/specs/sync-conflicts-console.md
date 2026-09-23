# Spec: sync conflicts in the console

ADR-070. The gap `docs/ROADMAP.md` names, left out of ADR-030: a console list of records where a sync conflict took the newer edit for some part, with the version it replaced one click away.

## Goal

After running `cairn sync`, the owner can open the console and see every record a conflict ever touched, not just what scrolled past in the terminal, and reach the version that lost from there.

## Success test

Sync two Cairns that both edited the same page. Open `/changes?conflict=1` in the console. The page appears, newest conflict first, with the same note `cairn sync` printed to the terminal. Click through to that revision, then to the version it replaced, and read the older content.

## Scope

1. `DocumentStore.listRecentRevisions` (`packages/core/src/ports/document-store.ts`): a new optional `syncConflict?: boolean` filter.
2. `adapter-sqlite`'s implementation of that filter, plus the shared conformance suite (`packages/core/test/conformance`), per hard rule 2.
3. The console's `/changes` route (`packages/api/src/web/console.tsx`): a third toolbar chip, "Sync conflicts", combinable with the existing `who=agent`/`who=person` filter.

## Non-goals

1. No new REST endpoint, MCP tool or CLI command. ADR-070 decision 1.
2. No structured `parts`/`kept_from` fields pulled out of the note text. The note is shown as-is, like any other change note on `/changes`. ADR-070 decision 4.
3. No "last sync run" view. The list is a standing one across all history. ADR-070 decision 2.
4. No change to what `cairn sync` writes into the note today (`packages/cli/src/sync.ts`'s `note()`), beyond the code comment ADR-070 consequence 2 asks for.

## Design

### The filter

`listRecentRevisions(workspaceId, { limit, cursor, actorKind, syncConflict })`. When `syncConflict` is `true`, only revisions whose `note` contains the literal substring `"Sync conflict:"` are returned; when absent or `false`, behaviour is unchanged. `adapter-sqlite` adds this as another `AND` clause alongside the existing `actorKind` predicate in the same query, a plain `LIKE '%Sync conflict:%'` (SQLite's FTS index is for search, not this; this is an exact substring match on a column already being scanned for `actorKind`, no separate index).

A short code comment at the three note strings in `sync.ts`'s `note()` function and at this new filter cross-references the other, per ADR-070 consequence 2: changing one without checking the other silently breaks this feature.

### The console chip

`/changes` reads a `conflict` query param the same way it reads `who`. A third `chip(...)` call, "Sync conflicts", toggles `conflict=1`. The two filters combine (`who` and `conflict` both apply, both passed to `listRecentRevisions`). No change to the table markup, the per-row link, or pagination: they already work generically over whatever `listRecentRevisions` returns.

### "One click away"

Unchanged UI. A `/changes` row already links to `.../v/{version}` for that specific revision. That page's existing previous-version or diff control (whatever the per-record history view already renders) is the one click to the replaced version, exactly as it is for any revision. Verified against `packages/cli/test/sync-system.test.ts`'s chained-conflict scenario: the replaced content is always the immediately preceding revision in that record's history.

## Acceptance criteria

1. `listRecentRevisions(ws, { syncConflict: true })` returns only revisions whose note contains `"Sync conflict:"`, across pages, tables and rows, newest first, paginated the same way the unfiltered call is.
2. `listRecentRevisions(ws, { syncConflict: true, actorKind: "agent" })` combines both filters (AND, not OR).
3. Conformance test: every adapter that passes the shared suite returns the same filtered result for the same fixture.
4. `GET /changes?conflict=1` renders only sync-conflict rows; the chip shows pressed (`aria-pressed="true"`) when active, matching the existing `who` chips' pattern.
5. `GET /changes?conflict=1&who=agent` combines both.
6. A sync-conflict row's link goes to the winning revision; from there, the previously existing history/diff control reaches the version it replaced.
7. `docs/CHANGELOG.md` entry, `docs/ROADMAP.md` updated to mark this item done.

## Constraints

1. Hard rule 2: `listRecentRevisions`'s new filter needs the shared conformance suite covering it.
2. Hard rule 11: this is a derived, eventually-consistent read, same as the rest of `/changes` already is; no new consistency requirement.
3. ADR-009's console scope limits: still a plain table, no client script, server-rendered.
