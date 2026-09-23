# Changelog

What changed, and why. Newest first. One entry per meaningful change: code, design direction or decision. The why matters more than the what: the code already records the what.

Entries link to the ADR when there is one. A change of direction that has no ADR yet still gets an entry here.

## 2026-09-23

**Added a crash-recovery system-test suite.** `packages/api/test/crash-recovery-system.test.ts` closes a gap none of the existing tests covered: `shutdown-signal.test.ts` proves the graceful SIGTERM path closes SQLite cleanly, and `recovery-ladder.test.ts` proves the recovery ladder's decision logic against a fully faked world, but neither puts a real process, really killed with SIGKILL mid-write, against a real on-disk SQLite database. That combination is exactly the scenario behind the Azure data-loss incidents in ADR-059 through ADR-063: a truncated transaction reaching the replica after an ungraceful kill. The new suite spawns the real server entry (`src/entry/node.ts`) against a real file-backed database, fires several hundred concurrent writes at it, SIGKILLs it mid-flight at varying delays (10-60ms, chosen so most writes are still in flight when the kill lands), and checks: the database file still opens and passes `PRAGMA integrity_check` afterward; a restart on the same file succeeds; and every write that received a 2xx response before the kill (tracked individually, not by count) is present after restart, with writes that never got a response left unconstrained. There is no standalone exported `sound()` check to reuse, it is inlined inside `recover.ts`'s `Ladder` object, so the suite reimplements the same two-line `DatabaseSync`/`integrity_check` logic directly rather than reaching for litestream. Plain `node:http` is used instead of `fetch`, because `fetch`'s undici connection pool can throw an unhandled `setTypeOfService EINVAL` when a request races the server socket being torn down by SIGKILL, which crashed the test worker outright; `node:http` surfaces the same failure as an ordinary request `error` event. No bug found: 5 new tests, run 10 times in a row with zero failures once the in-flight timing was tuned (an early version used a fixed number of writes with a longer delay, which let all of them complete before the kill and never actually caught one mid-flight; increasing to a few hundred writes with a 10-60ms kill delay fixed that). Run with `pnpm test -- crash-recovery-system.test.ts` from the repo root; `@cairn/api` has no `test` script of its own.

**Added a sync system-test suite.** `packages/cli/test/sync-system.test.ts`, alongside the existing `sync.test.ts` (single conflicts, single merges) and `merge.test.ts` (the pure merge algorithm), exercises `cairn sync` (ADR-023, ADR-030) at a higher level: multiple sync rounds with interleaved, non-conflicting edits on both sides; idempotency once a conflict has resolved; the same page conflicting and being resolved twice in a row, using the post-merge state as the new base each time; non-conflicting field-level merges chained across rounds; ADR-060's delete protection composing correctly alongside an unrelated real conflict in the same run; and a table row's per-field merge across two real round trips, ending in a genuine same-field conflict. Same harness as `sync.test.ts`: two real in-process `@cairn/api` Hono apps over `:memory:` databases, driven through the real CLI `run()`. No bug found; all 7 new tests pass alongside the existing 216-test CLI suite.

**Accepted ADR-069: GIF dropped from attachment thumbnails, correcting ADR-068.** `@jsquash/gif`, the fourth decoder ADR-068 named, does not exist on npm (confirmed against the registry and jSquash's own package list). Rather than silently substitute an unreviewed third-party fork, ADR-069 drops GIF from decision 6's thumbnail set until a real package is reviewed; PNG, JPEG and WebP are unaffected. `docs/decisions/README.md` and the status line on ADR-068 both updated in the same commit; per this project's own rule, the wrong fact is not edited away, only superseded.

**Built ADR-064 decision 6: best-effort WebP thumbnails, for three of the four raster types (ADR-068).** `packages/api/src/attachments-thumbnail.ts` decodes an uploaded PNG, JPEG or WebP with the matching `@jsquash/*` package, resizes to fit within 320px on the long edge with `@jsquash/resize`, and encodes the result as WebP. `confirmAttachmentUpload` (`packages/api/src/attachments.ts`) queues generation right after it flips a row to `committed`, fire-and-forget (`void ... .catch(() => {})`, the same shape `backup/engine.ts`'s `afterWrite` already uses): a slow or failed thumbnail never holds up or fails the confirm response. Every failure inside it, missing bytes, a bad image, a storage error, a version race, is swallowed on purpose; nothing is logged at error level, because a missing thumbnail is not an error anywhere in this system (decision 6's own words). The thumbnail lands as its own blob, the original's `blobKey` with a `-thumb` suffix, and a new `thumbnailKey` field on the row records it, null until it lands and null forever on failure. `get_attachment` (REST, MCP, CLI) now returns `thumbnail_url` next to `download_url`, resolved the same way and only once `thumbnailKey` is set.

Two extensions the ADR's original signed-URL-only design did not need: `AttachmentBlobStore` gained `put`/`get` for the server's own bytes, since this is the first thing Cairn's own process generates and writes rather than a caller PUTting directly, backed by a new `putBytes`/`getBytes` on `S3Archive` and `AzureBlobArchive` (single PUT/GET, not the block-list dance whole-database backups need, and with a real `Content-Type` the backup path's `put()` hardcodes). jSquash's codecs each `fetch()` their own `.wasm` file relative to their own module; Node's `fetch` refuses a `file://` URL, so `attachments-thumbnail.ts` patches `globalThis.fetch` once, for `file://` URLs only, to read the file instead — jSquash's own README calls its Node support "experimental" for exactly this reason. See `docs/LESSONS.md`.

**GIF is left out.** ADR-068 names `@jsquash/gif` as the fourth decoder; it does not exist on npm under that name, and is not one of the packages in jamsinclair/jSquash's own monorepo (checked against the registry and the repo's package list). Rather than silently substitute an unreviewed package, `image/gif` stays in the four accepted raster content types (decision 5 is unchanged) but never gets a thumbnail: `makeThumbnail` throws for it the same way a corrupt file would, and the caller already treats that as "no thumbnail this time." `docs/ROADMAP.md`'s attachments row is marked "GIF thumbnails blocked" until a developer picks a real package or ADR-068 is revisited. See `docs/LESSONS.md`.

New tests: 20 in `attachments.test.ts` (up from 14: one per raster type that generates a real thumbnail through the real codec, a corrupt-bytes case, the GIF gap, and a non-raster type), 2 more on `S3Archive`/`AzureBlobArchive`'s new `putBytes`/`getBytes`, the REST and MCP attachment contract tests extended for `thumbnail_key`/`thumbnail_url`, a new CLI contract test for `cairn attachment get`'s thumbnail line, and a new public-wiki test proving inline `attachment:<id>` rendering keeps using the original's signed URL even once a thumbnail exists (decision 6 is for a list of attachments, not inline rendering; changing that was out of scope). Full workspace suite green at 842 (up from 832).

**Built ADR-064 end to end: attachments, minus thumbnails.** A new `Attachments` table (`packages/api/src/attachments.ts`), found or created lazily on first use the same way `publish-tokens.ts` and `citations.ts` already do, since this codebase has no eager workspace init to hook into. Its table spec was missing a field the ADR's own lifecycle needs (pending vs committed) and got one, `status`, a `select` field with those two options, resolved inline rather than raised as a blocker. Two new signed-URL backends, `S3Archive.presignedUrl` and `AzureBlobArchive.sasUrl` (both in `packages/api/src/backup/`, extending the clients ADR-050 built for whole-database backups) plus a small dispatcher, `packages/api/src/attachments-blob.ts`, that turns `CAIRN_ATTACHMENTS_TO` into a `head`/`uploadUrl`/`downloadUrl` store, S3 or Azure chosen by URL scheme (`s3://` or `abs://`). The upload/confirm/get lifecycle from decision 3 is enforced in one place and reused by REST (`POST/GET /attachments`, `/attachments/:id/confirm`, `DELETE /attachments/:id`), five MCP tools (`create_attachment` through `delete_attachment`, none of which ever see the bytes, per hard rule 6), and `cairn attachment create/list/get`, which computes the file's SHA-256 with Web Crypto and PUTs straight to the signed URL with a bare `fetch` (hard rule 16). `attachment:<row-id>` is a new safe link scheme in the Markdown renderer (`packages/api/src/web/markdown.ts`), resolved to a signed download URL at render time by the console and the published wiki; a reference to a missing or unconfirmed attachment renders as marked-broken, the same convention an unknown page link already uses, rather than a dead link or a leak.

Decision 6 (WebP thumbnails, accepted alongside the rest of the ADR on 2026-09-19) was deliberately left out of this pass: no `thumbnailKey` field, no WASM image-codec dependency added. The row shape has room for the field later with no migration; building it is its own smaller task, not a redesign. `deleteAttachment` and `sweepAbandonedAttachments` (an hour-old pending row with no landed blob) never touch the blob itself, only the row, per decision 2's "content is immutable, garbage-collected separately, later" — no GC job exists yet, same gap the ADR's consequence 3 already named. `docs/AGENT-OPERATE.md` gained a `CAIRN_ATTACHMENTS_TO` entry, required by `packages/cli/test/agent-guides.test.ts`. New tests: 14 for the module (`attachments.test.ts`), 6 for the blob-store dispatcher against a local HTTP stub that checks the signed request actually reaches the right path and params (`attachments-blob.test.ts`), 3 REST contract tests, 4 MCP contract tests, 2 CLI contract tests, 2 for rendering on the public wiki.

**Warned before a slow remote CLI call.** The owner's direction of the same day. `cairn` now prints a stderr line, once `baseUrl` resolves to anything that is not `isLoopback`, saying it can take up to 30 seconds if the instance has been idle, before making the request. An Azure-hosted Cairn sleeps after idling and can take that long to wake, the same fact the existing "could not reach" error already names; this puts it up front instead of only after a timeout. Covers every command that reaches a named or auto-picked remote instance; `login`/`logout` return earlier and are unaffected. One new assertion in `packages/cli/test/instances.test.ts`; full workspace suite still green at 790.

## 2026-09-19

**Built ADR-066 end to end: token-gated publishing.** A new `PublishTokens` table (`packages/api/src/publish-tokens.ts`) holds a token's name, description and SHA-256 hash; the raw value is generated once, at creation, returned in that one response, and never stored or read back. Two new core functions, `gateRootOf` and `gatedIds` (`packages/core/src/publish.ts`), walk a page's ancestors the same way `publishedIds` already does, to find whether a token gates it and, if so, from where. `GET /w/:id` checks `?token=` or an `Authorization: Bearer` header against the page's gate root and answers the same 404 as an unpublished page on a miss, so a wrong token gives no signal that the page exists at all; `GET /w`, `/sitemap.xml` and `/.well-known/cairn.json` drop a gated subtree from their listings entirely, matching decision 7. Issuance and revocation are console, CLI and REST only, never MCP, the same line ADR-032 already drew for `publish` itself: `cairn publish-token create/list/revoke`, and `POST/GET /publish-tokens`, `POST /publish-tokens/:id/revoke`. Revoking a subtree's only token reopens it with no auth, exactly ADR-032 behaviour, since a token count of zero is not a special case, only what an empty lookup means. `listPublishTokens` makes no ordering promise: row ids are random and same-millisecond timestamps tie, so a "newest first" guarantee would need a monotonic counter this feature does not otherwise need. New tests: 9 for the module itself, 6 for the core walk functions, 10 for gating end to end on the public wiki, 3 REST contract tests, 4 for the CLI command; full workspace suite green at 790 tests.

**Drafted ADR-066 (token-gated publishing) and ADR-067 (email-verified guest sharing, design only).** ADR-066 amends ADR-032: a published subtree can carry one or more named, revocable tokens in a new `PublishTokens` table; no token issued still means no auth, and a token gates the whole subtree it was issued on, the same way `public` cascades. Console, CLI and REST get it; MCP does not, same line ADR-032 already drew for publishing itself. ADR-067 answers a follow-up question about per-person sharing (PRD P2 item 6): a guest proves an email address by signing in to a provider Cairn already trusts (Google, Microsoft, Apple, Facebook, all OIDC), reusing ADR-017's existing OAuth flow rather than building a second one, granted a `reader` role, Cairn's first role of any kind. Deferred by the owner, tracked as an ADR anyway so the shape holds until it's built.

**Added graph editing and narrowed blog/photo scope in the Phase 2 roadmap.** Two more owner directions landed as roadmap items: a person editing a tree or network diagram an agent wrote as text (Mermaid or DOT), writing structural changes back out as the same grammar; and a narrowing of the existing "more kinds of content" item, blog posts kept simple, a photo gallery only if the attachment thumbnail grid from ADR-064 turns out not to be enough by itself. Both gated on the editor, same as the kanban board added earlier today.

**Accepted ADR-064, added thumbnail previews, and scoped project tracking into Phase 2.** The owner accepted the attachments ADR and asked for image previews, so decision 6 was added: a best-effort WebP thumbnail generated from a WASM codec for the four raster content types, stored as its own blob and referenced by a `thumbnailKey` field, never blocking the upload it belongs to. The ADR's two other open questions (sharing a blob across pages, refusing SVG) were resolved with the recommended default rather than re-raised. Separately, a kanban board and Asana-style hierarchical tasklists were placed in `docs/ROADMAP.md`'s Phase 2, alongside the rich editor: the underlying `Tasks` table needs no new capability and can be built any time, but the interactive board and hierarchy view are exactly the client-side rich UI ADR-009 keeps out of the Phase 1 review console.

**Drafted ADR-064 (attachments) and accepted ADR-065 (the text-visualization stack).** ADR-064 proposes attachments as rows in a built-in `Attachments` table, blobs addressed by SHA-256, and uploads signed direct to blob storage rather than proxied through the API or an MCP tool call, following PRD P1 item 4; it is `proposed`, pending the owner's sign-off on cross-page blob sharing and refusing SVG uploads outright. ADR-065 settles what carries diagrams and charts as text: Mermaid for hand-authored diagrams (already the standing choice), Vega-Lite for charts generated from a table's own data, Viz.js for the console's own wiki graph view (backlinks, neighbours), and D3 kept out of content entirely. Everything without a text-native shape, blueprints, floor plans, scans, goes through ADR-064's attachments instead of being forced into a diagram grammar.

## 2026-09-18

**Reverted the source-built Litestream: its first restore corrupted a snapshot and lost 13 pages (ADR-063).** The mitigation deployed and verified earlier the same day turned out to have traded issue #1515's silent stall for a silent snapshot-corruption bug in the same unmerged branch, discovered only because the owner noticed Azure's console showing 2 collections instead of 3. The container's startup log showed the real story: a corrupt L9 snapshot triggered Cairn's own restore integrity check, which rolled the database back to 09:32 UTC and silently dropped 9 later replication points, the "Home Assistant & Homelab" collection and 10 more pages. Recovered with `cairn export --instance laptop` then `cairn import --instance azure` (13 created, 1 updated, 108 unchanged); `cairn sync`'s own dry run was tried first and would have propagated the loss by deleting those same 13 pages from the laptop copy, so it was not used. Dockerfile reverted to the pinned, checksummed 0.5.17 release; `CAIRN_BACKUP_AFTER_HOURS=0.5` stays, since it was not implicated. See `docs/LESSONS.md`.

**Deployed the ADR-062 Litestream mitigation to Azure and confirmed it live.** `ghcr.io/vespassassina/cairn:edge` (digest `8fee46d`), built from the CI run that also carried the undelete fix below, replaced the running image. A fresh L9 snapshot appeared at 12:35 UTC on startup, evidence the new `fillFollowGapFromSnapshot` path is in use, and a transaction then flowed through L0 and L1 into L2 by 12:40, the level that had been silently stalling under issue #1515. This is the first Azure deploy where L2 advanced without a manual push. ADR-062's verification standard is now met; see that ADR for the full record.

**Fixed the same random-UUID tie-break bug in `listRevisions` and `listRecentRevisions` that an earlier fix flagged but left alone.** Pushing the Litestream mitigation below surfaced it in CI: `undelete` calls `listRevisions(..., { limit: 1 })` to get a page's latest revision, and on a same-millisecond tie between a create and a delete, the old `ORDER BY created_at DESC, version DESC` picked the wrong one about half the time, since `version` is a random UUID with no time ordering. Switched the tie-break to `rowid`, SQLite's own monotonic insertion order, in `listRevisions`, `listRecentRevisions` and `listDeletedPages`'s list ordering, and moved the pagination cursor for all three from `[createdAt, version]` to `[createdAt, rowid]` to match. See `docs/LESSONS.md`.

**Tightened Azure's backup cooldown and built Litestream from an unmerged upstream fix for issue #1515 (ADR-062).** Two mitigations, chosen by the owner from ADR-061's options: `deploy/azure/deploy.sh` and `main.bicep` now default `CAIRN_BACKUP_AFTER_HOURS` to `0.5` on Azure, down from the app's own default of `3`, since that backup path does not go through Litestream and is unaffected by the bug, bounding the worst case to about thirty minutes of writes. The Dockerfile's Litestream stage now builds from source at a pinned commit on PR #1514 (`darkgnotic/litestream`, `fillFollowGapFromSnapshot`), instead of downloading the pinned 0.5.17 release tarball, since that PR's fix is confirmed by the bug's own reporter to resolve #1515 and no release carries it yet. Both are explicitly stopgaps: revert to a release-based Dockerfile and the higher backup default once Litestream ships a tagged fix.

### Traced the Azure loss to a confirmed, unfixed upstream Litestream bug, and caught a near-miss with a stale global CLI (ADR-061)

Continuing the same day's investigation: recovered the thirteen missing pages with `cairn sync --instance azure` (Azure back to 122 pages, verified with `cairn overview`), then watched the replica directly to confirm the recovery would actually hold, per the lesson this incident had already taught. It didn't. Within 17 minutes the container's own log showed `l0 retention enforced ... max_l1_txid=0000000000000080`, unchanged, while fresh level-0 files kept arriving from the recovery's writes: L0 retention was deleting the recovery, unread by level 1, using a stale high-water mark left over from before the 09-15 stall. A restart roughly 45 minutes later (most likely the 30-minute idle timeout) exposed the loss again, the same day, a third time. This traces to a confirmed, reproducible, open upstream bug, [Litestream issue #1515](https://github.com/benbjohnson/litestream/issues/1515): the follower's gap-bridging logic never consults the level-9 snapshot, so when it can't bridge a gap it silently stops advancing, logs nothing, and a restart resumes at the same stuck position. Explicitly affects 0.5.14, 0.5.16 and 0.5.17 (Cairn's pinned version); no fix is released, though two competing patches are open upstream ([#1516](https://github.com/benbjohnson/litestream/pull/1516), [#1514](https://github.com/benbjohnson/litestream/pull/1514)). ADR-061 records the confirmed cause and lays out mitigation options (upgrade when fixed, build against an unreleased patch, a replica-lag watchdog, or leaning on Cairn's own independent backups) for the owner to choose from; none is a Cairn code fix, since the bug is not in Cairn.

Also caught, before it caused real damage: re-running `cairn sync` for the recovery almost used the globally npm-installed `cairn` CLI, a stale install from 2026-09-15 that predates today's ADR-060 fix entirely. Its dry run proposed deleting the same thirteen pages from the laptop, exactly the bug ADR-060 exists to prevent. Caught by checking `cairn --version` and `readlink -f $(which cairn)` before trusting a dry run's output, and ran the sync instead through the freshly built `packages/cli/dist/bin.js`, whose dry run correctly showed fourteen `warning:` recreations and zero deletes. Took an independent safety-net export from the laptop (not Azure, since Azure's own copy is what's fragile) to `/tmp/cairn-azure-safety-net-*` as a stopgap while the upstream bug is unresolved, and started a background keep-alive ping to reduce (not eliminate) the chance of a near-term idle-triggered restart.

### Found the real cause of both Azure losses: a stalled Litestream replica, and extended `verifyDeletes` to rows (ADR-061, ADR-060)

After ADR-060's fix was deployed and synced, the owner reported the Home Assistant collection missing again: "so deployed and synced, i again have lost the online docs on home assistant collection." `cairn sync`'s state file showed `last_sync` unchanged since before the redeploy, ruling sync out. Listing Litestream's replica in Azure Blob Storage end to end (`az storage blob list`, not a truncated sample) found the real mechanism: compaction levels 1 and 2, which a healthy server writes every 30 seconds to 5 minutes, have no files between `2026-09-15T20:40:00Z` and `2026-09-18T08:18:36Z`, a 59.5-hour gap spanning the whole 2026-09-17 incident. Replication to the replica had stalled; every restart inside that window reverted to the stale `2026-09-15T20:40` point, discarding everything written since, repeatedly. This is the same mechanism behind both the 2026-09-17 loss (ADR-059) and this redeploy's repeat loss of the same thirteen pages, not two separate incidents. See ADR-061, which also records that no Log Analytics workspace is wired to the Container App, so the revisions that ran inside the gap left no retrievable logs to pin down what triggered the stall.

Separately, the owner asked for the general rule behind ADR-060 in plain terms: "let's assume that if a document has no guid in the other server, it has to be created and not deleted. no guid = create." Rechecking ADR-060's stated reason for excluding rows found it was wrong: it claimed rows have no history endpoint, but `GET /tables/:cid/rows/:rid/history` already existed, just unused by sync. Extended `verifyDeletes` (`packages/cli/src/sync.ts`) with a `historyPath` helper that picks the right history endpoint by the action's kind, so rows now get the same proof-before-delete treatment pages already had; added a test. Tables remain excluded by design: a table is one record, not a list, so its own absence already means it was deleted.

### PRD no longer calls Cairn a working name

The owner restated the name: "we keep the name cairn. a stack of documents". ADR-044 had already closed PRD Q5, but the PRD's opening line still read "Working name ... Rename freely", so the doc disagreed with the decision. Replaced it with the settled name and the owner's gloss, pointing at ADR-044. No code changed.

### Added "finish your own writes before you sync" to the ADR-060 sync guidance

The owner pointed out, after ADR-060 landed, that an agent should finish and save whatever it was writing (a `git commit` in a code repo, a pending Cairn write) before running `cairn sync --dry-run`, not after: a dry run only describes a side correctly when nothing is about to change under it. Added as `docs/AGENT-OPERATE.md` §5, point 2, ahead of the existing dry-run-first rule, which shifted to point 3 (later points renumbered to match; `docs/LESSONS.md`'s reference updated from §5.2 to §5.3).

### Fixed the real cause of the "eleven pages vanished" loss: `cairn sync` was deleting them, and stopped it (ADR-060)

Redeploying the ADR-059 fix and syncing per the owner's instruction turned up a second CI-visible bug first (`listDeletedPages` tie-breaking same-millisecond revisions by `version`, a random UUID, instead of `rowid`; fixed in `packages/adapter-sqlite/src/document-store.ts`, see `docs/LESSONS.md`). Running `cairn sync` after that fix deleted two more pages ("Home lab", "NAS Wake-on-LAN...") from the laptop, the one side that still had them. Investigating that deletion found `cairn sync`'s own log had recorded the same thing happening to all eleven pages from the 2026-09-17 loss, at `2026-09-17T21:48:33`, before this session started: `cairn sync`'s `plan()` (`packages/cli/src/sync.ts`) treats a record's absence from a live snapshot as proof it was deleted, and propagates that as a delete to the side that still has it. The eleven pages, checked on Azure, had no revision history at all there, not a soft delete: absence with no trace, exactly what the sync tool cannot distinguish from a real deletion. ADR-059's "Litestream generation inconsistency, leading suspect" was never actually tested; the sync tool's own record of what it did was.

Recovered all thirteen affected pages: `cairn undelete` on the laptop for all of them (their content was intact in laptop history, only soft-deleted by the bad sync runs), then `cairn import` (dry run first) from a fresh laptop export into Azure, since Azure had no history to undelete against. Fixed the sync tool itself: a new `verifyDeletes` step (`packages/cli/src/sync.ts`) checks, before applying any planned page deletion, that the side attributed with deleting it can show at least one revision for that page (`GET /pages/:id/history`, which survives a real deletion per ADR-059). No history means no proof; the action becomes a `put` that recreates the page on the missing side instead, reported as a warning in the sync output. Rows are not covered, since they have no history endpoint to check against (ADR-005); this is a known, narrower remaining gap. See ADR-060 for the full design, and the corrected note added to ADR-059.

Restarted the local `pnpm dev` server mid-investigation: it had been running long enough that it predated the `/pages/deleted` route entirely (a long-lived `tsx` process does not pick up source changes on its own), which is why an early laptop-side check failed with a routing error instead of the real answer.

### Recovered eleven pages lost on Azure, from the local laptop's history

The owner found eleven pages missing from the live Azure Cairn on 2026-09-17, with no trace in `cairn changes` or in any surviving page's history. Recovered their content from the local laptop's `cairn.sqlite` revision history (kept current via `cairn sync`), built a synthetic export folder with the recovered content at the pages' original ids, and ran `cairn --instance azure import` (dry run first, then for real): 11 created, 0 updated, 0 unchanged. Verified afterward with `cairn --instance azure read`/`history` on several of the pages that content, `[[wiki-links]]` between them, and parent/child structure (including reparenting under two existing Azure pages that were not part of the loss) all came back correctly. No code changed for this; it used the existing `PUT /pages/:id` create-or-replace-by-id endpoint from ADR-016.

Checked separately whether a delete failing to show up in history was a bug: a local end-to-end test (delete a page, read its history and the changes feed) showed the existing code already records and surfaces a deletion correctly. The Azure gap is best explained by the eleven pages never having gone through `delete()` at all, which is real data loss, not a code defect. See `docs/LESSONS.md` for what is and is not known about the cause.

### Undelete, a deleted-pages list, and per-page vacuum (ADR-059)

The owner asked to make a delete undoable from its history, to add a "deleted" list to every surface, and to add a `vacuum` command that removes a document's older revisions and compacts the database. All three reach MCP, REST and the CLI per hard rule 14:

- `list_deleted_pages` / `GET /pages/deleted` / `cairn deleted`: every page whose newest revision is a deletion, newest first.
- `undelete_page` / `POST /pages/:id/undelete` / `cairn undelete <page-id>`: brings a deleted page back at the same id with what it held before the delete, and keeps its pre-deletion history reachable by chaining the new revision's `parentVersion` onto the deletion revision instead of starting a fresh history. `writeWithRevision` (`packages/core/src/history/revisions.ts`) gained this as an override, since undelete is the first caller where the version used for the optimistic-concurrency check (`null`, since there is no current row) needs to differ from the version the new revision chains onto.
- `vacuum_page` / `POST /pages/:id/vacuum` / `cairn vacuum <page-id> --version V`: deletes every revision of one page except its current one and runs `VACUUM` on SQLite. Scoped to a single page, not the whole workspace, since that is what the owner's phrasing named and a workspace-wide sweep is a much larger, harder-to-reverse action nobody asked for. Requires the page's current version, checked, the same guard every other destructive write uses, even though vacuum itself does not change the version.

New error `PageNotDeletedError` (`packages/core/src/errors.ts`) distinguishes calling undelete on a page that still exists ("use restore instead") from calling it on an id with no deletion in its history ("check the id with `cairn deleted`"). See ADR-059 for the full design, including how `listDeletedPages`'s SQL correctly excludes a page that was undeleted since its last deletion.

## 2026-09-17

### Moved the agent-connect instructions from every page to the home page, and fixed their address

The owner reported the MCP link on the console's per-page rail was wrong: `http` where it should have been `https`. Cause: `AgentConnect` built its address from `new URL(c.req.url).origin`, the request's own scheme, but behind a proxy that ends TLS (Azure Container Apps, most reverse proxies) the container itself only ever sees plain `http`, so the command it handed out told an agent to connect over `http` to a server that only answers `https`. `registerConsole` already computes the right address for exactly this reason (`publicOrigin`, used by `originOk` and `secureCookie`); `AgentConnect` alone was left reading the request instead. Renamed it `ConnectSection`, built it from `publicOrigin` (falling back to the request's origin only when none is configured, as `public.tsx` already does), and moved it off every page's rail onto the collections home page as its own "Connect an agent" section, once, with both the MCP command and the CLI's install/register/login commands (`packages/api/src/web/console.tsx`). Added `packages/api/test/console.test.ts` coverage for a configured `publicOrigin` overriding the request's own scheme, and that the section no longer appears per page.

### Console sessions now renew on activity instead of always expiring after 7 days

The owner asked why the Azure console kept signing them out, and whether the session could "survive longer". The console's sign-in cookie (`packages/api/src/oauth/server.ts`) was a fixed 7-day JWT, signed once at login with a fixed `exp` and never reissued: it expired at the same wall-clock time whether the console was used daily or not at all. Rather than just lengthening the fixed duration, `verifySession` now returns a `renewed` cookie whenever the current session is more than half spent, and the console's sign-in middleware (`packages/api/src/web/console.tsx`) sets it on the response. A session in regular use is renewed for another 7 days on each visit past the half-life mark and never hits the wall; a genuinely idle session still expires 7 days after its last use. The original sign-in cookie and the renewed one now share one `sessionCookie()` helper so they stay identical in shape.

### Moved Add child and Publish into the page header, next to Edit

The owner asked for "Add child" (previously a small text link at the bottom of the rail) and the publish/unpublish toggle (previously its own button under "Published" in the rail) to sit next to Edit in the page header, styled like the other header buttons. `PublishControl` (`packages/api/src/web/console.tsx`) is split: a new `PublishButton` renders just the form and button, placed in the header's `.ak-row` alongside Edit, History and the PDF buttons; `PublishControl` keeps the explanatory text and status in the rail. The header button is omitted when a page above this one is what actually publishes it (nothing to toggle here in that case). The earlier header-row `flex-wrap` fix (below) is what lets this row take two more buttons without breaking.

### Gave the container-start test's setup hook more time on CI

`packages/api/test/container-start.test.ts` builds a 4000-row SQLite database in `beforeEach`, and its default 10s Vitest hook timeout had failed the whole file outright on `ubuntu-latest` and `ubuntu-24.04-arm`, on three separate unrelated commits (confirmed via `gh run list`, not a one-off: never reproduced locally, at 4.1s total). The most recent instance blocked the header-button CSS fix below from ever getting a new `:edge` image, so `deploy/azure/deploy.sh` twice reported deploying nothing. Raised the hook's timeout to 30s; the database build itself is unchanged. See `docs/LESSONS.md` for the investigation.

### A PDF button and an agent-connect button, both console-only

The owner liked a page-actions menu on another site (docs.fabricplan.com, GitBook) and asked to build the equivalent for Cairn's own pages. Reading that menu's actual link targets (not just its labels) showed it does two different things, not one: "Open in ChatGPT/Claude" seeds a public chat session with a public page's URL, and "Connect to VS Code/Claude Code" installs *that site's own MCP server* into a coding agent already running locally. Cairn already has both halves it needs for the second, better-fitting pattern: an MCP server (`/mcp`) and, since ADR-032, an owner-only publish flow for the first.

Built the pieces that were missing:

- **PDF export** (`Peptides` page detail, and the new `/p/:id/print` route). `window.print()` is already artifactkit's documented PDF path (`print.css`'s own comment: "0 kB, vector text... against ~180kB for jsPDF + html2canvas and objectively worse output"), so this adds no PDF library. A "PDF" button on the page view triggers it directly; a page with children also gets a "PDF (page + subtree)" link to `/print?subtree=1`, a dedicated view listing the page and every descendant, parents first (same order `GET /export/pages?root=` already uses), each on its own printed page. New Cairn-specific print rules hide the console's own chrome (top bar, tree, rail, breadcrumb) under `@media print`, since artifactkit's print.css only knows its own classes.
- **Open in an agent** (page detail rail, next to Publish). Prints the exact `claude mcp add --transport http cairn <origin>/mcp` command, with a copy button, and a "Connect to VS Code" link using VS Code's `vscode:mcp/install` URI scheme. The origin comes from the request, so the command is right whether this Cairn is reached at localhost or a deployed address, matching ADR-013 (MCP, REST and the CLI all reach the same server).

Console-only, deliberately, like Publish: printing and installing an MCP client are things a person does for their own tool, not something an agent does on their behalf, so there is no REST or CLI form and none is planned.

Not built: "open in an agent with the chat prepopulated to edit this page" (GitBook's ChatGPT/Claude buttons). That pattern only works on a *published* page (a public URL a hosted chat tool can fetch), and even then it seeds a read-only conversation, not an edit. The Claude Code / VS Code connect buttons already give a real, editable connection to a private page, which is the more useful case for Cairn's off-console pages; a public-page variant can follow later against `cairn publish` if it turns out to be wanted.

### `cairn server`: which address a command would use, for a person to open

The owner asked, while reviewing what Cairn already does, for a quick way to get the address of the Cairn a command would actually reach, to open its console in a browser. `cairn instances` already lists everything registered, but not which one would be picked right now among several. `cairn server` runs the exact same resolution every command already uses (`--instance`, `CAIRN_URL`, then the first registered instance that answers) and prints only the address, on its own line, so a terminal that linkifies URLs makes it one click.

### ADR-020's write-loss window, measured, plus a regression test and a staleness signal

The first real numbers for the question ADR-020 deferred: run locally against a `file://` Litestream replica, using the real `docker/start.sh` entrypoint, the real pinned Litestream 0.5.17 binary and the real `recover.mjs`, so nothing touched the live Azure deployment or its credentials. A graceful stop (SIGTERM, the shape a real container orchestrator uses) lost nothing across every run: SQLite's checkpoint on close, added for the 2026-09-15 outage (`docs/LESSONS.md`, ADR-046), leaves Litestream a finished file to ship. A hard kill (SIGKILL, an OOM or crash) lost only the writes made in roughly the last 840-930ms, bounded by Litestream's default one-second sync interval, and lost nothing at all once 2 seconds had passed since the last write.

Two fixes followed, per the owner's direction (`docs/DIRECTIONS.md`):

1. A CI regression test for the property that matters most: `.github/workflows/ci.yml`'s `image` job now writes a page, stops the container the way an orchestrator does, wipes its local volume to simulate Azure Container Apps' ephemeral disk, restarts against a `file://` replica, and asserts the page survived. Nothing before this exercised the full graceful-stop-then-restore path end to end; `shutdown-signal.test.ts` only checked the close half.
2. Staleness on the ordinary restore path. `recover.ts`'s `rewound` and `backup` outcomes already named the moment they landed on; the plain `restored` outcome, hit on every routine redeploy, said nothing about timing. `Ladder.latestMoment()` (`packages/api/src/recovery/ladder.ts`, `recovery/litestream.ts`, `entry/recover.ts`) now reports the newest point the replica held, quietly, without the full replica-history dump the `moments()` listing does for the rungs that are already diagnosing a problem.

A third option, moving `docker/start.sh`'s Litestream invocation to a `-config` YAML so `sync-interval` could be tuned below one second, was proposed and declined: the measured window is already sub-second and bounded, so it was not judged worth the added plumbing yet.

### README leads with a console screenshot

The launch checklist wanted the README to open with a picture of the console, not just the tagline. `docs/images/console.png` is a real page from the console's own "Cairn (the project)" collection: tree, body and rail, so the screenshot needs no fixture data and stays true as the console changes. Deliberately not a screenshot of the "Peptides" collection, which is the owner's own research and does not belong in a public repository.

### The missing LESSONS entry for fault 1 (console-and-search-polish)

Criterion 19 of `docs/specs/console-and-search-polish.md` asked for a `docs/LESSONS.md` entry for each of faults 1, 2, 4 and 7. Fault 1, the CLI printing REST's ETag/If-Match wording on a version conflict, was already fixed and tested; only its entry was missing. Added, closing out the spec's last open criterion. All six ADRs from the 2026-09-16 review (053 to 058) are now done.

### Search results are grouped by page, not by chunk (ADR-057)

Search used to return one result slot per matching chunk. A page with every term repeated across several sections could fill most of a small result list with itself, `diversify()` in `packages/adapter-sqlite/src/search-index.ts` only approximated grouping (each page's first chunk before any page's second), and a limit counted chunks rather than the pages an agent actually cares about finding. ADR-057 replaces that heuristic with real grouping one layer above the index.

`SearchIndex.search()` (the port in `packages/core/src/ports/search-index.ts`) is unchanged: it still returns raw chunk hits, ranked the same way as before, just without the `diversify()` reordering, which is deleted. `titleFirst()` (ADR-025, the query-equals-the-title boost) stays. Above it, `packages/api/src/operations.ts` gained `groupIntoPages()`, a pure function that turns chunk hits into one entry per page, its best passage leading with up to two more attached (a count of the rest travels alongside), and `searchPages()`, which re-runs the chunk-level query in growing batches (deterministic, so this is safe) until it has enough distinct pages to answer the requested limit, or gives up after 500 chunks. A page-level cursor just remembers how many pages were already delivered; the next call re-queries and skips that many.

REST's `/search` and the MCP `search` tool both call `searchPages()` and return the same new shape: `pages`, each with `page_id`, `score`, `passages` (at most three, each with `heading_path`, `snippet`, `score`), `more_passages`, and `verified_at`; `mode`, `truncated`, `cursor` and the empty-result `hint` are unchanged. The CLI's `search` command, a thin HTTP client with no logic of its own (hard rule 15), now prints each page once with its passages under it and a "(N more passages on this page)" line when there are more than three. MCP additionally spends its token budget on distinct pages before depth: `budgetPages()` (`packages/api/src/budget.ts`) fits as many pages as possible priced at just their lead passage, then spends whatever budget is left restoring full passages to already-included pages in rank order, so a third passage on an early page is dropped before a whole later page is.

The eval harness (`packages/api/src/cli/eval.ts`) was already deduplicating the raw top-k chunk hits into a page list for its own recall computation, unaffected by any of the above (ADR-057 consequence 3: the eval and rebuild paths want raw chunks and keep getting them). Added a second metric next to `recall@5`: `pages@5`, the mean number of distinct pages found among the top k chunk hits across every query, printed as `pages@${k}` in `formatReport`.

Contract tests added: no page repeats in a result list, and at most three passages are attached with a correct `more_passages` count, one test per surface (`packages/api/test/rest.test.ts`, `packages/api/test/mcp.test.ts`, `packages/cli/test/cli.test.ts`); a query held by exactly three pages returns exactly three, not truncated. The conformance suite's `diversify()`-era test ("shows each matching page before a second chunk of any page") was removed from `packages/core/src/testing/search-index-conformance.ts`: the guarantee it checked now lives one layer up, not in the port every adapter implements.

`pnpm eval`, before (this commit's parent) and after, SQLite backend: keyword recall@5 0.88 to 0.88, hybrid recall@5 0.97 to 0.97, both unchanged as expected, since removing `diversify()` only reorders chunks within a query, and search still returns the same pages, just found by an actual grouping pass instead of an approximation. The new `pages@5` metric has no prior value to compare against: 1.27 (keyword), 2.02 (hybrid).

`packages/adapter-sqlite/src/search-index.ts`, `packages/api/src/operations.ts`, `packages/api/src/budget.ts`, `packages/api/src/rest/routes.ts`, `packages/api/src/mcp/tools.ts`, `packages/cli/src/main.ts`, `packages/api/src/cli/eval.ts`, `packages/core/src/testing/search-index-conformance.ts`. No LESSONS entry: nothing here misled anyone or broke; it replaces an intentional but incomplete heuristic with the design ADR-057 already decided on.

Verification: `pnpm build`, `pnpm typecheck`, full test suite (719 passed, 1 skipped), `pnpm smoke:cli`, `pnpm eval` before and after, all green.

### The console works on a phone: one column, a collapsed tree, no sideways scrolling (ADR-056)

The review of 2026-09-16 found the console unusable on a phone: a fixed two-column grid, a page tree always expanded and taking the first screenful, 13px tap targets, and long titles or wide tables forcing horizontal scroll. ADR-056 called for a single-column layout below 700px with no client-side script, since the console (ADR-009) is server-rendered only.

`.cairn-page` drops to one column and the rail stacks below the body at that width. The page tree, already built from native `<details>`/`<summary>` for its branches (ADR-026), gained one more `<details class="cairn-tree-toggle">` around the whole tree, with a summary reading "Pages in this collection": closed by default, opening on tap through the browser's own disclosure widget, no script involved. Its summary is hidden and its content forced visible above the breakpoint, so desktop is unchanged. Tree links and the top navigation gained a 44px minimum tap height below the breakpoint. Long page titles now wrap instead of forcing a scrollbar (`overflow-wrap:anywhere`, plus `min-width:0` on the flex ancestors that were refusing to shrink), and markdown tables scroll inside their own box the way code blocks already did, rather than widening the page.

Making the tree's visibility survive a closed `<details>` surfaced a genuine CSS bug, written up in `docs/LESSONS.md` today: Chromium hides closed `<details>` content through an internal `::details-content` box, not by setting `display:none` on the children, so the first version of this fix looked right in `getComputedStyle` but rendered as an empty column. Fixed by also overriding `content-visibility` on that pseudo-element, scoped above the breakpoint so the tree still defaults to closed on the phone layout itself.

A second overflow turned up the same way, live in a browser rather than in a test: `.ak-pagehead` (artifactkit) is `display:flex; flex-wrap:nowrap`, so once the title could shrink (`min-width:0`, added for wrapping long titles) the Edit and History buttons no longer fit beside it below 700px and pushed 24px past the viewport edge. Fixed with `.ak-pagehead{ flex-wrap:wrap }` inside the phone media query, so the buttons drop to their own row instead.

`packages/api/src/web/assets.ts`, `packages/api/src/web/console.tsx`, tested in `packages/api/test/console.test.ts` (acceptance criteria 3 and 4). Criteria 1 to 3 (no horizontal scroll at 375, 320 and 1280px across all five views) were checked live against a running console rather than by an automated test, since jsdom does not compute real layout: `document.documentElement.scrollWidth` measured against `clientWidth` for the collections, page, search, tables and freshness views at each width, all equal (no overflow) after the pagehead fix. No LESSONS entry required by criterion 19 (not one of the eight numbered faults), but one was added anyway per coding style rule 5, since the `<details>` bug was a real bug that misled a `getComputedStyle` check.

Verification: `pnpm build`, `pnpm typecheck`, full test suite (715 passed), `pnpm smoke:cli`, live check in a browser at 320px, 375px and 1280px across all five views, all green.

### The console footer now shows the instance, page count and last backup (ADR-056/057, fault 8)

`cairn status`'s facts were nowhere a person looking at the console could see them, and the spec asked for exactly three of them in the footer: the instance, the page count and when the last backup ran. Re-reading the spec text showed this only needed the console footer to change, not `cairn status` itself: `packages/cli/src/status.ts` already documents page count and backup age as deliberately out of `cairn status`'s scope (ADR-053 decision 4), and the console runs in the same process as the backup engine and document store, so it can read both directly without going through `/health` or a new CLI field.

Added `BackupEngine.lastBackupAt()` (epoch ms of the newest backup, 0 if none yet, null if not known), threaded through `AppOptions.backupStatus` and `entry/node.ts` to `ConsoleOptions.backupStatus`, alongside `ConsoleOptions.selfDescription` for the instance name. Rather than thread a new prop through the 21 call sites that build a `<Layout>` in `console.tsx`, `layout.tsx` gained a single module-level `setFooterFactsProvider`, called once by `registerConsole`, which `Layout` (now an async component) awaits once per render. Exactly one console runs per process, and the test suite runs sequentially, so a singleton carries the value safely without an `AsyncLocalStorage` with no precedent elsewhere in the codebase.

Making `Layout` async surfaced an unrelated latent bug in `render()`: a `JSXNode.toString()` that resolves asynchronously returns a `Promise`, which a template literal cannot stringify, and previously would have thrown `Internal Server Error` the moment any console page grew an async child. Fixed `render()` to resolve that promise before interpolating.

`packages/api/src/backup/engine.ts`, `packages/api/src/app.ts`, `packages/api/src/entry/node.ts`, `packages/api/src/web/console.tsx`, `packages/api/src/web/layout.tsx`, tested in `packages/api/test/console.test.ts` (acceptance criterion 18). No LESSONS entry: fault 8 is not in criterion 19's list.

Verification: `pnpm build`, `pnpm typecheck`, full test suite (714 passed), `pnpm smoke:cli`, all green.

### An unreachable Cairn now says why it tried the address it tried (ADR-056/057, fault 7)

"cannot reach Cairn at http://localhost:8787" named an address but never said that address was a default, chosen because nothing else was given, which coding style rule 2 requires. Added an optional `chosenBecause` to `CairnClient`'s options, set in `main.ts` where `baseUrl` itself is chosen: empty when `--instance` or `CAIRN_URL` named it explicitly, the instance's name when `firstReachable` picked one of several registered instances because none was named, and "the default, since no --instance, CAIRN_URL or registered instance was given" when nothing at all was configured. The unreachable error now appends it. `packages/cli/src/client.ts`, `packages/cli/src/main.ts`, tested in `packages/cli/test/client.test.ts` and `packages/cli/test/cli.test.ts` (acceptance criterion 17). LESSONS entry added.

Verification: `pnpm build`, `pnpm typecheck`, full test suite, `pnpm smoke:cli`, all green.

### An empty search result now names the query and suggests a next move (ADR-056/057, fault 6)

The CLI already suggested trying a synonym on no matches, but didn't say what it had searched for; the console's empty banner and REST's JSON response said even less. All three, plus the MCP tool's existing `hint` field, now name the query in the message: `Nothing matched "words". Try synonyms, a shorter query, or one distinctive word.` (REST gained the `hint` field it lacked, matching MCP, per hard rule 14). `packages/cli/src/main.ts`, `packages/api/src/web/console.tsx`, `packages/api/src/rest/routes.ts`, `packages/api/src/mcp/tools.ts`, tested in `packages/cli/test/cli.test.ts`, `packages/api/test/console.test.ts`, `packages/api/test/rest.test.ts`, `packages/api/test/mcp.test.ts` (acceptance criterion 16).

### The `search` tool no longer calls its own output an input (ADR-056/057, fault 5)

The `search` MCP tool's description read "when `mode` is hybrid", phrasing that makes `mode` sound like a setting the caller chooses. It is the result's own field, reporting which strategy answered (hybrid or keyword), not something `inputSchema` accepts at all. Reworded the description to say plainly that `mode` comes back in the result and is not a setting. `skills/cairn/SKILL.md` and `packages/api/src/mcp/instructions.ts` do not mention `mode`, so neither needed a change (acceptance criterion 15). `packages/api/src/mcp/tools.ts`. Ran `pnpm context-cost` per rule 8: the tool list moved from about 3,738 to 3,777 tokens, too small to change the README's rounded figures.

### The reported apostrophe-dropping snippet bug does not reproduce, and is now a regression test (ADR-056/057, fault 4)

Fault 4 of `docs/specs/console-and-search-polish.md` had no established cause, and the spec calls that out as a real risk: fixing the wrong thing, or fixing something already fixed, would be worse than leaving it open. Traced the candidate causes the spec names (stored-text normalisation, a typographic apostrophe handled differently from a straight one) and several more (query tokenization, console HTML escaping, MCP/REST pass-through) through the code, then reproduced the full `SqliteSearchIndex.search()` path end to end with both apostrophe forms, several query terms, and forced snippet-window boundaries. None reproduced the symptom: FTS5's `snippet()` correctly copies the original stored text verbatim, apostrophes included, under the current SQLite version (3.53.4) and tokenizer (`porter unicode61 remove_diacritics 2`). No code change follows, since no fault was found. Added a regression test asserting a snippet built from either apostrophe form keeps it, so the behaviour stays pinned. `packages/adapter-sqlite/test/search-index.test.ts` (acceptance criterion 14). LESSONS entry added.

Verification: `pnpm build`, `pnpm typecheck`, full test suite, `pnpm smoke:cli`, all green.

### The CLI stops repeating itself on a conflict, a bad filter field is refused by name, and a note-less write says so (ADR-056/057, faults 1 to 3)

Begins the "eight smaller faults" from `docs/specs/console-and-search-polish.md` (ADR-056, ADR-057). Three of the eight are done.

1. **A version conflict at the CLI no longer says the same thing twice.** REST's own conflict wording ("Read it again, merge your change, and retry with the new ETag in If-Match") is correct for a REST client but meaningless at a terminal, and the CLI printed it verbatim followed by its own "current version: ..., read again and retry" line, so the same instruction appeared twice with different words. The CLI's error renderer now keeps only the first sentence of the server's message (which names what happened) and states its own next step once. `packages/cli/src/main.ts`, tested in `packages/cli/test/cli.test.ts`.
2. **`cairn rows --where "nosuch eq 1"` (and the equivalent REST and MCP query) now refuses an unknown field by name instead of silently matching nothing.** `matchesCondition` could not tell "the field does not exist" from "the field is null on every row," both read as `null`. Added `validateQuery` to `packages/core/src/query/validate.ts`, using the same "unknown field. known fields: ..." wording `validateRow` already uses for row values, and wired it into `TableService.queryRows` in `packages/core/src/services/tables.ts` ahead of both the pushdown and in-memory paths. REST, MCP and the CLI needed no surface-specific change: all three already turn a thrown `ValidationError` into a named-field error. Tested in `packages/core/test/query.test.ts` and `packages/cli/test/cli.test.ts` (acceptance criterion 12).
3. **A write with no change note now says so, instead of passing silently.** MCP tools already require a note; the CLI and the console did not, and gave no sign either way. The CLI's seven note-optional write commands (`create`, `append`/`write`/`replace-section`, `delete`, `publish`/`unpublish`, `move`, `restore`, `upsert`) now print "no change note given. Add --note ..." on stderr when `--note` is missing, and still succeed (a hard failure would break scripts, for a rule that is about hygiene, not correctness). The console's four history views show "no note given" in place of a blank where a revision has none. `packages/cli/src/main.ts`, `packages/api/src/web/console.tsx`, tested in `packages/cli/test/cli.test.ts` and `packages/api/test/console.test.ts` (acceptance criterion 13).

LESSONS entries added for faults 1 and 2 (fault 3 is not one of the four the spec calls out for a LESSONS entry).

Verification: `pnpm build`, `pnpm typecheck`, full test suite (706 passed, 1 skipped), `pnpm smoke:cli`, all green.

### An agent can walk the tree, and MCP catches up with REST and the CLI (ADR-058)

Implements ADR-058, per `docs/specs/agent-navigation.md`. An agent connected only through MCP could not see the page tree at all: the only way to ask what is under a page was `GET /api/v1/pages?parent=` on REST, and MCP was also missing delete, the changes feed, and the ability to change a table's schema, while `create_table` alone among writes took no change note.

1. **`list_children`**, new on all three surfaces: given a page, its immediate children, each with id, title, whether it has children of its own, and when it last changed, paged with a cursor; given nothing, the top-level pages (the collections). MCP: the `list_children` tool. REST: `GET /pages?parent=` (unchanged when `parent` is absent, so export and sync keep their existing full-list behaviour). CLI: `cairn ls [page-id]`, and `cairn collections` is repointed to the same call (a breaking change from its ADR-026 meaning as an alias for `cairn tables`, which the spec's acceptance criteria call for directly).
2. **Reading a page reports its children.** `get_page` (MCP), `GET /pages/:id` (REST) and `cairn read` (CLI, rewritten from consuming the Markdown response to the plain JSON one so it can add a children block) all cap the list at 8 with a count of the rest and point to `list_children` for more.
3. **`delete_page`**, new on MCP (REST and the CLI already had it): takes a version token and a required change note, refuses a page that still has children and says how many, and its description says history is kept and `get_revision` still reaches the deleted page's past content.
4. **`get_changes`**, new on MCP: the changes feed REST and the CLI already served, newest first, with `since` and `actor_kind` filters and a cursor.
5. **`update_table`**, new on MCP: renames a table, replaces its fields, moves it, or changes its description, given its current version.
6. **`create_table` now requires `change_note`**, on MCP and REST, matching every other write. This broke every table-creating call site that had never needed one: `cairn trust` and `cairn discover`'s embedded table creation, `cairn sync`'s table-sync `PUT`, and six REST and MCP tests, all fixed to pass one.
7. **Tables carry a `description`.** Returned by `list_tables`, shown by `cairn tables`, round-tripped through `cairn export`/`cairn import`.
8. **`cairn create-table` and `cairn update-table`**, new CLI commands. Neither existed before this ADR: the only CLI code that created a table was embedded inside `trust` and `discover` as an implementation detail. Hard rule 14 asks for a reason before a capability is missing from a surface, and none applied here, so both commands were added rather than exempted. Fields are given with a compact spec, the same shape `cairn tables` already prints them in: `name:type[(opt,opt)][->target][[]][*]`, for example `--field "status:select(open,closed)*"` or `--field "owner:relation->pages[]"`. `cairn history` and `cairn revision` also gained the `table-id/row-id` form `cairn links` already had, since MCP's `get_history`/`get_revision` cover rows and the CLI did not.
9. **The cross-surface parity test**, `packages/api/test/parity.test.ts`: static analysis over the three surfaces' source text (tool names in `mcp/tools.ts`, route method+path in `rest/routes.ts`, command names in the CLI's `main.ts`), mapped onto a canonical capability list, failing when a capability reaches one surface and not the others unless an allow-list entry names the ADR that excuses it. The allow list's first entries are `restore` (ADR-045: a human action, deliberately absent from MCP) and `status`, `hook`, `sync`, `instances`, `start`, `import` (presence.md: these describe or change the local machine running the CLI, not a Cairn workspace). A test proves the check actually fails by removing a name from each surface's extracted set in turn and asserting the check throws.

New contract tests in `packages/api/test/mcp.test.ts` cover `list_children` (immediate children only, title order, cursor), `list_children` with no page agreeing with the REST route `cairn collections` calls, `get_page`'s capped children block, `delete_page` succeeding, refusing a page with children, and refusing a stale version, `create_table` refusing a missing change note by name, and `update_table` and `get_changes` each with a realistic payload.

`pnpm build`, `pnpm typecheck`, the full test suite (703 tests) and `pnpm smoke:cli` against a freshly compiled Bun executable all pass.

### A sign-in survives a lost race and a slow start (ADR-054)

Implements ADR-054, per `docs/specs/sign-in-resilience.md`. Fixes the defect found on 2026-09-16: the owner's stored Azure sign-in had been deleted with 28 days left on its refresh token, caused by two bugs that only destroy a sign-in together.

1. **Server** (`packages/api/src/oauth/server.ts`): the refresh branch's comment claimed the replay record was written before the used record's check, which is true, but it is not written before `issueTokens` finishes, and `takeAuth` deletes the grant before that write lands. A second request racing the first in that gap saw no grant, no replay record and no used record, and was wrongly refused as `invalid_grant`. The branch now polls for the replay record for up to `REFRESH_RACE_WAIT_MS` (1000ms, 25ms interval) before concluding the token is genuinely unknown, and skips the wait entirely once a used record already exists, so ADR-033's theft detection stays immediate. Four new tests in `packages/api/test/oauth.test.ts` drive two concurrent refresh requests through an `AuthStore` whose `putAuth` is artificially delayed, proving both requests succeed with the same tokens when the delay is short, and that the loser fails after its own bounded wait rather than hanging when the delay is longer than the wait.
2. **Client** (`packages/cli/src/login.ts`): `storedToken`'s refresh now classifies a failure into three cases instead of catching everything into one deletion. Only a parsed `invalid_grant` response deletes the credentials; any other HTTP error or a network failure (timeout, connection refusal, an unparseable body such as a proxy's HTML page) throws a new `RefreshFailed` error and leaves the credentials in place. The refresh request gets its own 30 second timeout (`REFRESH_TIMEOUT_MS`, longer than Azure's roughly 25 second cold start) via `AbortSignal.timeout`, with one retry on a connection-level failure. `writeCredentials` now takes one server's key and entry rather than the whole file, and re-reads the file immediately before writing, so a process that was asleep refreshing cannot overwrite an entry another process wrote in the meantime. `main.ts` no longer silently swallows a refresh failure: a `RefreshFailed` is printed to stderr with the instance, the address, and the next step (`cairn login --instance <name>` for a real `invalid_grant`, otherwise "try again, or run cairn status"), and the command continues without a token rather than failing outright, since many commands do not need one.

New tests: `packages/cli/test/refresh-resilience.test.ts` covers all three non-`invalid_grant` failure shapes (connection refusal, HTTP 500, unparseable body, simulated timeout) asserting the credentials file is byte-for-byte unchanged and the message names the instance and next step, plus `invalid_grant` deleting credentials and naming the login command, and a concurrency test proving two refreshes for different servers finishing out of order do not erase each other's entry.

`pnpm build`, `pnpm typecheck`, the full test suite (667 tests) and `pnpm smoke:cli` against Node and a freshly compiled Bun executable all pass. The pre-existing OAuth end-to-end tests pass unchanged, per acceptance criterion 10.

### Cairn is reachable and known without anybody having to remember it (ADR-053)

Implements ADR-053, per `docs/specs/presence.md`. Three pieces:

1. **`cairn hook install`** (`packages/cli/src/hook.ts`, new): adds a Claude Code SessionStart hook that runs `cairn overview --brief`, so a fresh session opens already knowing what the workspace holds. It reads and writes `~/.claude/settings.json`, touching only its own tagged entry (`_cairn: "cairn-overview"`) and leaving every other key byte-identical, since that file belongs to Claude Code, not Cairn. Prints the exact change and asks before writing, the same shape `cairn sync install` already uses; `--yes` skips the question. `cairn hook status` and `cairn hook uninstall` complete the set.
2. **`cairn overview --brief`**: the `/overview` route takes a `brief=true` query param that bounds the summary to `BRIEF_OVERVIEW_BUDGET` (800 characters, about 200 tokens) instead of the usual 4,000. Against the owner's own 105-page workspace it comes back at 503 characters, naming both tables and both collections. When Cairn cannot be reached, `overview --brief` exits zero and prints one line naming `cairn start`, because a session hook has nowhere to report a failure and should never block the session it is starting.
3. **`cairn status`**: one screen, `packages/cli/src/status.ts`, for whether Cairn is actually reachable, replacing five separate things to check by hand. Reports the instance, sign-in, sync with other registered Cairns, embeddings pending, the scheduled job, and the session hook; every not-ok line carries its fix command. Sign-in and job state come from local files, so they are still reported even when the server itself cannot be reached, which is what lets it show three simultaneous problems in one run. A new `peekCredentials` in `login.ts` reads the credentials file without the side effects `storedToken` has (refreshing, deleting on failure), since a status check must not sign anyone out just by running.

The scheduled job (`packages/cli/src/schedule.ts`) now runs `cairn start` instead of `cairn sync` on all three platforms, so a laptop that was off overnight starts itself before syncing rather than syncing nothing. `cairn status` notices a job file that still says `sync` and says to reinstall.

Two things from the spec's design are scoped down, noted in `docs/specs/presence.md` itself: the embeddings-pending line reports a plain count rather than a trend, since one invocation has no earlier run to compare against; and database size and last-backup age are left out of `/health` entirely, since `BackupEngine`'s last-backup time is a private field with no accessor and wiring it through `app.ts` and `entry/node.ts` is its own piece of plumbing.

`docs/AGENT-OPERATE.md` and `docs/CLI.md` both open their health checks and troubleshooting with `cairn status`. `pnpm build`, `pnpm typecheck`, the full test suite (656 tests, including new coverage for `hook.ts`, `status.ts` and the CLI wiring), and `pnpm smoke:cli` against both the Node path and a freshly compiled Bun executable all pass.

### The workspace summary gets its own guaranteed budget, so it stops going empty on a real workspace (ADR-055)

Implements ADR-055. `buildInstructions` used to give the summary whatever was left of a 2,200 character total after the fixed instructions, which on the owner's 104-page workspace was 303 characters: enough to name no collections at all. `SUMMARY_BUDGET` (700 characters) is now a floor the summary always gets, and `FIXED_INSTRUCTIONS_CEILING` (1,500 characters) bounds the fixed text so it can never eat into that floor again; a test enforces the ceiling directly rather than relying on someone noticing the total creep up. `INSTRUCTIONS_BUDGET` moved to 2,400 to cover both with room to spare, and `SERVER_INSTRUCTIONS` was rewritten from 1,895 to 1,418 characters, moving detail that already lives in `skills/cairn/SKILL.md` out of the text every MCP session pays for.

The section-truncation logic changed too, per ADR-055 decision 4: `fitLines` now reports how many items it actually named, not just the lines it kept, and a section with fewer than three named items is dropped whole instead of shown as a bare "and N more" stub. A stub with nothing named above it cost characters to say nothing. Pages count, then collections, then tables, then tags, spent in that order against the fixed floor rather than pre-reserved shares.

New tests reproduce the defect at the scale it was found at: a generated 100-page, 12-collection, 2-table, 20-tag workspace, asserting at least three collections are named and the whole text still fits `INSTRUCTIONS_BUDGET`. `pnpm build`, `pnpm typecheck` and the full test suite (637 tests) pass. `pnpm context-cost` still reports about 3,100 tokens for MCP, unchanged within rounding, so the README numbers stand.

A table `description` field was sketched into the summary while writing this, ahead of the schema change ADR-058 will bring; removed, since `core`'s `Table` type does not have that field yet and it does not belong in this commit.

### A review of Cairn as a tool, and the six decisions and four specs it produced

The owner asked for a review of the app and for fixes that would make the tool really useful, then for the fixes to be analysed and written up as ADRs, specs and a roadmap. This entry covers the writing. No code changed.

The review was done by hand against the running system rather than by reading it: the owner's laptop copy of 104 pages, the console at a desktop width and at 375 pixels, a live MCP initialize over curl, and the CLI driven adversarially against a throwaway database on a second port so the real workspace was untouched.

What it found first was not a bug. On the owner's own machine, on that day, nothing could reach Cairn. The server was not running. No `cairn` MCP server was registered in Claude Code. The stored Azure sign-in had been deleted by the CLI. No sync job was installed and the last sync was two days old. The last write to the workspace was 2026-09-14, while two days of work on the recovery ladder, the shutdown fix and ADR-052 left no trace in it. Every one of those pieces exists and works; each is a one-time act of setup that decays silently, and nothing notices. That matters beyond the inconvenience, because the Phase 1 kill criterion in the PRD is whether Claude reaches for Cairn four days a week, and it had been measuring an instrument that was switched off. The two week clock restarts once the first two items below are in place, and the roadmap now says so.

Then the bugs, each traced to the line responsible rather than reported as a symptom.

The sign-in that deletes itself is two defects that compound. In the refresh branch of the OAuth server, `takeAuth` deletes the grant and only then are the tokens issued and the replay record written, so a second refresh arriving in that gap finds no grant, no replay and no used record, and is told `invalid_grant`. The comment above the write claims the replay record is written first; it is written first relative to the used record, which is what ADR-033 decision 4 asked for, and that sentence is what hid the defect for two days. Meanwhile the CLI's `storedToken` wraps the whole refresh in a `try` whose `catch` deletes the credentials, so any failure at all lands there, including a timeout against an Azure container that takes about 25 seconds to answer its first call. Together, a losing process erases the fresh tokens the winning process just wrote. Agents run CLI commands in parallel, so this is the ordinary case and not the rare one. ADR-054.

The workspace summary that ADR-012 exists to provide is empty on a real workspace, and the cause is arithmetic. The budget is 2,200 characters for the whole text, the fixed instructions are 1,895, and the summary gets the remainder. A live initialize against 104 pages returned "and 2 more collections" and a single tag, naming nothing. It was invisible for four days because the tests build summaries for small workspaces, where 303 characters is plenty: the summary degrades exactly as the workspace becomes worth summarising. ADR-055.

The console is unusable on a phone, from one line. Cairn's own CSS has a single layout breakpoint, at 1,100 pixels, below which the page tree keeps a fixed 200 pixel column all the way down. At 375 pixels the body gets about 120 pixels, and the search field's 260 pixel minimum forces the page to scroll sideways. Confirmed by screenshot. ADR-056.

Search returns the same page several times: three pages took nine of ten hits in a live query. `diversify` does what ADR-021 asked, putting one chunk per page first, and then appends every other chunk behind them, so the tail of a list is made of repeats. The eval set cannot see this, because a repeat of a correct page does not lower recall@5. ADR-057.

And an agent cannot see the shape of the workspace at all. Collections live in the page tree by ADR-024 and ADR-026, and the only way to ask what is under a page is `GET /api/v1/pages?parent=` on REST. MCP has no such tool, and `cairn read` says nothing about children. Counting the MCP tools against REST and the CLI showed the same drift in three more places: no delete, no changes feed, no table schema update, and a `create_table` that takes no change note although every other write does and the instructions say one is required. Hard rule 14 says a capability added to one surface is added to the others or an ADR says why not, and no ADR said why not. ADR-058 closes the gap and adds a test that fails when the surfaces drift, so the rule stops being one people are asked to remember.

Six ADRs, 053 to 058, and four specs in a new `docs/specs/` directory, which the global instructions have asked for and which the project has not had until now. The specs say what has to exist for each decision to be true and how anyone can tell, with numbered acceptance criteria rather than prose. Two of them carry gates that are not optional: hard rule 7 means the search change does not merge without `pnpm eval` before and after per backend, and the instructions change needs a fresh `pnpm context-cost`.

Eight smaller faults need no decision, only fixing, and are listed in `docs/specs/console-and-search-polish.md`. Four of them are misleading errors, which the coding style rules treat as bugs in their own right, so each earns a `docs/LESSONS.md` entry when it is fixed. One of the eight, snippets dropping apostrophes, has no established cause yet; the spec says to find it before writing the fix rather than guessing, since if it turns out to be in how chunks are stored it touches indexing and needs a rebuild.

### A shutdown step that hangs can no longer starve the one that closes the database

Found by a test that failed on macOS in CI having passed everywhere else, including locally: it asserted that a step with no budget left is skipped, and on that run the step ran instead, with about a millisecond to spare. The flake was real but it was the smaller half of the problem. The reason the margin was a millisecond is that a step took the entire remaining budget, so the step after it got whatever rounding left behind.

That is exactly the failure ADR-048 was written to prevent, one level down. The drain phase already caps itself at half the budget, and the comment there says why: a handler stuck on something outside our control must not be able to spend the time that closing the database needs. Backing up is such a step. It talks to blob storage, which can hang without answering or failing, and closing the database is what checkpoints the write-ahead log and leaves Litestream a finished file. A backup stuck on a slow upload could take the whole budget and leave the database open to be killed mid-write, which is the outage of 2026-09-15 all over again.

So a step now gets an equal share of what is left rather than all of it, worked out from the clock on each pass, which means a step that finishes early gives its share back and a step that hangs is bounded. With the default two steps, a backup that hangs costs half the budget and the close still has the other half. The test was rewritten to assert the property worth having, that a hanging step is named and the steps after it still run, and a second test covers the skip path deterministically with no budget at all. Ran five times over to confirm it is no longer a coin toss.

### Two registered Cairns are offered a schedule, and the default interval is now four hours

The owner's direction: "paired instance should sync every few hours automatically". `cairn sync install` had been there since ADR-029 and had never been run, including on the owner's own pair, which is the worst shape this feature can take: two Cairns a person believes are paired, drifting apart at whatever rate they are edited. Nothing was broken about the command. It was one line in a help listing, and somebody who has just registered a second Cairn has no reason to read further. So the offer is now made at the moment a pair comes into being, which is the one moment the person is certainly thinking about the pair, and never again once a job exists. ADR-052.

It stays an offer. Anything but an explicit yes installs nothing and prints the command for later, because installing writes a launchd agent, a systemd user timer or a Windows scheduled task, which is the person's machine rather than Cairn's, and a background job that turns up because a wiki command decided it should is not something to do to somebody. With nobody there to answer, which is every script and every agent, the registration succeeds and a line on stderr names the command; Cairn never blocks on an answer that cannot come. A failed install never costs the registration, since the instances are saved first and the failure is reported with the command to retry.

The default interval goes from one hour to four. Every run reaches the cloud copy, and on Azure that wakes a container which then stays up for its idle timeout of about thirty minutes, so the interval is not a freshness setting but a choice about how much of the day the cloud copy is billed as awake. An hour left it awake roughly half the time, quietly working against ADR-020's premise that Cairn lives inside a free grant. Four hours is six wakes a day and about three hours asleep in every four. `cairn sync` by hand remains the answer when a change is wanted across now, and the guides say so rather than suggesting a shorter schedule.

Asking is a new capability on the CLI's `Io`, injected like opening a browser, so the tests drive all four paths: yes, no, nobody there, and an install that fails. The implementation reads one line from the controlling terminal through `node:fs/promises`, which hard rule 16 already allows. The obvious way to write it, a `data` listener on `process.stdin`, works on Node and hangs forever on Bun, where the CLI ships as a compiled executable; see `docs/LESSONS.md`.

### -i is now the short form of --instance

The owner's direction, given while signing in to the deployed Cairn: "for CLI cairn login, instead of --instance, also allow -i". Sign-in is where the flag hurts most, because `login` is the one command that cannot go to whichever instance answers, so there is no version of it that skips the flag. It is added as a short form on the existing option rather than as something `login` alone accepts, so it means the same thing on every command and a wrong name fails the same way. `-i` was unclaimed; the CLI had only `-h` and `-V`.

### The recovery ladder and the Azure blob archive ran for the first time on the real Azure

Deployed to Azure as revision `cairn--0000016`, the first deploy carrying the ladder of ADR-051 and the archives of ADR-050. Both changelog entries below promised this run would be recorded, so here it is.

What the ladder did, against the real Litestream 0.5.17 and the real replica: the container came up with no local database, took the second rung, and logged "restored from the replica, and it passed its integrity check" 2.2 seconds after starting. That is a plain restore, which is the rung a healthy Cairn takes on every cold start, and it is now confirmed rather than reasoned about. The server was listening a further 0.7 seconds later. The third rung, the one that walks back through `litestream ltx` output, still has not run, because nothing has yet damaged the replica tail; its parser remains unverified against real output, and the honest statement is that it is untested in the one situation it exists for.

The blob archive resolved and reported its container: "backups: none yet, they will go to abs://cairnikh4laa53gam@cairn-backups/backups/". That proves the URL parsing, the managed identity token and the container listing, since an empty archive and an unreachable one are different answers and it gave the first. It does not yet prove an upload, which happens on the first write after the container has been up three hours.

One observation worth keeping. Immediately after the restore Litestream logged "detected database behind replica" with `db_txid=0` against `replica_txid=3`, then fetched the newest L0 file and reconciled. That is the restore handing back a database at the last compacted point and Litestream catching it up, not a fault, but it is the shape of thing that would look alarming in an incident, so it is written down now while its cause is known.

Separately, the deploy warned that the running revision had been deployed by tag rather than by digest, so earlier redeploys could not tell a moved tag from an unchanged one. This run replaced it with a digest, which is what ADR-047 asked for, and the warning should not appear again.

### Fix two Windows-only test faults that had kept CI red, and every image unpublished, for four commits

CI had failed on the four commits from the shutdown work onwards, and because the container image job runs only after the tests pass, no image had been published for any of them. Nothing was wrong with the product: both faults were in test code and both were Windows-only. `shutdown-signal.test.ts` spawned the `tsx` shim from `node_modules/.bin`, an extensionless shell script Windows cannot execute, and it asserts a tidy shutdown on SIGTERM, which Windows has no way to deliver because Node emulates it with TerminateProcess and no handler runs; it now spawns `node --import tsx` and is scoped away from Windows with the reason stated, since the container it exists for is Linux. `backup.test.ts` inserted 5000 rows outside a transaction, one commit and one disk sync each, which cost a second on an SSD and over twenty seconds on the Windows CI disk, timing the test out and leaving the database open so the cleanup failed with EBUSY on top; the inserts are now one transaction and the store closes in a `finally`. See `docs/LESSONS.md` for the part worth remembering, which is that nobody read CI for three pushes.

### Cairn now climbs down a recovery ladder at startup, instead of only stopping

ADR-046 settled that Cairn must never serve or replicate a database it cannot vouch for, and gave that rule one answer: stop. Stopping is right when the alternative is overwriting the only good copy, and since ADR-049 and ADR-050 a second copy exists, so it is no longer the only answer. ADR-051 puts four rungs above it, ordered so that each one loses more than the one above: the local database if it passes `integrity_check`, a plain restore from the replica, the newest point in the replica that restores and passes its check, then the newest backup that does, then stop. The third rung is the one the owner's direction did not name and the cheapest one there is: a truncated upload is always at the tail, so the transaction before the damage is usually intact, and walking back one transaction costs seconds where a backup costs up to `CAIRN_BACKUP_AFTER_HOURS`. This is exactly the failure of 2026-09-15, where a replica whose tail would not decode stopped the container with nothing behind it.

Every rung ends in SQLite reading the file back, because a restore that exits zero and hands back damage is a failure, not a success. Two refusals are built in. An unreachable replica stops Cairn rather than falling through to a backup: a network error or a role Azure has granted but not yet propagated says nothing about whether the replica is healthy, and recovering from a backup there would throw away good work to route around a firewall rule and then replicate the older database over the newer one. And damage is never retried, because a decode, checksum or truncation error cannot pass on the next try and retrying only burns the platform's restarts and buries the reason; anything else is retried `CAIRN_RESTORE_TRIES` times `CAIRN_RESTORE_WAIT_MS` apart, which by default gives a first deploy two minutes for its identity to reach storage. A database that will not open is moved to `<database>.broken-<timestamp>` the moment Cairn decides not to use it, with its write-ahead log, and both the log and the final message say where it is and that nothing removes it but the owner. Recovering from a backup is announced rather than logged quietly, because it is the one outcome that silently rewrites what the replica will hold. Stopping now prints the next steps in the order worth trying, starting with the exact `litestream restore -timestamp` command.

The decision lives in `packages/api/src/recovery/ladder.ts` and knows nothing about Litestream, clouds or filesystems, so every rung is tested without any of them; the platform wiring is in `packages/api/src/entry/recover.ts`, bundled to `dist/server/recover.mjs` and run by `docker/start.sh` before the server, per hard rule 13. The wiring was also run end to end against a stub litestream and a folder archive: a truncated local database was set aside, a decode failure walked to the third rung, that rung failed, and the fourth recovered from a real backup file. Two things are not verified. The `litestream ltx` output the third rung parses has never been seen from the real binary, which is not installed here, so the parser takes every RFC3339 timestamp from anywhere in the output rather than depending on a column order; and none of this has run against a real Azure replica. Both go in this changelog when they do. New settings: `CAIRN_RESTORE_TRIES`, `CAIRN_RESTORE_WAIT_MS` and `CAIRN_APP_DIR`.

### Backups now go to blob storage on Azure and S3 on AWS, with no cloud SDK

The engine below could only write to a folder, and on Azure a folder is the container's own disk, so Cairn warned at startup that its backups would die with the container. A warning tells the owner their backups are worthless; it does not give them one. The owner's direction: "on azure the backup must go to blob, on aws on s3 and so on". ADR-050. `CAIRN_BACKUP_DIR` becomes `CAIRN_BACKUP_TO` and takes a folder path, `abs://<account>@<container>/<prefix>`, `s3://<bucket>/<prefix>` or `off`, the scheme choosing the implementation. The Azure form is deliberately the same shape as `CAIRN_REPLICA_URL` so neither has to be learned separately, and the rename happened because a setting called `DIR` that accepts `s3://bucket` is the kind of misleading name this project treats as a bug; it had never been in a release.

Both archives are written against the REST APIs rather than with `@azure/storage-blob` or `@aws-sdk/client-s3`, which would add tens of megabytes to an image ADR-020 keeps small, for four operations. Azure authenticates as the app's managed identity, taking a token from `IDENTITY_ENDPOINT` where the platform injects one and from the instance metadata service otherwise, so ADR-018's promise that no storage key exists anywhere still holds. S3 takes credentials from where AWS itself looks: the environment, the ECS credentials endpoint, then EC2 instance metadata with IMDSv2, never a config file (hard rule 18). Uploads stream rather than buffer, Azure in eight megabyte blocks and S3 as a single streamed PUT signed `UNSIGNED-PAYLOAD`, and neither becomes visible as a backup until it is complete, which is the same guarantee the folder archive gets from renaming into place. `CAIRN_BACKUP_ENDPOINT` points at any other store that speaks S3, such as MinIO. The Azure template now creates a second blob container, `cairn-backups`, kept apart from the replica so one mistaken deletion cannot take both.

Signature Version 4 is now ours to maintain, so it is checked against AWS's published `get-vanilla` test vector: the signature matches byte for byte, rather than merely being accepted by a stub of our own design, and a second test proves the signer is not returning a constant. The archives are otherwise tested against strict local stubs that refuse unauthenticated or unversioned requests and check a file goes up and comes back unchanged. Neither has been run against a real Azure or AWS account yet; that run will be recorded here.

### Cairn now backs itself up, whole, and checks the backup before keeping it

The Litestream replica is the only copy of the database that existed, and it is page-level physical replication: no records, no timestamps, no merge, just the same bytes somewhere else. That is why one truncated transaction on 2026-09-15 became one unrestorable replica with nothing behind it. ADR-049 adds a second artefact that does not share fate with the first. A backup is a whole SQLite database made with `VACUUM INTO`, which was measured rather than assumed: 7 MB of database plus a 4 MB write-ahead log became a self-contained 7,127,040 byte file in 9 ms, with the log's contents folded in and no log of its own, and a deliberately corrupted source made it refuse with "database disk image is malformed" instead of copying the damage. The same measurement found the trap, that a refused vacuum leaves its partial destination file behind, so every backup is written to `<name>.partial`, opened read-only and put through `integrity_check`, and only renamed into place if it passes; any failure deletes the partial. The CLI's export format was considered first and rejected: it would need sharing between the CLI and the server, and a logical export has no pages, so Litestream's physical LTX files could never be replayed onto it.

Activity triggers a backup rather than a timer, in the owner's words "every new write if last backup is older than 3 hours, we backup". A timer never fires in a container that has scaled to zero, which is the normal state of the Azure Cairn, so a schedule would have backed up a twice-a-day Cairn never; and a Cairn nobody used needs no backup because nothing changed. At launch the age of the newest backup is read from the archive, so a cold start does not believe it has never backed up and take one on its first request. A backup is also taken on the way down, as a shutdown step before the database closes (ADR-048), because a stop is exactly when the last few hours of work would be lost. A failed backup never fails the request that triggered it, never stops shutdown, and never restarts the clock, so the next write is still due. Retention keeps two days, with a floor of three backups however old, because age alone would empty the archive for a Cairn nobody touched for a week and that week is when nobody would notice. New settings: `CAIRN_BACKUP_TO` (`off` disables), `CAIRN_BACKUP_AFTER_HOURS`, `CAIRN_BACKUP_KEEP_DAYS`, `CAIRN_BACKUP_KEEP_AT_LEAST`.

Taking a snapshot is an optional capability, `Snapshotter` in `packages/core/src/ports/snapshotter.ts` with a `canSnapshot()` check, not part of `DocumentStore`: hard rule 2 makes every adapter pass the same conformance suite, and only a file-backed store can answer this. The write trigger is one HTTP middleware counting any non-GET request that did not return an error, which is the single place MCP, REST and the CLI all pass through, so hard rule 14 is met without three implementations; MCP reads arrive as POST and so over-trigger, at a cost of one 9 ms vacuum every three hours at most. The archive is an interface with a folder implementation; an Azure blob one is next and needs no change to the engine. Until it exists, backups on Azure go to the container's own disk and are lost with it, so Cairn now warns at startup when `CAIRN_REPLICA_URL` is set and backups are going somewhere local, rather than letting them look like protection.

### Cairn now stops on purpose instead of being killed mid-write

Cairn had no signal handler at all: a grep of `packages/api/src` for `SIGTERM`, `SIGINT` or `process.on` returned nothing, so it wrote until the instant the platform killed it. On Azure that is not untidiness but the cause of the outage below. Container Apps sends SIGTERM and then SIGKILL thirty seconds later, and does so on every deploy, every revision replacement and every scale to zero, while Litestream is streaming the database to blob storage throughout. The evidence that this is what happened on 2026-09-15 is the pairing of two timestamps: revision `cairn--0000015` was created at 20:38:56, and the transaction that broke the replica, txid 81, was written at 20:39:53. Only a process replicating successfully could have appended to the replica, so it was healthy a minute earlier; and 206 bytes is an LTX header followed by the beginning of a page it never finished, so the writer did not choose to write a short file, it stopped existing. The known Litestream bug with the same symptom, a torn page set in [#1309](https://github.com/benbjohnson/litestream/issues/1309), needs a slow initial snapshot racing checkpoint writes on a 22 GB database and does not fit a 3.5 MB one.

ADR-048. Cairn now handles SIGTERM and SIGINT and stops in order: stop listening, let the requests already in flight finish, run the shutdown steps, exit. Closing the database is a step, and the last one, because SQLite checkpoints the write-ahead log and deletes it when the last connection closes, which is what leaves Litestream a finished file rather than a moving one. The whole sequence is bounded by `CAIRN_SHUTDOWN_SECONDS`, default 25, and running out of time names the step that did not finish rather than hanging until the platform kills it. Draining requests may take at most half the budget, so a handler stuck on something outside Cairn's control cannot spend the time that closing the database needs; that ordering came from a test which caught the opposite. A failing step never stops the ones after it, so a backup that cannot reach storage is never the reason the database is left open. A second signal exits at once. The platforms are configured to allow all this: `terminationGracePeriodSeconds: 30` in the Bicep and `stop_grace_period: 30s` in the compose file, the latter because `docker stop` allows only ten seconds by default.

The step list is also where the shutdown backup the owner asked for will go, ordered before the close. `packages/api/test/shutdown-signal.test.ts` runs the real server, sends a real SIGTERM and asserts no write-ahead log survives; with the handler removed it fails with exit code 143, killed by the signal, which is the behaviour being replaced. Litestream's `auto-recover` was considered and rejected: it resets from the local database, which on a scale-to-zero container is usually absent, so it would answer a 206 byte problem by replacing the whole replica with nothing.

### A deploy to Azure now deploys, or says it did not

Recovering from the outage below needed a container carrying the fix, and three runs of `deploy/azure/deploy.sh` deployed nothing at all: each printed "deploying", then "waiting for the new version to start", then hung for five minutes and failed with "the new version did not start", while the app carried on running the image it had been running since before the incident. Three faults combined. `main.bicep` took the image as a tag, `ghcr.io/vespassassina/cairn:latest`, and passed that string into the template; Container Apps makes a new revision only when the template changes, and a tag is the same string however often the image behind it moves, so a redeploy after a new build compared identical templates, created no revision, and never re-pulled. The default tag was one that only a release moves, since CI publishes `edge` from `main` and `latest` only from a release tag (ADR-018), so nothing committed to `main` could reach a deployment however many times the script ran; on the day `latest` was still v0.1.5. And the readiness loop waited for `latestReadyRevisionName` to catch up with `latestRevisionName`, which when no revision had been created meant waiting for something that would never appear, then reporting that the new version had failed to start when it had never been asked to exist. ADR-047 resolves the tag to a digest before it reaches the template, using an anonymous ghcr.io pull token and a manifest `HEAD` so no Docker is needed on the deploying machine, which makes a moved tag always produce a rollout and an unmoved one always produce none. A tag the registry does not have now stops the run naming `:latest` and `:edge`, rather than letting Azure fail to pull minutes later; a registry that cannot be reached degrades to a warning that says what it costs. A run that changes nothing now says "no change to deploy" and names the running image instead of waiting for a phantom revision, and a run that does change something prints the image it replaced and the one replacing it, and warns when the running image was deployed by tag, since that is the state in which earlier redeploys were silently ineffective. Deploying `:edge` now warns that it is the newest commit on main rather than a release. The health-check failure points at the container's own log and says that a healthy revision is not the same as a Cairn able to serve, because by ADR-046 a Cairn that cannot vouch for its database stops on purpose. `latest` stays the default, since someone deploying Cairn for the first time should get the newest release; what changes is that deploying `main` is now possible and documented.

### A Cairn no longer starts on a database it cannot vouch for

The Azure Cairn was found in a restart loop that had left it unreachable: Litestream's copy of the database in Blob Storage was truncated, `litestream restore` failed with `decode database: decode page 1460: EOF`, and `docker/start.sh` treated that like the temporary permission delay it was written for, retrying twelve times before exiting into another restart. Nothing said so from outside: the address answered a bare 504 and the CLI passed it through as `error: http_504: stream timeout`. ADR-046 changes four things. The start script now runs SQLite's `integrity_check` on the database before serving it, through Node's built-in `node:sqlite` so the image gains nothing, and refuses to open or replicate one that fails, because streaming a half-read database back would overwrite the only good copy. A restore error naming a decode, corruption, malformed file, checksum or EOF now stops at the first attempt, since retrying cannot fix it, while network and permission errors keep their twelve tries. On a damaged replica the container now logs `litestream ltx` for that replica plus the exact commands for the three ways out, which matters because by ADR-018 only the app's managed identity can read the storage account, so the container's own log is the one place the owner can see what the replica holds. Litestream moves from 0.5.7 to 0.5.17, ten patch releases that include "validate LTX file size before restore" (0.5.3) and "remove release-blocking SQLite WAL-reset corruption exposure" (0.5.17); a stale pin on a rewrite that is still shipping corruption fixes is what made this likely in the first place. Separately, the CLI now names a 502, 503 or 504 that carries none of Cairn's own JSON errors as a gateway failure that never reached Cairn, and says the reason is in the server's log. Tests in `packages/api/test/container-start.test.ts` drive the script against a stubbed Litestream; four of the five fail against the previous script.

## 2026-09-15

### `cairn restore` and `cairn peek`, and a REST restore endpoint

`pages.restore` has existed in core and the review console since ADR-008, but only the console could call it; a person or agent working from a shell had no way to undo a bad edit short of retyping the old text by hand. Added `POST /pages/:id/revisions/:version/restore` to REST (`If-Match` on the current version, optional `change_note`, same shape as `PATCH`), and two CLI commands: `cairn peek <page-id> <version>` prints an old revision in full without changing anything, and `cairn restore <page-id> <version> --version V` brings it back as a new revision, with the same optimistic-concurrency `--version` argument `move`, `publish` and `delete` already take. ADR-045 records why MCP is untouched: `get_revision` already serves as peek, and its own description already tells an agent to restore by reading an old version and writing it back with `update_page`, so a dedicated MCP tool would only hide that reasoning. Contract tests added in `packages/api/test/rest.test.ts` (a stale `If-Match` on restore is rejected with `version_conflict`) and `packages/cli/test/cli.test.ts`. `docs/CLI.md` gained a "History and undoing a change" section, and its sync section's stale claim that only the console can restore is fixed.

### The name is Cairn, settled

PRD Q5 asked for a final name, checked against GitHub, npm and domain availability, and CLAUDE.md still called Cairn a "working name". A DNS check found `cairn.dev`, `cairn.app`, `cairn.io`, `getcairn.com` and `usecairn.com` all already registered; `cairnwiki.com` looked free but the owner chose not to buy it. Since the GitHub repo, the npm package and the container images already all carry the name, and renaming any of them now would be real churn for no gain, ADR-044 keeps Cairn as the final name with no dedicated domain bought. `CLAUDE.md`'s "working name" wording is gone, PRD Q5 is marked answered, and `docs/ROADMAP.md`'s "Name decided" item moves to done.

### AWS, GCP and Proxmox deploy guides

The owner asked for AWS, GCP and Proxmox deploy guides (`docs/DIRECTIONS.md`). ADR-043 decided AWS and GCP get a plain VM running the existing `deploy/docker/compose.yaml`, the same as any other self-hosted target, not a managed container service (ECS, App Runner, Cloud Run): no new code, no new IAM, no new CI job, and it reuses `docker/start.sh`'s already-tested S3 Litestream replica path unchanged. No `deploy/aws/` or `deploy/gcp/` folder was added, since unlike Azure there is no cloud-specific IaC to check in. New `docs/DEPLOY-AWS.md` and `docs/DEPLOY-GCP.md` cover only what is cloud-specific (launching the VM, its firewall rule, backups); everything else defers to `docs/DEPLOY-DOCKER.md`. The AWS guide documents the existing S3 replica plumbing as-is. The GCP guide flags a Google Cloud Storage replica as untried: Litestream's S3-compatible interoperability endpoint might reach it, but this project's `CAIRN_REPLICA_URL` passes one URL straight to Litestream with no config-file mechanism for a custom endpoint, so GCS is left unverified rather than claimed to work. Also pulled the old inline "On Proxmox" section out of `docs/DEPLOY-DOCKER.md` into its own `docs/DEPLOY-PROXMOX.md`, covering VM vs. LXC choice and the unprivileged-LXC uid 1000 to 101000 host mapping for a bind-mounted database folder. `docs/AGENT-INSTALL.md` gained a "3d. On AWS or GCP" section (provisioning the VM is the person's own step; once Docker is installed the flow is identical to "3b. On their own server") and its hand-over section now mentions removing a cloud VM. `docs/README.md` and `docs/ROADMAP.md` updated to match. Both AWS and GCP guides are honest that they have not been run against a real instance yet; the free-tier specifics for each cloud are flagged as something to check at the time, not asserted as fact, since AWS in particular has changed its free tier more than once.

### The npm package is `@vespassassina/cairncli`, after two other names failed to publish

Publishing `@cairn/cli` failed with npm error 404 on the first CI attempt after the token issue (below) was fixed: a scoped package's first publish needs the scope's org to already exist on npm, and creating the `cairn` org failed because the name is already held by someone else, unrelated to this project. Renamed to the unscoped `cairncli`, confirmed free on the registry; CI's next run got further but still failed, this time with a 403 from npm's publish-time similarity check, "too similar to existing package cairn-cli", which a plain registry lookup never surfaces since it only checks exact names. npm's own error message named the fix: publish scoped to the owner's own npm username, `@vespassassina/cairncli`, which needs no separate org to exist and is not subject to the similarity check. Renamed `packages/cli/package.json` (restored `publishConfig.access: "public"`, required again since it is scoped), CI's `release` job (`pnpm --filter @vespassassina/cairncli build`/`publish --access public`), `docs/CLI.md`, and `packages/cli/README.md`. Full check suite and `pnpm smoke:cli` pass; `pnpm publish --dry-run` confirms the tarball is unchanged except for the name.

### v0.1.5

`v0.1.5` was tagged and pushed against `0.1.4` still in `package.json`; the release job's own guard caught it and refused to publish (`docs/DIRECTIONS.md`). `pnpm set-version 0.1.5` sets the version everywhere it is written; the tag was deleted and re-pushed against this commit so it points at a matching one.

### The CLI is ready to publish to npm

ADR-014 decided the CLI ships two ways, an npm package and standalone executables, but only the second was ever wired into CI. `packages/cli/package.json` is no longer `private`, gained `publishConfig: { access: "public" }` (required for a scoped package to publish outside a paid npm org), a `files: ["dist"]` list so the tarball carries only built output, and `exports` now points at `dist/main.js` and `dist/main.d.ts` instead of the raw `src/main.ts`, which no consumer without a TypeScript loader could have resolved. Added `packages/cli/README.md`, npm's own package page; confirmed with `pnpm publish --dry-run` that pnpm carries the root `LICENSE` into a workspace package that has none of its own, so nothing extra was needed for that. CI's `release` job, already building standalone executables and a GitHub release on a `v*` tag, now also runs `pnpm --filter @cairn/cli build` and `pnpm --filter @cairn/cli publish --access public --no-git-checks`, authenticated with a new `NPM_TOKEN` secret. `docs/CLI.md` section 2 now leads with `npm install -g @cairn/cli` and keeps the from-source path as a fallback for running `main`. The name itself, `@cairn/cli`, was confirmed with the owner (`docs/DIRECTIONS.md`) after checking the registry: `cairn`, `cairn-cli` and `cairn-mcp` are all taken, the scoped name was not. No tag was pushed and no package has been published yet; that needs the owner's `NPM_TOKEN` secret and, per this project's workflow, the owner's own tag push.

### A dark desaturated night blue background

The owner asked for the console and public wiki's background to be a dark desaturated night blue. `CAIRN_CSS` (`packages/api/src/web/assets.ts`) already sits outside artifactkit's `@layer ak.tokens`, so a `:root` block there overriding `--t-bg`, `--t-ink`, `--t-accent`, `--t-accent-2` and `--t-lift-amt` beats the generated theme without touching it, the same trick artifactkit's own docs describe for a single-file artifact. Everything else (surfaces, rules, hover washes, chart series) is `color-mix()` of these tokens, so it re-derives on its own; no colour is hard-coded in Cairn's own CSS (ADR-009 rule 3). The PWA manifest's `background_color`/`theme_color` and the `<meta name="theme-color">` tag were updated to match, so a saved home-screen icon and the browser's own chrome agree with the page. Checked in the browser (`/browse`): collections list, the new-page form, a saved page with a real link, a broken `[[wiki-link]]`, a success banner, pills and buttons all hold readable contrast. This is a fixed palette, not the settable theme with a live preview that "Reskin the wiki: a theme setting" (`docs/ROADMAP.md`) still describes; that stays open.

### A negated keyword match does not count

Search's one known eval miss, q17 "which peptide makes you really hungry" (recorded 2026-09-14, `docs/ROADMAP.md`), turned out to be a negation bug, not a missing weight (ADR-042). The wrong page's only occurrence of "hungry" was inside "more than simply feeling less hungry": the word was there, its meaning was not. A new, small, generic English negation lexicon and `isNegatedEverywhere(text, term, window)` (`packages/core/src/search/terms.ts`) say when every occurrence of a term in a chunk sits within a few words of a negation or decrease word ("not", "less", "reduced", "suppress" and the like). `keywordRanking()` (`packages/adapter-sqlite/src/search-index.ts`) now reads chunk text, not just chunk presence, when counting a page's term coverage, and a term whose only occurrence is negated no longer counts towards `requiredMatches`. `pnpm eval`: recall@5 unchanged, keyword 0.88 before and after, hybrid 0.97 before and after (still one miss of 32, q17 itself). What changed is that keyword and hybrid search now both return nothing for q17 instead of a confident, wrong page, the honest result this project already prefers (`search/terms.ts`'s own docstring says so). Investigating this also found a second, separate cause: q17's correct chunk is the single closest in the workspace by cosine similarity, but falls 0.0004 short of ADR-022's margin filter, because 18 pages sharing "appetite" vocabulary raise the neighbourhood baseline the margin is measured against. Left alone rather than tuned to fit one query; tracked as its own roadmap item.

### Discovery by following citations

`cairn discover [--from URL]... [--depth N] [--limit N] [--timeout MS]` (ADR-041) closes the last open item on "Bridges between Cairns": finding a Cairn you did not already know about, with no registry. `/.well-known/cairn.json`'s `cites` field (ADR-034), always empty until now, is filled in: `citedCairnOrigins` (`packages/api/src/web/public.tsx`) reuses ADR-039's `isBasedOn` computation, reduced to origins and deduplicated across every published page. `cairn discover` walks outward breadth first from every url already in "Trusted cairns" (ADR-037) plus any `--from`, reading each Cairn's `cites` at every hop, bounded by `--depth` (default 2) and `--limit` (default 200) so a large or cyclic citation graph cannot run away with the owner's bandwidth. A client of the web, like `cairn trust` and `cairn check-sources`: the owner's own machine, walking addresses the owner's own trusted list led it to, so it carries none of ADR-040's SSRF concern. `fetchPeerDescription` (`packages/cli/src/trust.ts`) now also reads and returns `cites`, reused rather than duplicated. Newly found Cairns land in a new, lazily-created "Discovered cairns" table, kept deliberately separate from "Trusted cairns": finding an address is a fact, trusting it stays the owner's own act (ADR-037), never conferred by a crawl. A Cairn already trusted is always a starting point of its own walk, so it is never reported as newly found.

### "Cited by", across Cairns

A Cairn can now be told that another site links to one of its published pages, and show that on the page (ADR-040). `POST /webmention` takes a Webmention-shaped notice (`source`, `target`), fetches `source` through a new SSRF-safe helper (`packages/api/src/citations.ts`: http or https only, the hostname resolved and checked against private, loopback and link-local ranges at every redirect hop, not just string-matched, bounded timeout and response size), and confirms it really links to `target`. A verified notice becomes a row in a new, lazily-created "Citations" table (`page`, `source`, `status`), `accepted` at once when the sender's origin is in "Trusted cairns" (ADR-037) and `pending` for the owner to review otherwise, through the same generic table tools ADR-037 already relies on: no new console, MCP or CLI code. A published page (`/w/<id>`) gains a "Cited by" section listing its accepted rows. `cairn export --format site` is unchanged: a static export cannot receive the notice at all, so this ADR is a live-server-only feature.

### Machine-readable citations on public pages

Every published page (`/w/<id>`) and every page in `cairn export --format site` now carries its sources as JSON-LD in its `<head>`, alongside the visible list it already had (ADR-039): schema.org `citation` for every source (a `CreativeWork` with a resolved address when `sourceHref` finds one, plain text when it does not), and `isBasedOn` for any source shaped like another Cairn's published page, `<origin>/w/<page-id>` (the same shape ADR-038 uses for a cross-Cairn link). Nothing is fetched: both properties are computed from data the page already carries. `isCairnPageAddress` (`packages/core/src/sources.ts`) is duplicated in `packages/cli/src/sources.ts`, the same way `sourceHref` already is, since hard rule 16 keeps `@cairn/core` out of the CLI's runtime.

### Links to another Cairn join the link graph

An ordinary Markdown link to another Cairn's published page, `[label](<origin>/w/<page-id>)`, is now recognised as a `cairn_link` edge (ADR-038), the third and last part of "Links to the original, across Cairns" on the "Bridges between Cairns" roadmap. The other two parts were already in place: every published page has one canonical address (ADR-032), and sources travel unconditionally through publishing (ADR-027). No new syntax: an ordinary link already rendered safely as external, and nothing changes about how it renders.

Recognition is structural, from the URL's shape alone: nothing is fetched, so `extractReferences` (`packages/core/src/indexer/extract.ts`) stays a pure function and edges stay rebuildable offline (ADR-005, hard rule 9). It deliberately does not consult the ADR-037 trusted list; that answers a different question, who to accept notices from, not what counts as a link. `linkJson` (`packages/api/src/operations.ts`), shared by MCP, REST and the CLI (hard rule 14), reports a `cairn_link` edge as `{ cairn_url, type, label }` instead of guessing at a page id. No schema migration: `target_id` and `type` on the `edges` table are plain text with no enum constraint.

### A local trusted friends catalog

`cairn trust <url> [--note "why"]` (ADR-037) confirms an address answers with a Cairn's self-description at `/.well-known/cairn.json` (ADR-034), then adds or updates a row for it in this Cairn's own "Trusted cairns" table, created the first time it is needed. Trusting the same address again updates the row rather than duplicating it; an address that does not look like a Cairn is refused, with what went wrong and what to check.

No new storage, port, schema or endpoint: the table is ordinary, so `cairn tables`, `rows`, `row` and `upsert`, and the equivalent MCP tools and REST endpoints, already read and manage it like any other table (hard rule 14, satisfied for free). `cairn trust` itself is CLI-only, on the reasoning `cairn sync` (ADR-023) and `cairn check-sources` (ADR-036) already established: checking an address that is not this CLI's own server is a client-of-the-web job, not a server decision. The list stays local, part of this Cairn's own data, unless the owner deliberately publishes it like any other collection.

### No registry: a local trusted friends catalog instead

Direction change, no code yet. Offered a choice of the next "Bridges between Cairns" item, the owner rejected "A registry of public Cairns on GitHub": "avoid the registry. not my place." That item in `docs/ROADMAP.md` is now marked rejected rather than `later`.

In its place, the owner wants each Cairn to keep its own local list of other Cairns it trusts: "a cairn can keep references to other cairns and act as a local 'trusted friends' catalog". `docs/ROADMAP.md` gains a new item, "A local trusted friends catalog", and the two items that depended on a shared registry, "'Cited by', across Cairns" and "Discovery by following citations", are reworded to depend on this local list instead. Still needs an ADR before code: whether the list is server data or CLI config, what a trusted entry records, and how it is managed.

### Citations kept correct

The owner picked "Citations kept correct" off "Bridges between Cairns" next (ADR-036). Two parts:

`cairn check-sources [--root PAGE]` is a new CLI-only command, modelled on `cairn sync` (ADR-023): a client of the web, not a server feature. It reads every page's and row's sources through the same export endpoints `export` uses, checks each linked one once with `HEAD` (falling back to `GET`), and reports which no longer answer. For a dead `http(s)` address it looks up a copy on the Internet Archive's Wayback Machine. Report only in this version: nothing is written, and no new field is added to a page or a row.

A source that names a DOI or a PubMed id, not only a plain `http(s)` address, is now recognised and shown as a link, everywhere a source is shown: the console, the published wiki, and a static site export (ADR-035). `packages/core/src/sources.ts` gains `sourceHref`, which resolves a bare or `doi:`-prefixed DOI to `https://doi.org/...` and a `PMID:`-style id to `https://pubmed.ncbi.nlm.nih.gov/.../`, alongside the existing `isUrlSource`. The CLI keeps its own copy (`packages/cli/src/sources.ts`), duplicated rather than imported, since hard rule 16 keeps `@cairn/core` out of the CLI's runtime; the two are kept in step by running the same test cases against both.

The MCP instructions, the skill and the workspace summary now say to cite the original, not a summary of it, matching the roadmap wording (rule 8).

## 2026-09-14

### A static site export, no server required

The owner picked this off the roadmap next: `cairn export` gains a site format (ADR-035). `cairn export <folder> --format site` writes a folder of plain HTML instead of Markdown, openable by double-click or put on GitHub Pages, an Azure Blob Storage static website, Amazon S3, Google Cloud Storage or Dropbox, at no hosting cost and with no Cairn running.

The reason it needed its own ADR rather than being an obvious extra flag: today's Markdown export already goes into a GitHub repository, which renders Markdown, but a wiki link like `[[pg_bpc-157|TB-500]]` points at a page id GitHub's renderer cannot resolve, so it never becomes a clickable link (ADR-016, consequence 4). The site format fixes that by resolving every wiki link to the other page's real, relative `.html` path, the same way the export's folder layout already places pages (`assignPaths`). Each page keeps a breadcrumb trail to the root, its rendered body, its sources as visible, clickable citations, and its own children; `index.html` lists the top-level collections, and `--site-url` writes a `sitemap.xml` with absolute addresses.

Rendering is a small, self-written Markdown-to-HTML subset in a new CLI module, `packages/cli/src/site-format.ts`, checked against what `examples/peptide-wiki` actually contains: headings, paragraphs, bold, italic, inline code, fenced code, lists, links and wiki links. Not `markdown-it`: hard rule 16 does not let the CLI depend on it without checking both the Node and Bun-compiled builds, and this covers what the content needs. Tables are not part of this format yet; the default `cairn` format's `--tables` still writes them as JSON.

### A public Cairn describes itself

The next step past the published wiki (ADR-032), and the first item on "Bridges between Cairns" (`docs/ROADMAP.md`, ADR-034): every other discovery item, the registry, discovery by following citations, "cited by" notices, needs a machine-readable place a Cairn says what it is, and now there is one.

`GET /.well-known/cairn.json`, on the published surface, no sign-in: a format version, the Cairn's name, description, language and topics from new owner settings (`CAIRN_NAME`, `CAIRN_DESCRIPTION`, `CAIRN_LANGUAGE`, `CAIRN_TOPICS`), the content licence it already carries, the roots of its published subtrees with their addresses, its sitemap, and `cites`. That last field is always empty today: nothing yet tells a citation in a page's `sources` (ADR-027) apart from an ordinary web link, so filling it in is later work, and the ADR says so rather than letting the field imply it works. Built from the same published set as `/w`, so it names nothing that is not already public.

### A lost refresh no longer ends the sign-in

The owner's Cairn MCP sign-in stopped working, nowhere near the 30 day refresh lifetime, and they asked whether the token could last longer (`docs/DIRECTIONS.md`, ADR-033). It could, but that was not the fault. Refresh tokens rotate on every use, so a Cairn used daily never expires by time. What ended the sign-in was a refresh token presented twice, which the server read as a stolen token and answered by revoking the whole family.

A second use is also what an ordinary failure looks like: the response was lost on the way back, two processes refreshed at once, or the container restarted from a replica written just before the last rotation (ADR-020). So a used refresh token now keeps answering with the tokens it was already given for 60 seconds. Past that window a second use still ends the family, a revoked sign-in stops replaying at once, and the lifetimes are untouched: one hour for an access token, 30 days for a refresh. Lengthening the access token is the one change that would genuinely weaken things, since it is verified locally with no store read.

The cost is stated in the ADR rather than glossed: a token stolen and replayed inside the same minute now succeeds, and the store holds one live refresh token in readable form until the record expires.

### A wiki can be published: read-only, no sign-in, indexed by search engines

The owner's direction of 2026-09-14, and the roadmap item that several others waited on (`docs/DIRECTIONS.md`, ADR-032). Cairn was private end to end (ADR-017). It is now private by default and publishable on purpose: a page carries `public`, marking it publishes it and every page under it, and published pages are served read-only at `/w`, with `/sitemap.xml` and `/robots.txt`, to anyone.

Everything about the design is shaped by the one mistake that matters, which is publishing something private. So:

1. **The published surface reads published pages and nothing else.** An unpublished id answers the same 404 as an id that never existed, private children are never listed, a link to a private page renders as plain text rather than a link, and even the page description strips link targets so an id cannot leak through it. There is no search, no history and no tables on it.
2. **It names nobody.** No actor, no change note, no version: the text, its sources, and when it was last updated.
3. **An agent cannot publish.** The console has the control, the CLI has `cairn publish` and `cairn unpublish`, REST has its own `/publish` route, and MCP has nothing, which is hard rule 14 answered by the ADR rather than by adding a tool. Publishing is not a field on an ordinary write either, so no edit can publish a page by accident, and a restore cannot: publication is not part of a revision.
4. **Publication belongs to the server.** It never travels with sync, export or import, so a published wiki synced to a laptop is private there, and no sync can publish anything. The console says so where the control is.

`CAIRN_CONTENT_LICENCE` puts the owner's licence on published pages, separate from Cairn's own code licence. Checked end to end in the console and the browser: publishing a collection, reading it as a stranger, the sitemap, then taking it down again.

The MCP server instructions and the skill both gained the same line, so an agent asked to publish says who does it instead of looking for a tool (ADR-011, ADR-012, ADR-013). That line pushed the initialize payload past `INSTRUCTIONS_BUDGET`, which trimmed the workspace summary that follows it, so the budget goes from 2000 to 2200 characters to keep the summary the room it had. `pnpm context-cost` after the change: about 3,100 tokens for the MCP surface, unchanged in the README's terms.

### The eval set is finished, and search has a published number

The last Phase 0 item, and the launch checklist's. `eval/queries.yaml` had 16 queries with expected pages out of the 30 the PRD asks for, plus two placeholders about drones and 3D printing left over from before there was any content. The placeholders are gone, and 14 queries are added, written from the wiki's text with their expected pages chosen before any of them was run, because a query written while watching the results measures nothing. They cover what the first 14 did not: brand names, a misspelling, a question about two peptides together, and needs described without naming anything.

The number, on the 104-page peptide wiki with SQLite and FTS5: **recall@5 of 0.97 with keyword and meaning together, 0.88 on keyword alone**, over 32 scored queries, and 9 of 9 for the questions the wiki does not answer, in both modes. Above the PRD's 0.8 target and its 0.9 stretch. It is now in the README, with the two cautions in PRD section 11: four conversational queries were used while choosing the vector margin in ADR-022, and one query is missed in both modes.

That miss is a finding, and on the roadmap: "which peptide makes you really hungry" returns the appetite suppressants. Eighteen pages talk about appetite and nothing in the text marks the direction, so neither keyword nor vector search can tell wanting it from stopping it.

### A new page starts under the page you are reading

The owner's direction (`docs/DIRECTIONS.md`). In the console, "New page" in the header started a page at the top level wherever you were, so making a child page meant finding the parent again in a long list. It now carries the page you are on: on a page, its history or one of its old versions, the button goes to `/new?parent=<that page>`, and the form starts with that parent chosen.

Following the coding style, the form says the console chose it: "Starts under X, the page you came from. Change it above, or choose None (top level)." A parent that no longer exists is not an error page: the form opens at the top level with a banner naming the missing page. Two console tests cover both.

### An agent guide to running Cairn, errors that guide, and two editor items on the roadmap

Four directions from the owner (`docs/DIRECTIONS.md`).

1. **Coding style: errors that guide, and sensible defaults.** `CLAUDE.md` gains a "Coding style" section: every error says what happened and the exact next step, says when a default the person did not choose was used, prefers defaults to required settings, and is written so an agent can act on it; an error that misled someone is a bug. PRD principle 7 says the same for the product (ADR-031).
2. **`docs/AGENT-OPERATE.md`,** the agent's guide to a running Cairn: what runs where, every setting with its default (server, Docker, Azure and CLI), health checks, updates, sync between Cairns, backups and restore, access and secrets, cost, troubleshooting and the hand-over. `CLAUDE.md`, `AGENTS.md` and `docs/README.md` point to it (ADR-031).
3. **`docs/AGENT-INSTALL.md` brought up to date:** the OAuth step pointed at "step 4" for an address printed in step 5; connecting the CLI and moving a local Cairn up now use registered instances, `cairn sync install` and `cairn start` (ADR-029); the MCP cost reads about 3,100 tokens, not 3,000; the hand-over points to the operation guide.
4. **A test keeps the agent guides in step with the code** (`packages/cli/test/agent-guides.test.ts`): every `CAIRN_` setting read by the server, the CLI, the image's start script or the deploy files must be described in the operation guide, and every setting and `cairn` command either guide names must exist. Checked by breaking the guide on purpose: all three parts failed, naming the setting and the command. Hard rule 19 now covers configuration and operation steps.
5. **Roadmap, Phase 2:** "More kinds of content: notes, blog posts, diagrams, pictures", written by agents through the CLI and API and by people through their agent or the editor; and "Reskin the wiki: a theme setting", on artifactkit's theme tokens, with custom CSS on top. No code.

### `cairn login` says how to sign in to the Cairn you meant

The owner ran `cairn login` to sign in to Azure, with no `CAIRN_URL` set, and got "http://localhost:8787 does not use OAuth sign-in (HTTP 404). On localhost no sign-in is needed." That was true, and no help: it did not say that the CLI had picked localhost because no Cairn was named, or how to name one (`docs/LESSONS.md`).

1. **None named, localhost tried:** the error says so, and shows both ways to name the Cairn meant: `CAIRN_URL=https://your-address cairn login`, or registering it and `cairn login --instance <name>`.
2. **Localhost named:** it says a Cairn on this machine needs no sign-in, and that a server started with a token takes `CAIRN_TOKEN`.
3. **Another address with no sign-in:** it says to check that the address is a Cairn's, and that a Cairn run with a service token takes `CAIRN_TOKEN`. Before, the message talked about localhost here too.
4. **No answer, or a server error:** "could not reach" with the address, and for a 5xx "try again in a minute", where before any failure read as "does not use OAuth sign-in".
5. **Docs:** `docs/CLI.md` showed a bare `cairn login` for a deployed Cairn, which works only with `CAIRN_URL` already set. It now shows the address, or `--instance`. `cairn --help` says which server `login` signs in to.

### Edit times and merging deployed to Azure

The owner deployed the image built from the ADR-030 change (`ghcr.io/vespassassina/cairn@sha256:26d7b601...`, revision `cairn--0000014`) and ran `cairn sync` between the laptop and Azure, dry run first. Checked afterwards, read-only: `/health` answers 0.1.4, the container app runs that digest, and a second dry run found the two copies the same, 186 records.

ADR-030 decision 8 said the CLI shows `edited_at`; it does not. Only sync reads and writes it, and the CLI prints what it printed before, like MCP. The ADR was wrong, not the code, and now says so, with why.

### Sync keeps the order of edits and merges both sides, as git does

The owner's direction that sync keep order and settle conflicts the way git does, built after "then keep building" with defaults the agent chose (ADR-030, `docs/DIRECTIONS.md`).

1. **Edit times.** Pages and rows gain `edited_at`, when their content was last edited, where it was edited. Each server's clock for it never repeats, and a record's time always moves forward by at least a millisecond, even past a time that came from a server whose clock runs ahead. `updated_at` stays the time this server stored the write. REST returns `edited_at` on pages and rows and takes an exact one on `PUT`, within a day of this server's clock; MCP does not show it, and ADR-030 says why. Stored in a new `edited_at` column, read as `updated_at` where it is empty.
2. **Order across hops.** Sync sends each record with the time it was edited, and orders two versions by it, then by content hash on a tie. Before, a copy took the time it arrived, so an old edit relayed through a third Cairn could win over a newer one (`docs/LESSONS.md`).
3. **Three-way merge.** When both sides changed a page or row, sync finds the version they last agreed on in each side's history, up to 50 revisions back, and merges: a body line by line with diff3, as git merges a file; title and parent as values; tags and sources as sets; row fields one by one; `verified_at` as the later time. A part both changed takes the newer edit, and the other stays in history with a note saying so. The merged record is written to each side it differs from. The newer edit still wins whole without a base, for tables, against a deletion, and for bodies too large to compare.
4. **A half-written merge is retried.** When one of a merge's writes is refused, that record's base goes back to what it was, so the next run merges again instead of copying the unmerged side over the merged one.
5. **Reports.** `cairn sync` prints `merged:` for a clean merge and `conflict:` with the number of parts that took the newer edit; `--dry-run` says which records will be merged. Page revisions over REST now include `parent_id`, which the merge needs to rebuild a revision's content.
6. **Tests.** Unit tests for the merge, edit times in the services, the conformance suite and REST, and sync tests with two and three Cairns, including an edit relayed through a third that must lose to a newer one. 419 pass.

Not built, and on the roadmap: history linked as one chain across instances, and a console list of sync conflicts. The Azure copy needs an image built from this change to keep edit times; until then it syncs as before.

### Roadmap: finding public Cairns

The owner asked for a way to make public Cairns discoverable. Search engines need only a sitemap and links, so what a registry adds is discovery between Cairns, for people browsing by topic and for the bridges between Cairns. Three items join "Bridges between Cairns": each public Cairn describes itself in `/.well-known/cairn.json` and pings search engines through IndexNow; a registry repository on GitHub, one file per Cairn by pull request, checked by CI and published with GitHub Pages; and crawling by following the Cairns each one cites. A registry server that Cairns contact on their own was rejected: it needs someone to run and pay for it, attracts spam, and centralises the network. No code.

### Principle and roadmap: bridges between Cairns

The owner's direction that citations stay correct and link to the original, so separate Cairns form a web of knowledge rather than islands. The PRD gains principle 6, "Bridges, not islands". A new roadmap section lists what that needs beyond ADR-027's sources, which already travel through export, import and sync: checking that sources still answer, a canonical address for every published page and a source pointing back when a page comes from another Cairn, citations as structured data on public pages, and an optional "cited by" notice between Cairns. No code.

### Roadmap: a wiki can be published, served or as a static site

The owner's direction that Cairn be a free knowledge source as well as a knowledge manager. Two roadmap items: a public wiki, where a collection the owner marks public is served read-only with no sign-in and made indexable (titles, descriptions, a sitemap, `robots.txt`), private by default and leaking nothing private; and a static site export, HTML with working links for GitHub Pages, blob storage, S3 or Google Cloud Storage static websites, or Dropbox. The phone-console item keeps only the phone half. The PRD names readers on the web as later users and adds publishing to P2. No code.

### One version for a release, and how to update the CLI

`cairn -V` printed `0.1.0` in `v0.1.1`, `v0.1.2` and `v0.1.3`, and the server reported `0.1.0` on `/health`, because nothing tied the numbers in the code to the release tag. Nobody could tell from the command whether they were up to date.

1. **One source:** the root `package.json` now holds the release's version. `pnpm set-version <version>` writes it into the CLI's `package.json`, the CLI's `VERSION` and the server's `SERVER_INFO`.
2. **Checks:** a test fails when those four disagree, and the release job refuses a tag that is not `v` followed by that version.
3. **Set to 0.1.4** for the next tag, which carries freshness (ADR-028) and named instances (ADR-029).
4. **Docs:** `docs/CLI.md` gains "Update it", for a downloaded executable and for an npm install from the repository; `docs/LOCAL.md` lists `pnpm set-version` and how a release is cut.

### Roadmap: features that answer Obsidian kept in git

The owner asked why anyone would choose Cairn over Obsidian with its vault in a GitHub repository, then asked for the proposed features to go on the roadmap. A new roadmap section, "Against a notes app kept in git", holds all ten in the owner's order, each with the ADR or PRD limit it runs into: an Obsidian bridge, a git mirror, an agent activity digest with approvals, stale-page reviews, quick capture, a graph view, templates and attachments, a phone-friendly console with an optional public page, sharing, and a published search-quality number. The PRD's landscape gains Obsidian in git as the comparison most readers will make, and Obsidian import leaves Phase 3 for the new section. No code.

### Roadmap: ordered history and three-way merge in sync

The owner asked that sync keep every edit in order and settle conflicts the way git does. Sync today orders edits by each server's millisecond clock, which a fast clock on one machine can get wrong, and a conflict keeps the whole newer record. Added to the roadmap as next: a hybrid logical clock on every write, revisions linked to the ones they replaced across instances, and a three-way merge by section against the version both sides last agreed on. No code yet.

### The CLI keeps several named Cairns as one (ADR-029)

The roadmap's named-instances item: sync as backup, and one Cairn running on a laptop and in one or more clouds, all the same container. The owner chose, each time the recommended answer: the first instance that answers is the best, `cairn start` catches up, a background job keeps them in sync, and the first that answers is the hub.

1. **Registering:** `cairn instances`, `cairn instances add <name> <url> [--first] [--start "command"]` and `cairn instances remove <name>`. The list is `instances.json` beside the credentials, with no tokens in it.
2. **Routing:** with instances registered and no `CAIRN_URL`, a command goes to the first that answers `/health`, and says on stderr which it used when it skipped any; `--instance NAME` picks one. The probe waits 2 seconds for this machine and 60 for a cloud copy that may be starting, and stops at the first that answers, so the cloud is not woken while the laptop is up. `login` and `logout` need `--instance`.
3. **Sync:** `cairn sync` with no addresses syncs every instance through the first that answers, and syncs the earlier ones again when the hub took changes, so a change made anywhere reaches everywhere in one run. `cairn sync <a> <b>` takes registered names too.
4. **`cairn start`:** starts the first instance with its start command if it is down, waits up to 90 seconds, then syncs everything.
5. **`cairn sync install [--every 1h] [--dry-run]` and `cairn sync uninstall`:** a launchd agent on macOS, a systemd user timer on Linux, a scheduled task on Windows, running this CLI by its absolute path. One hour by default, because each sync wakes a sleeping Azure copy for about 30 minutes.
6. **Tests:** 14 new, with three real Cairns behind a fetch that can take any of them down, and fakes for starting programs and the OS schedulers. The CLI tests now point at a credentials file that does not exist, so the owner's own sign-ins and instances never reach them (`docs/LESSONS.md`).

No server change, and no change to the MCP tools, the instructions or the skill, so the context cost is unchanged.

### Roadmap: the CLI picks the best instance and catches up on start

Two more parts of the named-instances item, from the owner: the CLI sends each command to the best reachable instance, and on starting it pulls changes made in the cloud into the local copy before work begins. No code yet.

### Roadmap: named instances kept in sync, for backup and a hybrid service

The owner asked for sync to become a backup and availability strategy: the CLI registers several Cairns by name and keeps them in sync on a schedule, so one Cairn runs across a laptop and one or more clouds, all on the same container. Added to the roadmap as next, with the questions its ADR has to answer: the topology beyond ADR-023's two Cairns, how the scheduled job runs on each OS, and the cost of waking a cloud copy that scales to zero. No code yet.

### Pages say when their facts were last verified (ADR-028)

The roadmap's freshness item. A page's update time moves with a typo fix and says nothing about whether its facts still hold. The owner chose a verification time set by a flag on a write, set at creation when the page has sources, shown as an age with no staleness threshold, on pages only.

1. **Core:** `Page.verifiedAt`, null for never. A write with `verified: true` sets it to the write's own time; an exact `verifiedAt` (import, sync, restore) must be an ISO 8601 time at most a day ahead and is stored in UTC; otherwise an update keeps it and a create sets it only when the page has sources. Revisions snapshot it, and a revision view says whether that revision verified the page: its snapshot's time equals its own.
2. **SQLite:** a nullable `verified_at` column on `pages`, added to an existing database on start.
3. **MCP:** `update_page` takes `verified`, which works with empty append content; `get_page` returns `verified_at`, `get_revision` returns `verified_at` and `verified`, and search hits carry `verified_at` only when it is set. The server instructions gain one sentence: when you re-check a page and it still holds, pass `verified: true`.
4. **REST:** `PATCH` takes `verified: true`, `PUT` takes an exact `verified_at` or null, and page responses, search hits and revision views carry it. The Markdown view has a `verified:` line.
5. **CLI:** `--verified` on `append`, `replace-section` and `write`; a bare `cairn append <page-id> --verified --note "why"` needs no text. `cairn revision` says when a revision verified the page. The skill says both.
6. **Console:** "Verified 3 months ago" or "Never verified" on every page, a checkbox in the editor, a "verified" chip in history, and a new Freshness screen in the navigation listing pages never verified first, then the least recently verified.
7. **Export, import and sync:** a `verified` line in a page's front matter when set, still format version 2; import sets it exactly; sync hashes it only when set, so the first sync after upgrading copies nothing, and sends it with every page write so a change reaches the other side.

Context cost, measured with `pnpm context-cost`: MCP from about 3,091 tokens a session to 3,138. The skill description is unchanged, at about 115 tokens.

14 tests added, across core services, REST, MCP, the console, the CLI, export and sync. 380 tests pass, 1 skipped, and the CLI smoke test passes. The console was checked by eye on a scratch database: the Freshness list, the editor checkbox, the page's meta line and the history chip.

### The Peptides table is now Peptides Index

The owner's answer to the name clash left open on 2026-09-13: the Peptides collection held a table also called Peptides. The table `col_peptides` was renamed Peptides Index, and the collection's front page (`pg_peptides`) now says "The Peptides Index table has one row per peptide", as a revision with a change note. The id did not change, so the Stacks table's links to its rows, and every `[[col_peptides/...]]` link, still work. The peptide wiki seed (`examples/peptide-wiki/seed.ts`) uses the new name, so reseeding does not rename it back.

Done through the REST API on the laptop's copy. It reaches Azure with the next `cairn sync`, which the agent's permissions did not allow it to run; the owner runs it.

### Pages and rows say where their facts came from (ADR-027)

The roadmap's provenance item. Agents write most of what Cairn holds, and the change note said why a write happened but not where its facts came from. The owner chose a list of sources on each page and row, added to by each write, optional but prompted, each one a URL or a short citation.

1. **Core:** `Page.sources` and `Row.sources`, cleaned (whitespace collapsed, blanks and repeats dropped), at most 500 characters each and 100 per record. A write that leaves `sources` out keeps the list, so a move or a retitle never wipes it. Revisions snapshot the list, and a revision view reports the sources it added and dropped. Revisions from before carry no list and report no change.
2. **SQLite:** a `sources` JSON column on `pages` and `rows_`, added to an existing database on start.
3. **MCP:** `create_page`, `update_page` and `upsert_row` take `sources`, and the updates add to the list; `get_page` and row results return it, and `get_revision` reports `sources_added` and `sources_removed`. `query_table` leaves an empty list out, so reading a table costs what it did. The server instructions gain one sentence: when a fact came from somewhere, name it in `sources`.
4. **REST:** `sources` on create; `PATCH` on a page adds; `PUT` on a page or row replaces the whole list, or keeps it when left out; `PUT` on a row takes `add_sources` to add instead, and refuses both at once. The Markdown view of a page shows a `sources` line. An `append` with empty content now leaves the body alone, so an edit can add a source without touching the text; before, it added two blank lines.
5. **CLI:** `--source`, repeatable, on `create`, `append`, `replace-section`, `write` and `upsert`, adding to the list. `cairn row` prints the sources and `cairn revision` prints the ones added and removed. The skill says to use it.
6. **Console:** a Sources section on a page and beside a row, with web addresses as links (`rel="noopener noreferrer nofollow"`) and the rest as text; a "Sources, one per line" field in the page and row editors, which replaces the list; and the sources added and removed on each revision.
7. **Export, import and sync:** a `sources` line in a page's front matter and a list on a row, only when there are some, still format version 2. Import sets the list to match the export. Sync hashes sources only when a record has some, so records without them hash as before and the first sync after upgrading copies nothing; a removal on one side reaches the other.

Context cost, measured with `pnpm context-cost`: MCP from about 2,931 tokens a session to 3,091. The argument's description was cut to one line and its length limits left to core, which took it down from 3,164. The skill description is unchanged, at about 115 tokens.

22 tests added, across core services, REST, MCP, the console, the CLI, export and sync. 366 tests pass, 1 skipped, and the CLI smoke test passes. The console was checked by eye on a scratch database, pages and rows.

## 2026-09-13

### Tables are tables in the API, the MCP tools, the CLI and the export (ADR-026, step 2)

Step 1 renamed them in the web app; agents still read "collection" for a table, which now means a top-level page and its tree. The owner chose one word for people and agents alike, so every surface says table.

1. **MCP:** `list_tables`, `create_table` and `query_table`, and `table_id` wherever `collection_id` was. The old tool names are gone rather than kept beside the new ones, since each extra tool costs every session tokens. The server instructions gain one sentence saying what a collection is, and the workspace summary lists "Collections (top-level pages)" and "Tables". Measured with `pnpm context-cost`: about 2,942 tokens a session before, 2,931 after.
2. **REST:** `/api/v1/tables`. The `/api/v1/collections` paths still answer, and still list under `collections`, so a CLI from before this change keeps working.
3. **CLI:** `cairn tables`, and `cairn export --tables`. `cairn collections` and `--collections` still work.
4. **Export format version 2:** tables in `tables/`, counted as `tables`. Import reads version 1 exports as well.
5. **Sync:** saved state from before the rename is read and its keys renamed, so the next sync carries on where the last left off.
6. **Code:** the types, services, ports and tests say table (`Table`, `TableService`, `getTable`, `services/tables.ts`). The SQLite adapter keeps its `collections` table and `collection_id` columns, so no database migrates. Ids keep their `col_` prefix.
7. **Docs:** the PRD, ARCHITECTURE, CLI, LOCAL, ROADMAP, README, CLAUDE.md, the skill and the example seed say table. The PRD's data model now says what a collection is.

Four tests added: the old REST paths, the old CLI command, a version 1 export, and sync state from before. 344 tests pass, 1 skipped.

Deployed to Azure by image digest the same evening. `cairn sync` between the laptop and Azure then read the state saved before the rename and found nothing to change, 186 records the same.

### The peptide wiki is one collection

Following ADR-026, on the Azure Cairn, through the REST API, with an export taken first as a backup: the root page "Peptide database" (`pg_peptides`) was renamed "Peptides" and given a front page saying what the wiki holds and what its two tables are, and the nine other top-level pages (the category pages and the Stacks page) were moved under it. Every id stayed and nothing was deleted. The console's home now shows one collection, Peptides, with 96 pages and 2 tables, and the laptop's copy was brought level with `cairn sync`.

One name clash remains, left for the owner to decide: the Peptides collection holds a table also called Peptides.

### The web app opens on collections, and typed tables are called tables (ADR-026, step 1)

The owner: "home should just show available collections. a collection is kind of a database, tree shaped not table shaped", and "i open cairn web app, i see what collections are available each is a wiki. i navigate there". A collection is now a top-level page and everything under it; what Cairn called collections, rows sharing one set of fields, are tables.

1. **Home lists the collections,** one card each, with the front page's first paragraph and how many pages and tables it holds, then any table in no collection.
2. **Inside a collection, the sidebar shows only its tree,** headed by its front page.
3. **The menu is Collections, Recent changes and Tables.** Recent changes moved to `/changes`, tables to `/t`; "Pages" left the menu, and `/pages` and the old `/c` addresses redirect.
4. **The web app says table** wherever it said collection for one: "Put a table here", "Tables in this page", the Tables list and every breadcrumb.

Step 2, the same words in the API, MCP tools, CLI and export, follows in its own change. Six console tests changed and three added.

### Fixed: a page did not come first for its own title (ADR-025)

Searching each page's title, the page itself came first 22 times out of 97: "BPC-157" returned three pages whose "Related" sections link to BPC-157 before the BPC-157 page. The title and headings were stored with each chunk but never indexed, so they only counted where the text repeated them, and BM25 favours short sections dense with the name.

1. The heading path is now an indexed column, weighing 5 times the text in BM25. The index rebuilds itself on the next start.
2. A search whose words are exactly a page's title puts that page first, in both modes. A shared rule, in core, with a conformance test.

Measured on a copy of the wiki, 96 pages. Own page first: 96 of 96 in keyword and hybrid mode, from 22. The heading weight alone gives 92 in keyword mode. `pnpm eval` before and after, per mode: recall@5 0.83 and 0.83 keyword, 1.00 and 1.00 hybrid; questions with no answer 9 of 9 empty in all four runs. Fusing per page and weighting keywords in the fusion were tried and dropped: 67 to 76 of 96 at best, not worth changing every hybrid search.

### A page shows its collections inside it, and the Collections page groups them by root

The owner found the new layout confusing: "it's like now it is a referencing recursive link. my idea was that a new page could be created and promoted to root of both." The root page was called Peptides, the same as the table inside it, and the same two tables were listed three times on it: as links in its text, under "Links to", and under "Collections here".

1. **A page shows the collections under it in the page itself,** below its text, each with its name, row count and fields, like a Notion database inside a page. The side rail no longer lists them.
2. **"Put a collection here"** on every page moves a chosen collection under it: promoting a page to root of collections is done from the page.
3. **The Collections page groups collections under their root page,** with its ancestors above, then the collections under no page. The owner asked for this too: "when opening the collections page, show the root and sub collections".
4. **The owner's root page is now "Peptide database",** their choice, and its text no longer links to its own tables.

Three console tests changed or added. No API change.

### Released: v0.1.3, and Azure runs it

Collections in the page tree, relation fields as links, the console's head and the sync report fix, released on 6c092b0 with notes. Azure moved from a pinned build to `ghcr.io/vespassassina/cairn:0.1.3`; a sync with the laptop found the two still identical, 186 records.

### The owner's wiki: Peptides and Stacks under one page, stacks linked to their peptides

On Azure, after exporting a backup: a new page, Peptides (`pg_peptides`), with both collections moved under it, and Stacks' `components` changed from a list of names to a relation holding links to Peptides rows. All eight stacks were rewritten with the matching row ids, each as a revision with a change note; every name matched a row. BPC-157's row now shows the three stacks it is in. The start of the new version derived links for all 87 rows. The laptop copy took the changes with `cairn sync`.

That sync reported both collections as conflicts. A collection's sync hash now includes its parent, so the hashes saved before differ from both sides once; the newer side, Azure, won, which was right. The report then said the loser was "in its history", which is not true of collections: their schemas keep no history (ADR-008). It now says the other schema was replaced, and `docs/CLI.md` says so too. Nothing was lost here, since the two sides differed only in their parent.

### Added: collections in the page tree, and relation fields as links (ADR-024)

The owner asked for their two related collections to sit under one root, "by just adding a link", as a feature of Cairn, and whether rows could link to rows. They could not: collections were flat, and a relation field held one unchecked page id that no backlink ever saw.

1. **A collection sits under a page,** or at the top. Moving it changes one field; no row moves. One `move` operation for pages and collections: `POST /api/v1/move`, the MCP tool `move`, `cairn move`, and a form on the console's collection page.
2. **Relation fields name their target:** pages, or a collection, its own included, with `multiple` for a list. Every value becomes a link, so the page or row at the other end shows it as a backlink. Page text links to rows and collections with `[[collection-id/row-id]]` and `[[collection-id]]`.
3. **Everywhere links are read:** REST and MCP backlinks and neighbours take rows and collections, and describe each end as a page, collection or row. `cairn links` takes `collection-id/row-id`. The console shows collections in the tree under their page, names linked rows in tables, and gives each row its links and what links to it.
4. **Existing rows get their links on the next start,** once, since rows written before had none. `pnpm reindex` rebuilds them as well.
5. **Export, import and sync carry a collection's parent,** and create a relation's target collection before the collection that points at it. Sync now writes pages before collections (ADR-024 amends ADR-023).

The agent-facing text says the same: the workspace summary names the page each collection sits under, the MCP instructions say a relation links rows, and the skill explains relation fields, row links and `cairn move`. MCP now costs about 3,000 tokens a session against 2,725 before, measured with `pnpm context-cost`.

Also fixed: the MCP instructions told agents to link pages with `[[Page title]]`, but only `[[page-id]]` makes a link, as the `create_page` tool, the console and the extractor all say. An agent following the instructions wrote dead links.

20 new tests across the store, services, REST, MCP, console and CLI.

### The console's pages have a proper head, and the app is named Cairn

The owner asked for "proper html tags including title which should read Cairn". Every console, sign-in and OAuth page now starts with the same head: viewport, a description, `application-name` and `apple-mobile-web-app-title` set to Cairn, a theme colour, the SVG icon, a 180 pixel PNG for home screens (which do not take SVG), and a web manifest named Cairn with 180 and 512 pixel icons. The home page's title is "Cairn"; other pages read "Pages · Cairn" and so on. The sign-in page had no viewport tag, so it rendered at desktop width on a phone. An address the console does not know answered with bare text; it is now a "Not found" page. Two new tests.

### Released: v0.1.2, and Azure runs it

`cairn sync`, the cold start changes, the lock fix and the favicon, released on 4f80024 with notes written by hand before the run finished. Azure moved from a pinned `edge` build to `ghcr.io/vespassassina/cairn:0.1.2`, with the 30 minute idle time.

### Shorter and fewer cold starts on Azure

The owner asked how to fix the 30-second cold start. Three changes:

1. **The amd64 image drops NVIDIA libraries it never used.** On Linux x64, onnxruntime-node's install script downloads the CUDA and TensorRT libraries, and they went into the image: 342 MB compressed for amd64 against 137 MB for arm64, which gets no GPU download. Cairn runs its model on the CPU. The build sets `ONNXRUNTIME_NODE_INSTALL=skip`, and CI fails if either library is in the image. Pulling that image was 19 of the 30 seconds. After: 144 MB for amd64.
2. **`CAIRN_IDLE_MINUTES`, default 30:** how long Cairn stays up after the last request before scaling to zero. Container Apps' default was 5 minutes, so a pause in a working session meant another cold start. The waiting time comes out of the free grant.
3. **`CAIRN_ALWAYS_ON=true`:** one copy always running, so no cold starts at all, billed at Azure's lower idle rate while unused, which a month of goes beyond the free grant. Off by default.

Measured after, with the idle time briefly set to one minute to force a cold start: 26.5 seconds from request to answer, against 35 before. The pull fell from 19 seconds to 3.9. The rest is Azure's and the container's: about 7 seconds before the pull starts, 11 to create the container, 3 to restore the database and start, and a second or two for the startup probe. Only `CAIRN_ALWAYS_ON` removes those. At Sweden Central's published rates (vCPU $0.000024 a second busy and $0.000003 idle, memory $0.000003 a GiB-second), one copy of Cairn's size running all month and mostly idle comes to about $4 beyond the free grant, and $14 if something keeps it busy all the time, such as a sync every few minutes without `CAIRN_ALWAYS_ON`.

The template moves to the 2025-01-01 Container Apps API, which accepts `cooldownPeriod`; `az deployment group validate` passed with it. The Azure guide explains the settings, and warns that `cairn sync --every` more often than the idle time keeps Cairn awake at the full rate.

### Added: `cairn sync`, to keep two Cairns the same (ADR-023)

The owner asked for "an automigration feature to allow 2 cairns to be synced", after moving their wiki to Azure. `cairn sync <a> <b>` reads every page, collection and row from both servers, compares each with the content both sides agreed on at the last sync, and copies whichever side changed to the other, deletions included. When both changed a record, the newer edit wins on both sides and the replaced one stays in that record's history; the report names each conflict. `--every 5m` keeps it running, and `--dry-run` shows the plan.

The owner chose both rules: the newest edit wins with the other kept, and sync runs in the `cairn` command rather than inside a server. The state is a small file per pair of servers beside the CLI's sign-ins. Migrating to an empty Cairn is the first sync.

Rows and collections now carry `updated_at` in the REST API, which the conflict rule needs, and MCP row results carry it too through the shared `rowJson`.

14 tests drive two real Cairns through the command: migration, edits and creations both ways, deletions, a conflict with the loser in history, an edit beating a deletion, two Cairns already the same settling without writes, and a dry run. Checked for real with the compiled macOS executable between the owner's laptop and Azure: 185 records (96 pages, 2 collections, 87 rows) already the same, found in 0.6 seconds when Azure was awake and 35 seconds when it had to start.

### The owner's wiki moved to Azure

Exported from the laptop (96 pages, 2 collections, 87 rows), imported into Azure, and exported back: every file identical apart from the version and update fields an import sets. Searching all 96 titles on both gave the same top 10 pages for 89 and the same first result for 87; the rest differed by one page at the edge of the top 10, from near-ties that break differently between the laptop and Linux. Claude Code's `cairn` MCP server now points at Azure. The laptop's database stays as it was, and a copy was kept.

### Checked: Azure's cold start and restore

The first request after Cairn had scaled to zero took 35 seconds. The container logs split it: 19 seconds to pull the 340 MB image, which Container Apps does not keep once scaled to zero, 6 to create the container, and 3 to restore the database and start listening. The database came back complete each time. ADR-018's "a few seconds" was the restore alone; the Azure guide now gives the whole number. A smaller image, or one replica kept warm at a cost, would shorten it; neither is done.

Two deployment gaps found on the way. Running `deploy.sh` again with the same moving tag (`edge`, `latest`) does not start a new version, because Container Apps only does so when the image name changes; the guide now says to name a version. And the script's health check was answered by the old version while the new one was still starting, so it reported success too early; it now waits for the new version to be ready.

### Fixed: writes failed with "database is locked" under load

The first import into Azure stopped after 84 of 96 pages with "database is locked". Three connections share the database file (the document store, the search index and the auth store), and Litestream reads it beside them. Only the auth store set a busy timeout, so a write that met a lock held by another connection failed at once instead of waiting. On Azure's quarter of a CPU the background embedding writes vectors for longer, which made the collision likely; on a laptop it had not shown up. The document store and search index now wait up to 5 seconds for a lock. A new test holds the write lock from another process and checks that both still write.

### Added: a tab icon for the console

The owner asked for a favicon. A cairn of four stones in the console's accent blue, lighter when the browser is dark, served at `/assets/favicon.svg` and linked from the console, sign-in and consent pages. `/favicon.ico` redirects to it, since browsers ask for that path regardless.

### Fixed: the image could not reach its replica; Azure's default region is now Sweden Central

The first real Azure deployment found two problems, neither visible to CI.

1. **Litestream could not verify any TLS certificate.** The container started, and every restore failed with "x509: certificate signed by unknown authority". Litestream is a Go program and reads the system's CA certificates, which `node:24-slim` does not have; Node carries its own, so the server was never affected. CI never set a replica, so Litestream never made a request. The image now copies the CA bundle from its Litestream build stage, and CI checks the bundle is there. `0.1.0` has the bug: an Azure deployment needs `0.1.1` or later. Deployments on your own server without a replica were not affected.
2. **West Europe refuses new subscriptions.** Azure rejected the storage account and the environment with "The selected region is currently not accepting new customers". `deploy.sh` now defaults to `swedencentral`, and reuses an existing resource group instead of trying to recreate it, since a group created by a refused run blocked the next run in another region. The Azure guide and `docs/AGENT-INSTALL.md` say how to check a region first.

`docker/start.sh` also says which replica it is restoring from, because Litestream retries network errors for minutes before printing one, and Container Apps' startup probe restarted the container before the error appeared.

### Released: v0.1.0

The first release, tagged on 10b1d69 after that commit passed CI on `main`. The tag's run built and published:

1. **Images** `ghcr.io/vespassassina/cairn:0.1.0`, `0.1` and `latest`, for amd64 and arm64. All three pull anonymously, so the deploy defaults, which use `latest`, work without the `edge` override.
2. **The `cairn` executables** for macOS (arm64, x64), Linux (arm64, x64) and Windows (x64), with `SHA256SUMS`, on https://github.com/vespassassina/cairn/releases/tag/v0.1.0. The macOS arm64 file was downloaded from the `latest/download` address, matched its checksum, and printed `cairn 0.1.0`.

The release workflow creates the release with an empty description, so the notes were added by hand after the run. The guides no longer tell readers to use `edge` or build the CLI "until the first release": `docs/CLI.md`, `docs/DEPLOY-AZURE.md` and `docs/AGENT-INSTALL.md`, where the image check now stops at anything but `200` on `latest` instead of falling back to `edge`.

### The container image is public

The owner made `ghcr.io/vespassassina/cairn` public. Checked with the anonymous pull in `docs/AGENT-INSTALL.md`: `edge` returns 200, for amd64 and arm64. `latest` does not exist until the first release tag, so deploys use `CAIRN_IMAGE=ghcr.io/vespassassina/cairn:edge` until then, as the guides say.

### Checked: the image with the embedding model, on Linux

The first CI run with ADR-022 passed on every job. In the image smoke test, semantic search reached `ready`, a search ran in hybrid mode, and the container used 142.7 MiB with the model loaded and one page embedded. That is well inside Azure's 0.5 GiB; the peak while embedding a large wiki on Linux is still to be measured on a real deployment.

### Added: search by meaning, with sqlite-vec and a small English model in the container (ADR-022)

Search now matches meaning as well as keywords, for English text. "Something to help me fall asleep" finds DSIP, whose page only says "sleep"; "anything for wrinkles" finds Matrixyl.

1. **Vectors in SQLite** through the sqlite-vec extension, in tables created only when embeddings are on.
2. **bge-small-en-v1.5** (34 MB, English only) runs in the server process through transformers.js, behind a new `Embedder` port and the `adapter-embeddings-local` package. On by default; `CAIRN_EMBEDDINGS=off` turns it off.
3. **Background embedding.** Writes never wait for the model. Chunks are embedded after each write, and caught up by a hash comparison when the model loads, so nothing is embedded twice.
4. **Hybrid search** fuses the keyword ranking with the nearest vectors (reciprocal rank fusion). A vector match counts only when it stands at least 0.065 above the similarity of its neighbourhood, which, unlike a fixed threshold, separates conversational questions with an answer from on-topic questions without one.
5. **Degrades to keyword search** when the extension or model cannot load or fails, and `/health` reports `semantic_search` with the reason.
6. **The image ships the model and the native packages** for its own platform only (about 110 MB more), and never downloads at runtime. CI now checks that semantic search reaches `ready`, runs a hybrid search, and logs the container's memory.
7. **Azure:** a template parameter and `CAIRN_EMBEDDINGS` in `deploy.sh`. The container size stays at 0.25 vCPU and 0.5 GiB.

Measured, SQLite FTS5 plus sqlite-vec, 96-page wiki, 18 queries with an answer and 9 without: recall@5 0.83 keyword, 1.00 hybrid; no-answer queries returning nothing, 9 of 9 in both. Memory 347 MB with the model loaded and every chunk embedded, after cutting the model's batch to one text per call (it was 1.3 GB at 32).

Also: seven eval queries (h01 to h04 with answers, n07 to n09 without), eight hybrid conformance tests with a fake synonym embedder, SQLite tests for restarts and model changes, a real-model test behind `CAIRN_TEST_MODEL=1`, and the search wording in the tool description, instructions, skill and CLI help. MCP context stays at about 2,725 tokens.

Why: the owner asked for vector search in SQLite with an in-container model. Keyword search could not bridge different words for the same thing.

### Changed: commits go straight to main

No branches or pull requests from now on (owner direction). `CLAUDE.md` has a Workflow section.

## 2026-09-12

### Fixed: search returned pages for questions Cairn has no answer to (ADR-021)

Search matched any one word of a query, so every question returned something. Now a page must hold most of the query's words, filler words in English, Italian and Dutch are ignored, words are stemmed ("peptides" finds "peptide"), and each matching page's best chunk comes before a second chunk of any page. The rules live in core and in the search conformance suite, for every backend.

Before and after, SQLite FTS5, keyword mode, 96-page peptide wiki: recall@5 1.00 and 1.00 on 14 queries; no-answer queries returning nothing, 0 of 6 and 6 of 6.

Also:

1. The eval scores questions with no answer (`expected: none`), with six new queries n01 to n06.
2. An existing search index is recreated with the stemmer at the first start and rebuilt from the pages (`needsRebuild` on the port). 96 pages took 61 ms.
3. The search tool description, the server instructions, the skill and `cairn --help` say a page must hold most of the words, and to use two or three distinctive ones. MCP context went from about 2,716 to 2,726 tokens; the README's "about 2,700" stands.
4. 18 new tests: the term rules, five conformance tests for the match rule, stemming and the index upgrade in SQLite, the upgrade at startup, and no-answer scoring.

### Decision: one container everywhere, and your own server as a target (ADR-020)

Cairn runs as one container on every target, with nothing beside it. Azure Functions and AWS Lambda are dropped as targets and spike S1 is closed without running. Cosmos DB and DynamoDB become optional storage adapters for the same container, built only if someone needs more than one instance, the cold restore gets too slow, or the write-loss window matters. SQLite with FTS5 stays the store everywhere, kept either on a mounted local volume or by a Litestream replica, or both.

Why: the owner asked whether Functions and Cosmos would serve Azure better. Functions adds little over Container Apps for Cairn and costs portability; Cosmos adds durability and scale-out that one person does not need yet, and costs search quality (no Dutch, multi-language in preview) and test coverage. The owner chose containers, "as compact as possible, not a fleet", and asked for local mounted storage to run on Proxmox.

Added:

1. `deploy/docker/compose.yaml` and `env.example`: one service, the database in a local folder, the port on 127.0.0.1 unless `CAIRN_BIND` says otherwise, secrets in a git-ignored `.env`.
2. `docs/DEPLOY-DOCKER.md`: own server, HTTPS through a proxy or tunnel, Proxmox VM and LXC notes including the unprivileged uid mapping, backups.
3. `docker/start.sh` now says whether the database is on a mounted volume, and stops with the `chown` to run when `/data` is not writable, instead of failing later inside SQLite.
4. CI starts the image with a mounted folder, checks the database file appears there, checks a read-only folder is refused with that message, and validates the compose file.
5. `docs/AGENT-INSTALL.md` offers the own-server path, keeping `deploy/docker/.env` out of the agent's reach like the Azure settings file.
6. The server's OAuth configuration errors point to both deploy guides.

Also fixed: `docs/LOCAL.md` still listed OAuth and export as not built.

Not yet checked: a run on Proxmox. CI covers the image and the compose file.

### Decision: installation is written for agents first (ADR-019)

`docs/AGENT-INSTALL.md` is a script for a coding agent: ask where Cairn should run, check prerequisites, run and check each step, hand over. Credentials stay with the person: they sign in to Azure and create the OAuth app themselves, and paste the client secret into the deploy script's private settings file, which the agent is told never to read. `AGENTS.md` and the top of CLAUDE.md point agents at it, and the README leads with "clone it and ask your agent".

Why: the owner expects most people to install Cairn this way.

### Decision: Azure runs Cairn as one container with Litestream (ADR-018)

Container Apps on the consumption plan, scaled to zero, one replica at most. The database stays on the container's disk and Litestream streams it to Blob Storage, restoring on start, through the app's managed identity, so no storage key exists anywhere. No Log Analytics. `deploy/azure/main.bicep` and `deploy.sh` do it in two passes, because the OAuth app needs the address the first pass reveals. `docs/DEPLOY-AZURE.md` is the guide.

Why: the owner asked for Azure deployment now. The PRD's Functions and Cosmos path needs an adapter and a spike that are not done; the container path works today inside the free grants and leaves that path open.

Checked: CI compiles the template, lints the scripts, and builds and starts the image. Not yet checked: a real deployment.

### Added: the server image and a bundled server

`pnpm build:server` bundles the server with esbuild into one 2 MB file that runs with nothing but Node; checked from a folder with no config and no `node_modules`. The `Dockerfile` adds Node and Litestream v0.5.7, pinned by checksum. CI publishes it to `ghcr.io/vespassassina/cairn` for amd64 and arm64: `edge` from `main`, versions and `latest` from tags.

### Decision: the OAuth server as built (ADR-017)

A small OAuth 2.1 server: discovery (RFC 8414, RFC 9728), dynamic client registration, authorization code with PKCE, a consent page, single-use rotating refresh tokens with reuse detection, revocation. Sign-in through GitHub or any OpenID Connect provider, against an allowlist. Access tokens are HS256 JWTs checked locally. Auth records live in a new `AuthStore` port with a conformance suite, apart from content. The console signs people in through the same provider and attributes their writes to them. `cairn login`, `whoami` and `logout` sign the CLI in through the browser.

It amends ADR-007 in five places, each with its reason in ADR-017. The largest: a consent page, because dynamic registration plus a provider that approves silently would otherwise let another site obtain a token for the owner's Cairn.

Public mode: a non-loopback bind now starts, but only with OAuth fully configured, and it forces local trust off, because there the Host header is attacker-controlled. A partial OAuth setup is a startup error that names every missing setting. Secrets come only from the environment.

Checked: 18 end-to-end tests of the flow and its attacks with a stand-in provider, 5 of `cairn login` through a real loopback listener, 6 of the configuration rules, and a live run of the real entry point with GitHub settings showing the metadata, the sign-in button and the redirect to GitHub. Not yet checked: a sign-in against real GitHub, and a claude.ai connector.

### Fixed: console form checks and cookies behind a TLS proxy

Behind Azure's ingress the server sees plain HTTP, so comparing a form's Origin with the request's own URL would have refused every console form in the cloud. With a public URL configured, the check and the cookies' Secure flag use it instead. Found while reading the code for OAuth, before it failed anywhere.

### Decision: export is Markdown and JSON that imports back without loss (ADR-016)

`cairn export <folder>` writes pages as Markdown with a small front matter, in folders that mirror the page tree, collections as JSON, and a manifest; `--root` exports one page and everything under it. `cairn import` reads it back keeping every id, compares before writing, and changes nothing on a second run; `--dry-run` shows the plan. REST gained `GET /api/v1/export/pages` and `PUT` for pages and collections at a given id.

Why: the owner asked for data owned by its users and reprocessable, whole or by root. Checked on the peptide wiki: exported, imported into an empty database, exported again, and the two exports were identical.

### Changed: the peptide wiki seed follows the updated wiki

The wiki grew to 79 peptides, 8 categories, and a new stacks file, with citations and mixing notes per peptide. The seed now writes a Stacks page with a page per stack, links stack components and mixing notes, lists citations, and fills a second collection, Stacks. Reseeded in place: 63 pages created, 33 updated, 96 in all, every change a revision.

### Added: fourteen eval queries, and a first recall number

q03 to q16, written from the wiki and each checked against its text: brand names, aliases, nicknames, descriptions and sentence-shaped questions. recall@5 is 1.00 on all fourteen, eleven at rank 1. Caveat: they were written by the agent that knows the content, so they are easier than real searches; q17 to q30 are left for the owner. The eval also shows the known weakness: q01 and q02, about content Cairn does not hold, return four or five unrelated pages instead of nothing.

### Fixed: heading paths nested sibling sections

A page starting at level 2 recorded "Status > Origin" for two sibling sections, because the chunker cut the path by heading depth. It now keeps a stack of open headings. Every search result showed the wrong path; found on the reseeded wiki.

### Fixed: `pnpm import` and `pnpm rebuild` ran pnpm's own commands

Both names are pnpm built-ins, which win over package scripts, so the documented commands never ran Cairn's. They are now `pnpm import:markdown` and `pnpm reindex`. The docs were wrong since the PoC.

### Fixed: `pnpm eval` and `import:markdown` looked for paths in the wrong folder

pnpm runs package scripts from the package folder, so `eval/queries.yaml` and relative folders were looked for under `packages/api`. The eval file now resolves next to `cairn.config.json`, and paths you type resolve against the folder you typed them in.

### Finding: the first CI run, on every OS

The test suite passed on Linux x64, Linux Arm, macOS and Windows on the first run, with no Windows-specific failures. Every CLI executable passed its smoke test on its own OS. The one failure was the smoke script deleting its temporary folder before the server had exited, which Windows does not allow; the script now waits and retries. `docs/CLI.md` now says what has been tested where.

### Decision: free for non-commercial use, under PolyForm Noncommercial 1.0.0 (ADR-015), and the repository is public

Cairn is published at https://github.com/vespassassina/cairn. `LICENSE` holds the PolyForm Noncommercial 1.0.0 text with a `Required Notice` line, and every package declares `PolyForm-Noncommercial-1.0.0` with a link to the repository.

Why: the owner wants anyone to be able to use, change and share Cairn, but not for profit. PolyForm Noncommercial is the standard licence written for exactly that, for software. It makes Cairn source-available rather than open source, so the README, PRD and CLAUDE.md no longer call it open source, and PRD risk R6 covers how that reads on Hacker News.

AGPL-3.0 was chosen first, then replaced before anything was pushed, because AGPL allows commercial use. The AGPL text was never published: a licence grant cannot be withdrawn, so the unpushed commit that held it was changed rather than followed by a new one. PRD Q4 is answered.

Before the first push, commit authorship moved from a personal address to the GitHub no-reply address, so no private inbox is in the public history. The README's status line, which still said "design", now says what runs today: that doc was wrong.

### Decision: the CLI ships as an npm package and as standalone executables (ADR-014)

`pnpm build:cli` builds `cairn` for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64` and `windows-x64`, into `dist/cli/` with a `SHA256SUMS` file. Each executable carries its own runtime, so it needs nothing installed. Node users can still install it with npm.

Why: the owner asked for the CLI to build for Windows, macOS and Linux, with clear docs. Bun compiles for every platform from one machine, where Node's single executable applications need each platform's own Node binary. Bun is a build tool only; the server and tests stay on Node, and its version is pinned.

Checked: all five build from one Mac and are the right executable format. Both macOS builds pass `pnpm smoke:cli`, which runs the executable against a real server: create, read, append, search, changes and a version conflict. The Intel build ran under Rosetta. The build also works without Bun installed, fetching the pinned version. Linux and Windows executables have not been run yet; CI runs them on each OS once the repository is on GitHub.

### Added: CI for Linux, macOS and Windows

`.github/workflows/ci.yml` runs the tests on Linux x64 and arm64, macOS and Windows, then builds the CLI on each runner and smoke-tests it. A version tag builds all five executables and attaches them to a GitHub release. `.gitattributes` checks text out with LF on every OS, so tests that compare text behave the same on Windows.

### Added: `docs/CLI.md`, installing the CLI on each OS

Which file to download for which machine, how to check it against `SHA256SUMS`, where to put it and how to add it to the PATH on macOS, Linux and Windows, how to get past the unsigned-executable warnings, environment variables in each shell, installing the skill, and uninstalling. It ends with a table of what has been tested where.

### Changed: the CLI turns Windows line endings into plain newlines, and prints its version

Text piped in or read with `--file` on Windows arrives with a carriage return on every line; the CLI now stores plain newlines. `cairn -V` and `cairn version` print the version (`--version` was already the page version for edits).

### Fixed: a raw NUL byte in `pages.ts` made git treat it as binary

`PageService` compared tag lists by joining them with a NUL character, written into the source as a raw byte. The code worked, but git treated the file as binary, so diffs and grep skipped it. It now compares the lists as JSON. A scan of every file in the repository finds no other control bytes. See `docs/LESSONS.md`.

### Decision: one core, three surfaces (ADR-013)

Agents now get in three ways: MCP, a REST API at `/api/v1`, and a `cairn` command with a skill file. All three sit on the same core, the same auth check and the same error codes. ADR-001 is refined, not replaced: the agent is still the primary client, and MCP is now one of its doors.

Why: MCP loads every tool schema into every session, used or not. The most common Hacker News complaint about agent memory tools is exactly that cost. Agents with a shell can use a command that costs nothing until it runs.

### Added: REST API at `/api/v1`

Pages, collections, rows, history, revisions, search and an overview, with version tokens as `ETag` and `If-Match`. `PATCH` and `DELETE` without `If-Match` get 428, and a wildcard is refused, so no write skips the concurrency check. A stale version gets 409 with the current content. Pages can be read as Markdown with `?format=markdown`, the cheapest read for an agent. 20 contract tests.

### Added: the changes feed

`GET /api/v1/changes?since=<time>&actor=agent|user` lists revisions newest first. `since` is inclusive, and the response says which value to pass next time. This is how a second agent, a script or another machine finds out what changed, instead of searching again.

### Added: the `cairn` CLI and skill

`packages/cli` is a dependency-free HTTP client with compact text output and `--json` for scripts. `skills/cairn/SKILL.md` tells a coding agent when to use it, in the same terms as the MCP server instructions. `cairn append` may skip `--version`, because appending never overwrites; every other edit needs the version the agent read. Checked live against a copy of the seeded wiki, and by 9 tests that drive the real app.

### Changed: MCP and REST share one operations module

Edit modes, section replacement, error mapping and the JSON shapes of pages, rows and revisions moved from the MCP tools into `packages/api/src/operations.ts`. The MCP tools now translate only. No change to their behaviour; the existing contract tests pass unchanged.

### Finding: MCP costs about 23 times more context than the CLI

`pnpm context-cost` measures what each door sends. On the peptide wiki, MCP sends 10,721 characters per session, about 2,700 tokens: 8,912 for the 12 tool schemas, 1,809 for the instructions and summary. The skill description is 459 characters, about 115 tokens, and the skill body, about 724 tokens, loads only when Cairn is used. Tokens are estimated at four characters each. The README states these numbers.

### Changed: the workspace summary no longer names an MCP tool

The collections heading said "query with query_collection", which is wrong for a CLI user reading `cairn overview`. It now just says "Collections".

### Direction: the tagline is "a wiki and tables your agents can write to, with every change reviewable"

The owner chose it from the project review. The PRD and the README lead with it, and the README now shows the three doors and their context cost.

### Finding: the landscape, and what to fix before publishing

A review against similar projects on Hacker News and elsewhere. Agent memory is crowded and HN is tired of it: a typical comment on a 71-point Show HN called another memory tool "about the same as grep in a memory/ directory". The closest projects are Basic Memory (Markdown and MCP, no typed tables, history only in its paid cloud) and Remnus (pages and databases over MCP on SQLite). No one found combines typed tables, a revision for every write, a review screen for agent writes, and one codebase for local and free-tier cloud. PRD section 1 records the landscape.

The same review found gaps to close before launch, now the roadmap's launch checklist: the eval set has 2 of 30 queries, export is not built, nothing runs on a cloud yet, OAuth is missing so claude.ai cannot connect, and the online and offline model is not designed.

It also answered parts of Q1 and Q7 from Microsoft's docs. Cosmos vector indexing is not supported on shared-throughput accounts, so vectors on the free tier need a dedicated container. Flex Consumption grants 250,000 executions and 100,000 GB-s a month. Cosmos full-text lists Italian, but multi-language support is in preview and Dutch is not listed.

### Decision: a live summary of the workspace in the server instructions (ADR-012)

At initialize, the instructions now end with what the workspace holds: collections with row counts, the page total, top-level pages largest first with the number of pages under each, and up to 12 common tags. On the peptide wiki the whole text is 1,838 of the 2,000 characters.

Why: ADR-011 told Claude to search Cairn when it might hold a topic, but Claude could not know what it held without searching first. The owner asked whether Cairn advertised its topics; it did not.

Safety: titles and tags are written by agents too, and this text reaches every session. Each value is flattened to one line, cut to 60 characters and written as a JSON string, and the summary says they are data, never instructions. A test stores a title that tries to inject new lines and a fake entry, and checks it stays on one quoted line. The summary is built only for initialize, cached for 60 seconds, and a failure to build it falls back to the fixed text.

### Decision: Cairn tells clients when to use it (ADR-011)

Cairn now sends MCP server instructions at initialize: search before answering, save lasting knowledge without being asked, prefer updating an existing page, give every write a change note, merge on a version conflict, never store secrets. The text is 1,221 characters in `packages/api/src/mcp/instructions.ts`. A contract test holds it under a 2,000 character budget and checks that every tool it names exists.

Why: tools are available to a client, never required. Without guidance, Claude used Cairn only when asked, which makes it a store rather than memory. Server instructions reach every Claude Code session with no setup, unlike a per-user CLAUDE.md.

The owner's own global Claude Code instructions gained a matching section. That file is outside this repo; `docs/DIRECTIONS.md` records it.

### Fixed: `pnpm dev` crashed with a raw stack trace when the port was taken

The owner's `pnpm dev` failed because a server the agent had started was holding port 8787. It now prints what EADDRINUSE means and how to check, find or move away from the other process. See `docs/LESSONS.md`.

### Fixed: the server did not answer on IPv6 localhost

It bound 127.0.0.1 only, so a client resolving `localhost` to ::1 would get no answer. It now binds both loopback addresses. The IPv6 one is optional, and the startup banner lists what was bound.

### Added: logs of owner directions and of failures and lessons

`docs/DIRECTIONS.md` keeps the owner's instructions, in their words, with where each landed. `docs/LESSONS.md` keeps failures with cause, fix and lesson, backfilled to the start of the project. `docs/README.md` maps all the docs. CLAUDE.md's documentation discipline now names the four logs: directions, decisions, changes, lessons.

Why: the owner asked for it, because Cairn will be open source. The ADRs and this file kept the decisions and the work, but not the original ask or what went wrong, so a reader could not tell the owner's choices from the agent's, or learn from the failures.

### Changed: `docs/LOCAL.md` and the README for connecting Claude Code

They now use `--scope user`, say that a session must be restarted to see a newly added server, explain the port-in-use message, and describe the server instructions and tool permissions. The old LOCAL.md intro still described a static bearer token, which ADR-010 removed; that doc was wrong and is now fixed.

### Decision: no sign-in on localhost (ADR-010)

On the loopback dev server, requests addressed to a trusted local host name need no token, in the console or over MCP. `CAIRN_TOKEN` is now optional. Extra host names and an off switch live in a new, committed `cairn.config.json`.

Why: the owner asked for it, and a token on a loopback-only server protected against little while making the console look broken.

What keeps it safe: the Host header must be on the trusted list, which defeats DNS rebinding, and MCP refuses any request carrying a foreign Origin, which defeats cross-site requests from a page in the owner's browser. Both attacks have tests.

### Fixed: the console did not start from the app's launcher

The launch config ran `bash -c` from a working directory it could not read, and relied on `$PWD` and an nvm-installed pnpm that a non-interactive shell does not have on its PATH. The server never started. It now uses absolute paths and sets PATH. The config stays untracked because it names machine-specific paths.

### Fixed: a relative database path depended on the start directory

`./cairn.sqlite` resolved under `packages/api` when started through `pnpm dev`, and under the repo root when started elsewhere. A relative path now resolves against the config file, or the working directory when there is none.

### Verified: the review console, visually

Checked in the browser pane on the seeded wiki:

1. Recent changes with actor pills and notes.
2. The page view with its tree, breadcrumb and rail of links and tags at desktop width.
3. The collection table.

This closes the visual check that the console entry below left open.

### Added: review console (ADR-009)

A server-rendered console in the same Hono app. It has these screens:

1. Recent changes, filterable to agents or people.
2. Read-mode pages with a page tree, backlinks, outbound links and the last actor.
3. A Markdown editor with preview.
4. History with a per-version diff and restore.
5. Collections as a sortable table, with row forms built from the schema.
6. Search, and new page.

It is styled with artifactkit, embedded by `pnpm sync:artifactkit` as a generated module. Cairn adds one small stylesheet that uses only artifactkit tokens.

Why: agents write directly (ADR-008), and the owner needs to see and undo what they wrote.

Security choices, because agent-written content is rendered here:

1. Markdown is rendered with raw HTML disabled, and links are limited to http, https, mailto, anchors and page links.
2. A strict Content-Security-Policy applies: no inline script or style, no external images, no framing.
3. Sign-in sets an HttpOnly, SameSite=Strict cookie holding an HMAC of the dev token, never the token itself.
4. Every form post must carry a matching Origin header.
5. Search snippets are escaped before match markers become `<mark>`.

A save that loses a version conflict keeps the owner's text, shows the difference from the version that won, and makes the next save a deliberate overwrite. The other version stays in history.

### Finding: artifactkit's documented paths are stale

The skill's instructions point at `src/` and `examples/templates/`. The files live in `assets/` and `assets/templates/`. The sync script reads `assets/` and accepts `ARTIFACTKIT_DIR` to override.

### Not yet verified: how the console looks

It is covered by 24 contract tests: sign-in, cross-origin refusal, escaping of hostile content, conflicts, restore and collections. It has not been checked visually. No headless Chrome is installed, and the browser pane would not load the rendered snapshots. That check is still owed (artifactkit gate G4).

### Added: revisions for pages and rows (ADR-008)

Every write of a page or row now stores an immutable full snapshot with the actor, time and an optional change note, linked into a chain by the version it replaced. Pages and rows carry `updatedBy`. Restore writes an old snapshot as a new revision. Deletion records a final revision, so history survives it.

MCP gains `get_history` and `get_revision` (with a +/- diff), and `create_page`, `update_page` and `upsert_row` accept `change_note`. MCP writes are attributed to an agent actor labelled with the client's user agent. Command-line writes are attributed to the owner via the named tool (import, seed).

Why: agents write directly (ADR-008), so every write must be visible and reversible.

Design details worth keeping:

1. The service chooses version tokens, so a record and its revision share one. The port's write methods now take a `WriteMeta`.
2. Revision first, then the record. A version conflict deletes the new revision. A crash between the two leaves a revision off the chain, which history never shows because it is read by walking the chain from the current version.
3. `pnpm rebuild` sweeps revisions off the chain, but only those older than an hour. A younger one may belong to a write still in flight, and deleting it would break that write's chain.
4. Row revisions are filed under `<collectionId>/<rowId>`, because row ids are only unique within a collection. Found by a test that reused a row id across two collections.

### Changed: existing SQLite databases migrate in place

`init` adds the `updated_by` column to tables created before revisions existed, with a default actor labelled "Before history was recorded". History for those records starts at their next write.

Why: the owner's local database already held the seeded wiki. Throwing it away to change a schema would teach the wrong habit.

### Finding: MCP client identity is not available on tool calls

In stateless mode the client sends its name only at initialize, and every tool call is a fresh request. The user agent header is the only per-call signal until OAuth client registrations exist (ADR-007).

### Direction: track every decision, keep the docs aligned

Every change now records what and why in this file, and the PRD, roadmap, architecture blueprint and ADR index move with the code in the same commit. See CLAUDE.md, "Documentation discipline".

Why: the project is being designed in conversation, and conversations are lost. Without a written trail, the reasons behind a decision disappear and the decision gets relitigated or silently reversed.

### Decision: every write is a revision, agents write directly (ADR-008)

Pages and rows get full-snapshot history with actor attribution and change notes. Agent writes apply at once, with no approval step.

Why: approval would put the owner on the critical path of every agent action and work against the four-days-a-week usage goal. History with one-click restore gives most of the safety with none of the waiting.

### Decision: a review console in Phase 1, styled with artifactkit (ADR-009)

A small server-rendered console for reviewing, navigating, editing and restoring. The rich editor stays gated to Phase 2.

Why: MCP-first means Claude writes unsupervised. The owner needs to see and undo what it wrote, or trust never forms. That is part of Phase 1, not the editor. artifactkit is the owner's existing visual language, and reusing it avoids designing a second one.

### Added: peptide wiki seed example

`examples/peptide-wiki` seeds a local Cairn from the wiki's source JSON: 7 category pages, 26 peptide pages, related peptides as links, and a Peptides collection.

Why: search quality only means something on real content, and this is the owner's real content. It reads the JSON rather than the generated HTML because the HTML pages are mostly filled in by JavaScript and carry little static text.

Probe results on it: "tendon healing", "GLP-1 weight loss" and the alias "Bepecin" all find the right pages first. Backlinks and collection queries return the expected sets.

## 2026-09-11

### Added: local PoC

`packages/api`: Hono app, MCP server over stateless streamable HTTP, dev-mode bearer auth on loopback only, and the `import`, `rebuild` and `eval` commands. Ten MCP tools, with contract tests.

Why: the kill criterion (PRD section 10) can only be tested by using Cairn from Claude. A local build gets there without OAuth, a cloud account or a tunnel.

### Added: `create_collection` MCP tool

Not in the original PRD tool list.

Why: the PRD assumed collections are created in the web editor, which is Phase 2. Without this tool, collections could not be used at all during the MCP-only phase.

### Finding: a stateless MCP transport cannot be reused (ADR-006, spike S2)

The SDK's web-standard transport answers S2: `@hono/mcp` is not needed. But in stateless mode a transport throws on its second request, so the server is built per request.

Why it matters: this suits serverless, where instances share no memory, and it means the API holds no per-connection state at all.

### Decision: Claude Code first, content from a real folder

The PoC targets the Claude Code CLI, which accepts plain http on localhost with a bearer token. Claude Desktop needs https and OAuth, so it waits for ADR-007.

### Added: Phase 0 foundations

`packages/core` with both adapter ports, the filter grammar, row validation, link extraction, chunking, services and three conformance suites. `packages/adapter-sqlite` on Node's built-in `node:sqlite`, with FTS5 for search.

Why `node:sqlite`: FTS5 with bm25 and snippets ships in Node's bundled SQLite, so the reference adapter needs no native dependency and no build step.

### Decision: the adapter boundary (ADR-005)

Search is its own adapter. Derived data is rebuildable. No transactions across documents. Consistency is stated per operation. Collection filtering runs in core, with optional pushdown.

Why: pairing search with the document store per cloud made AWS impossible, because DynamoDB has no full-text search. The other rules each close a gap where SQLite behaviour would pass locally and fail on Cosmos or DynamoDB.

### Decision: Hono with a stateless MCP transport (ADR-006)

Why: stateless is the only mode that fits Lambda and Azure Functions, which recycle instances and share no memory.

### Decision: one small OAuth server in front of any OIDC provider (ADR-007)

Why: per-cloud identity services would mean three auth code paths in the part of the system most likely to stall the project.

### Changed: vitest 5 and vite 8

Why: vite 5 cannot resolve `node:sqlite`, and vitest 5 needs vite 6 or later.

## 2026-09-10

### Design: PRD v0.1 and ADR-001 to ADR-004

Initial design. MCP is the product, the web editor comes second, the graph is edge documents, embeddings are bring-your-own, chunks live in their own store.
