# Failures and lessons learned

What broke, why, how it was fixed, and what to do differently. Newest first.

This log holds failures: bugs, broken tooling, wrong assumptions, and mistakes made while building, including the agent's own. Findings that shaped a decision, such as a spike result, go in `docs/CHANGELOG.md` and the ADR they support. A failure that led to a decision gets an entry here and a link to the ADR.

Each entry answers four questions:

1. **What happened.** The symptom, as it was seen.
2. **Cause.** The real reason, not the first guess.
3. **Fix.** What changed, with the commit or file.
4. **Lesson.** What to do differently next time. This is the part worth reading.

## 2026-09-17

### An unreachable Cairn named the address it tried, but never why that one

1. **What happened.** `cairn overview` with no `--instance`, no `CAIRN_URL`, and nothing registered, against a server that was not running, printed "cannot reach Cairn at http://localhost:8787. Is the server running?" That names an address, but not that `localhost:8787` was a default the CLI picked because nothing else was given, which coding style rule 2 requires ("say when a default was used"). Someone who had never set `CAIRN_URL` and did not know the default port could read this and wonder whether they had misconfigured something.
2. **Cause.** `CairnClient.request`'s catch block in `packages/cli/src/client.ts` only ever had the `baseUrl` to report; nothing upstream told it whether that URL came from an explicit `--instance`, an explicit `CAIRN_URL`, or the hardcoded fallback in `main.ts`. The information existed at the point `baseUrl` was chosen, three functions away, and was never carried forward.
3. **Fix.** Added an optional `chosenBecause` to `ClientOptions`, set in `main.ts` alongside `baseUrl` itself: `undefined` when `--instance` or `CAIRN_URL` picked it, a description naming the instance when `firstReachable` picked one of several registered instances because none was named, and "the default, since no --instance, CAIRN_URL or registered instance was given" when nothing at all was configured. The unreachable error appends it in parentheses when set. `packages/cli/src/client.ts`, `packages/cli/src/main.ts`, tested in `packages/cli/test/client.test.ts` and `packages/cli/test/cli.test.ts`.
4. **Lesson.** An error can only say why a default was used if the code that chose the default is still in scope, or passed its reasoning along explicitly, when the error is finally raised three layers later. Carrying a short "why" string alongside a value from the point of choice to the point of failure costs little and is the only way coding style rule 2 can be honoured once the two are in different functions.

### A reported apostrophe-dropping bug in search snippets did not reproduce

1. **What happened.** The console-and-search-polish spec (fault 4) recorded a report that a search snippet drops an apostrophe, producing "the page s history" in place of "the page's history", with the cause left unestablished because the spec itself was written before anyone had traced it.
2. **Cause.** None found. FTS5's `snippet()` is documented to copy the original stored text verbatim between token offsets recorded at index time, independent of how the tokenizer split that text for matching, and every test run here confirmed that documented behaviour holds under the current setup: SQLite 3.53.4 via Node's built-in `node:sqlite`, tokenizer `porter unicode61 remove_diacritics 2`. Straight and curly apostrophes were both preserved across many query terms, snippet-window positions, and sentence shapes, tested both against raw FTS5 SQL and against the full `SqliteSearchIndex.search()` path end to end. Reading `packages/core/src/indexer/chunk.ts` (stores Markdown verbatim, no punctuation normalisation) and `packages/core/src/search/terms.ts` (tokenizes the query string, not stored text) found nothing that could touch a stored apostrophe either. The symptom may have come from an older SQLite build, a different tokenizer configuration, or a one-off rendering glitch that has since been overtaken by other changes; nothing in the current code path reproduces it.
3. **Fix.** No code change, because no fault was found to fix. Added a regression test, `packages/adapter-sqlite/test/search-index.test.ts` ("keeps a straight or curly apostrophe in a snippet"), asserting a snippet built from text with each apostrophe form keeps it, so a future regression here is caught immediately instead of relying on a bug report to notice.
4. **Lesson.** A spec item written as "the cause is not established" is a hypothesis, not a confirmed bug, and confirming or ruling it out is itself the deliverable even when the answer is "it does not reproduce." Recording that finding with what was checked, rather than either guessing at a fix or leaving the item open, turns an unreproducible report into a permanent test instead of a recurring question.

### A misspelled filter field returned "no rows" instead of an error

1. **What happened.** `cairn rows <table> --where "nosuch eq 1"` printed "no rows" for a table that had rows, with no hint that `nosuch` was not a real field. The same silent miss existed over REST and MCP: any typo in a `where` or `sort` field name simply matched nothing rather than being refused.
2. **Cause.** `matchesCondition` in `packages/core/src/query/filter.ts` reads a row's field with `row.values[condition.field] ?? null`. That expression cannot tell the difference between "this field does not exist on the table" and "this field exists and is null on every row." Both read as `null` and both compare as not-matching. Nothing upstream validated `where`/`sort` field names against the table's schema before filtering ran, unlike `upsertRow`, which already validates a row's values against the schema before writing.
3. **Fix.** Added `validateQuery(table, query)` to `packages/core/src/query/validate.ts`, following the exact wording `validateRow` already uses for an unknown value field (`"unknown field. known fields: ..."`), and called it from `TableService.queryRows` in `packages/core/src/services/tables.ts` before either the pushdown or in-memory path runs, so both are covered by one check. REST and MCP already turn a thrown `ValidationError` into a named-field error through the existing `describeError`/`toolError` machinery, and the CLI already prints named fields for `validation_failed`, so no surface-specific code was needed once the check sat in `core`. `packages/core/test/query.test.ts`, `packages/cli/test/cli.test.ts`.
4. **Lesson.** A filter or sort field is user input exactly like a row value, and deserves the same validation before it reaches evaluation logic that cannot distinguish "absent" from "unknown." When one code path (`upsertRow`) already validates against a schema and a sibling path (`queryRows`) does not, that asymmetry is worth checking for deliberately, not just when a bug report points at it.

### Requiring a field on one write broke three other layers that quietly relied on it being optional

1. **What happened.** Making `create_table`'s `change_note` required (ADR-058, decision 5) was a one-line schema change. Running the full test suite after it showed 31 failures, in three places that had nothing to do with the ADR being implemented: `cairn trust` and `cairn discover`'s embedded `POST /tables` calls, `cairn sync`'s table-sync `PUT`, and half a dozen REST and MCP tests that created or updated tables without a note.
2. **Cause.** A required field on a shared schema is a change to every caller of that schema, not just the one the ADR was about. `create_table`'s zod schema is used by the REST `POST /tables` and `PUT /tables/:cid` handlers alike, and every CLI and test code path that ever called either of them without a change note had been relying on it being optional, silently, since nothing forced them to say why. The MCP SDK made this harder to see at first: a zod validation failure on tool input returns a plain "MCP error ..." string instead of the app's normal JSON error body, which broke a test helper's `JSON.parse` call with a confusing stack trace rather than a clear assertion failure.
3. **Fix.** Fixed each call site and test in turn, re-running the affected file after each fix, then the full suite, until it was green (31 failures, then 13, then 7, then 0). `cairn trust` and `cairn discover` got literal change notes describing why the table exists; `cairn sync` reused the `note()` helper it already used for pages and rows; the REST and MCP tests each got a change note appropriate to what they were testing.
4. **Lesson.** Before tightening a schema shared across surfaces, grep for every caller first, not just the ones the current task touches: `POST /tables` and `PUT /tables/:cid` alone had four call sites outside any test file. When a required-field change is made, expect the test suite to have more failures than the one behaviour being changed, and treat every one of them as a real caller to fix, not noise to silence. And when an MCP SDK error comes back as a bare string instead of JSON, that usually means input validation rejected the call before the tool's own code ran; check the schema before the handler.

## 2026-09-16

### A flaky test was the visible end of a real bug in shutdown

1. **What happened.** CI failed on macOS only, on a commit that touched nothing but the CLI, having passed on Linux, Windows and locally. The failing assertion was in `shutdown.test.ts`: a step with no budget left should be skipped and named, and instead it had run. The log showed why. The hanging step reported running out of time "after 0s", and then the next step ran and finished "in 0ms", with the whole shutdown taking 149ms of a 150ms budget. The test had been passing by about one millisecond everywhere else.
2. **Cause.** Two things, and the second is the one that mattered. The test asserted a knife edge: whether `left()` is zero or one after a step consumes its timeout is a rounding question, so the test was a coin toss weighted heavily enough to look green. Underneath it, the step loop gave each step the entire remaining budget, so a step that hangs starves every step after it. That is the failure ADR-048 exists to prevent, written into the same file one phase earlier: the drain phase caps itself at half the budget precisely so a stuck request cannot spend the time that closing the database needs. The step loop did not follow its own rule, and backing up is exactly the kind of step that hangs, because it uploads to blob storage. A stuck backup could have left the database open to be killed mid-write, which is the 2026-09-15 outage.
3. **Fix.** Each step gets an equal share of what is left, recomputed from the clock on every pass, so a step that finishes early gives its share back and one that hangs is bounded. The test now asserts that a hanging step is named and the steps after it still run, and a separate test covers the skip path with a zero budget, where it is deterministic. `packages/api/src/entry/shutdown.ts`, `packages/api/test/shutdown.test.ts`.
4. **Lesson.** A test that passes by a millisecond is not a passing test, it is a bug report waiting for a slower machine, and the slower machine is always CI. When a test fails on one platform only, the first question is what the margin was rather than what is different about that platform: here the platform was a red herring and the margin was the whole story. The deeper one is that the fix was already written down in the same file, as a comment explaining why draining is capped. A rule worth stating in a comment is worth applying everywhere it holds, and the place it was not applied is the place it was actually needed.

### Reading a line from stdin works on Node and hangs forever on Bun

1. **What happened.** Added the first question the CLI has ever asked a person, the offer of a scheduled sync when a second Cairn is registered. It was written the obvious way: write the prompt, attach a `data` listener to `process.stdin`, call `resume()`, resolve on the first chunk. The unit tests passed, because they inject the answer through `Io`. Running the built executable under a pseudo-terminal, it printed the question and never came back. The command had to be killed after two minutes.
2. **Cause.** The CLI ships as a Bun-compiled executable (ADR-014), and on Bun a `data` listener on `process.stdin` does not receive input from a pseudo-terminal. Reduced to a nine line script, the same code answers on Node and hangs on Bun, so it is the runtime and not the CLI. Hard rule 16 exists for exactly this and had been half-followed: `process` is on its list of allowed globals, so the code looked compliant, but the rule's actual requirement is the second half of the sentence, that anything outside the list is checked on both runtimes. A new use of something on the list can need checking just as much.
3. **Fix.** The prompt opens the controlling terminal directly, `/dev/tty` or `CONIN$` on Windows, through `node:fs/promises`, which hard rule 16 already allows, and reads one buffer from it. Verified on both runtimes under a pseudo-terminal, then on the real compiled binary, where the question appears, an answer of "n" is read and nothing is installed. Any failure to open the terminal is treated as nobody being there, which is a case the caller already handles. `packages/cli/src/bin.ts`.
4. **Lesson.** Two runtimes means two runtimes, and the check is cheap: a few lines in a file and one run each, against a real pty rather than a pipe, because a pipe is not a terminal and would have passed on both while proving nothing. The wider one is about where the hang would have landed. Unit tests could not catch it, because injecting the answer is exactly what removes the runtime from the picture; the smoke test could not catch it, because it never types anything; and the failure mode is a CLI that sits there forever with no output, which is the worst way for a person to meet a bug. Any new interaction between this CLI and the world outside it gets one manual run on the compiled binary before it is called done.

### pnpm smoke:cli passed against a CLI binary that did not contain the change

1. **What happened.** Added `-i` as the short form of `--instance`, then ran the checks this project asks for after a CLI change: `pnpm typecheck`, the 159 CLI tests, `pnpm build` and `pnpm smoke:cli`. All green. Running the built executable by hand straight afterwards, `./dist/cli/cairn-darwin-arm64 -i azure overview` answered "Unknown option '-i'". The check had passed on a binary compiled before the change existed.
2. **Cause.** `pnpm build` runs each package's own build and does not compile the CLI executables; that is `pnpm build:cli`, a separate script driving `scripts/build-cli.mjs`. `pnpm smoke:cli` runs whatever is already in `dist/cli`, so with a stale binary there it tests the previous version and says so in the same words it uses when it tests the new one. The smoke test was never wrong about what it ran, only silent about when that was built.
3. **Fix.** Ran `pnpm build:cli` and then the smoke test again, and confirmed the flag by hand against the deployed Cairn. Nothing in the repository changed, which is the uncomfortable part: the trap is still there for the next person.
4. **Lesson.** A check that reads a build artefact proves nothing unless the artefact was built from the code under test, and "all green" is the exact output it gives when it is not. After a CLI change, `pnpm build:cli` comes before `pnpm smoke:cli`, and the cheapest confirmation is to run the built binary once by hand on the thing that was just added. This is the third entry on this page in two days where a tool reported success for work that had not happened, after the deploy that deployed nothing and the CI that published no image. The pattern is worth naming: when a step's output cannot distinguish "did the new thing" from "did an old thing", it is not a check.

### CI was red for four commits, no container image was built, and nobody looked

1. **What happened.** Asked whether everything could be committed, pushed and deployed. The work was already pushed and the local suite was green on all 627 tests, so the answer looked like yes. `gh run list` said otherwise: CI had failed on the last four commits in a row, starting with the shutdown work and continuing through the backups, the cloud archives and the recovery ladder. Because the container image job only runs after the tests pass, no image had been published for any of them. A deploy at that moment would have rolled out the last green commit, `a528168`, and reported success.
2. **Cause.** Two Windows-only faults in test code, neither of them in the product. `shutdown-signal.test.ts` spawned the `tsx` shim from `node_modules/.bin`, which is an extensionless shell script Windows cannot execute, so the server reported as having "exited early" with no output; and even once spawned, the test asserts a tidy shutdown on SIGTERM, which Windows cannot deliver, because Node emulates `kill("SIGTERM")` there with TerminateProcess and no handler runs. `backup.test.ts` inserted 5000 rows outside a transaction, so each one committed and synced on its own: a second on an SSD, over twenty seconds on the Windows CI disk, which timed the test out and then left the database open, so the temporary folder could not be deleted and an EBUSY buried the real failure. Underneath both: three commits were pushed without once looking at what CI made of the previous one.
3. **Fix.** The SIGTERM test spawns `node --import tsx` and is scoped away from Windows with the reason written down, because the property it asserts does not exist there. The backup test wraps its inserts in one transaction and closes the store in a `finally`. `packages/api/test/shutdown-signal.test.ts`, `packages/api/test/backup.test.ts`.
4. **Lesson.** Two. First, a green local suite is evidence about one machine, and this project deliberately tests on four; "the tests pass" means nothing until the run that matters has said so, and checking takes one command. Push, then read CI before starting the next thing, because a red build compounds silently and the fourth commit inherits the blame for the first. Second, and worse, the failure was invisible in the direction that mattered: the deploy script would have found an image, deployed it happily and reported success, because it has no way of knowing that the image it deployed predates the code it was asked to ship. A pipeline where a broken build means "deploy the old thing quietly" is a pipeline that lies. This is the same shape as the deploy that deployed nothing on the same day, below: both times the tool reported success for work that had not happened.

### The recovery ladder deleted the evidence it promised to keep

1. **What happened.** The recovery ladder (ADR-051) promises that a database Cairn will not open is moved aside and kept, never deleted, because rows can still be pulled out of it by hand. A test of exactly that, a damaged local database plus a sound backup to recover from, asserted that the outcome named where the broken file had been kept and got `null`.
2. **Cause.** The keeping was written into the wrong rung. Rung 4, the backup rung, moved whatever was at the database path aside before installing the backup. But rung 3 walks back through the replica, and to do that it has to clear the path before each attempted restore, so it called `discard` on the database first. By the time rung 4 looked, the owner's damaged database had been deleted by rung 3 and there was nothing left to keep.
3. **Fix.** The file is now set aside at rung 1, the moment Cairn decides it will not use it and before any lower rung writes to that path. `discard` below that point can only ever remove fragments of the current run's own work. `packages/api/src/recovery/ladder.ts`.
4. **Lesson.** A promise about a file has to be kept at the last moment the file still exists, not at the point in the code where the promise reads well. Rungs 3 and 4 were written to be independent, and the independence was the bug: rung 3 reasonably owned the database path, rung 4 reasonably expected to find the original there, and nothing in either one said which of them was right. When several steps write to the same path, decide once, at the top, what happens to what was already there. The test that caught this asserted the consequence, where the broken file ended up, rather than the action, that `moveAside` was called; an assertion on the call would have passed against a ladder that deleted the file a step earlier.

### Three deploys in a row deployed nothing, and the script said the opposite

1. **What happened.** Recovering from the restart loop below needed a container carrying the ADR-046 fix. `deploy/azure/deploy.sh` was run three times. Each run printed "deploying (a few minutes)", then "waiting for the new version to start (the first start can take a minute)", then hung and failed with "the new version did not start. Look at its logs". The logs showed the container crash-looping on the same error as before, which read as "the fix did not work". `az containerapp revision list` showed the truth: still `cairn--0000015`, created 2026-09-15T20:38:56, before the incident. No new revision had been created by any of the three runs.
2. **Cause.** Three faults stacked. The Bicep template named the image by tag, `ghcr.io/vespassassina/cairn:latest`, and Container Apps creates a revision only when the template changes; a tag is the same string however often the image behind it moves, so identical templates were compared and nothing rolled out. The default tag was `latest`, which CI only publishes from a release tag while `main` publishes `edge` (ADR-018), so no commit on `main` could ever have reached a deploy regardless; `latest` was still v0.1.5. And the readiness loop waited for `latestReadyRevisionName` to equal `latestRevisionName`, which with no new revision meant waiting five minutes for something that would never exist, then blaming a start that was never attempted.
3. **Fix.** ADR-047. The tag is resolved to a digest before it reaches the template, so a moved tag always deploys and an unmoved one never pretends to; a run that changes nothing says "no change to deploy" and names the running image; a missing tag stops the run naming `:latest` and `:edge`; the running image and its replacement are both printed, and a running image deployed by tag is called out. `deploy/azure/deploy.sh`.
4. **Lesson.** Three, and the third is the uncomfortable one. First, a mutable tag inside a declarative template is a no-op generator: the system diffs the declaration, not the world, so the thing you changed is invisible to it. Anywhere a declarative deploy names an artefact, name it by digest, or accept that redeploying is a coin toss. Second, an error that describes the wrong failure costs more than no error at all: "the new version did not start" sent the diagnosis to the container's log, where a real and unrelated crash loop was waiting to confirm the wrong story, and it took a revision listing to notice that the version under discussion had never been created. When a wait times out, say what you were waiting for and whether it ever existed. Third, this failure was predicted in conversation before the first run, and predicting it did not prevent it: the image-tag problem was spotted and explained, the deploy was run anyway, and three runs went by before the revision list settled it. A warning in chat is not a guard in code. If a failure can be foreseen clearly enough to describe, it is worth the ten lines that make the tool itself refuse or warn, because that is the only version of the warning that is present at the moment it matters.

### The Azure Cairn was down for days in a restart loop, and nothing said so

1. **What happened.** Asked whether Cairn was connected, and found the Azure instance had been unreachable since at least the last sync on 2026-09-14. `cairn --instance azure overview` hung and then returned `error: http_504: stream timeout`. `curl` to the health endpoint timed out at 60 seconds. `az containerapp show` reported the app "Running" and its revision "Healthy" with one replica, which is what a scale-to-zero app looks like whether or not it can start. The container log held the real story: `litestream restore` failing with `decode database: decode page 1460: EOF`, then "restore attempt 1 failed; retrying in 10 seconds", over and over.
2. **Cause.** Litestream's copy of the database in Blob Storage was truncated, so no restore could ever succeed. `docker/start.sh` had one retry loop, written for the first deploy, when access to storage takes a minute to arrive while Azure grants the app's identity its role. It could not tell that kind of failure from a permanently damaged replica, so it retried twelve times over two minutes, exited, and Container Apps restarted it into the same loop. Underneath that, Litestream was pinned at 0.5.7 while upstream had reached 0.5.17, on a 0.5 line that is a rewrite and whose patch releases have carried a run of restore and corruption fixes.
3. **Fix.** ADR-046. The start script verifies the database with SQLite's `integrity_check` before serving it and refuses to replicate one that fails; a decode or corruption error now stops at the first attempt instead of being retried; the container logs `litestream ltx` and the exact recovery commands when a replica cannot be read; Litestream is now 0.5.17. The CLI stopped passing a bare gateway 504 through as `http_504`.
4. **Lesson.** Three things worth carrying. First, a retry loop is a claim that the failure is temporary, and a loop that cannot tell temporary from permanent will turn a five-second diagnosis into an invisible outage; classify the error before retrying it. Second, the health that Azure reports is the health of the container app, not of the program inside it, so "Running" and "Healthy" there proved nothing and nearly sent the diagnosis in the wrong direction; the container's own log was the only source that knew. Third, and the one that actually cost the time: by ADR-018 the storage account is reachable only by the app's managed identity, so when the replica went bad there was no way to look at it from the owner's own machine, and the process that could read it was the one crash-looping. A component that is the only thing able to read its own state has to log that state when it fails, or the failure is unreadable by anyone.

## 2026-09-15

### The first npm publish failed three times before it could actually succeed

1. **What happened.** The first CI run against a valid `NPM_TOKEN` failed with `npm error code EOTP`, "This operation requires a one-time password." After the owner replaced the token, the rerun got past that and failed differently: `npm error code E404`, "The requested resource '@cairn/cli@0.1.5' could not be found or you do not have permission to access it." After renaming the package to the unscoped `cairncli`, confirmed free on the registry beforehand, the next run failed a third way: `npm error code E403`, "Package name too similar to existing package cairn-cli."
2. **Cause.** Three separate problems, each hidden behind the last. The original token was not an npm "Automation" token, so npm demanded an interactive one-time password that CI cannot supply. Once authentication worked, npm still refused `@cairn/cli` because a scoped package's first publish requires the scope's org to already exist, and `cairn` was already taken by someone unrelated. Once renamed to unscoped `cairncli`, a plain `npm view cairncli` or a registry `GET` (both return 404 for a free name) said nothing about npm's separate publish-time similarity check, which blocks a new name that reads as a near-duplicate of an existing one, in this case `cairn-cli`. Registry existence and publish eligibility are not the same test.
3. **Fix.** The owner set a new Automation-type `NPM_TOKEN`, clearing the EOTP error. For the org conflict, renamed `@cairn/cli` to unscoped `cairncli`. For the similarity rejection, renamed again to `@vespassassina/cairncli`, the fix npm's own 403 message suggested: scoped to the owner's existing npm username, so it needs no separate org and is not subject to the same-name similarity check (docs/CHANGELOG.md, "The npm package is `@vespassassina/cairncli`").
4. **Lesson.** Confirming a candidate npm package name with `npm view` or a registry lookup only proves the exact name is unclaimed. It does not prove: the token type can publish it (Automation vs. one requiring 2FA), the scope's org exists if it is scoped, or that it clears npm's similarity check against existing names if it is not. All three surfaced only as publish-time errors from the real registry, one per attempt. When a first publish is genuinely disposable to retry, that is an acceptable way to find out; when it is gated behind a tag move the owner has to do by hand each time (as here), it is worth reading npm's own publish documentation for these failure modes before picking a name, rather than treating "the registry doesn't have it" as clearance.

### A tag was pushed before the version was set

1. **What happened.** `v0.1.5` was pushed to try the newly wired npm publish (`docs/CHANGELOG.md`, "The CLI is ready to publish to npm"). CI's `release` job refused it at its first step: "tag v0.1.5 does not match version 0.1.4 in package.json." Nothing built or published; the job failed in 5 seconds.
2. **Cause.** `git tag v0.1.5 && git push --tags` was run without `pnpm set-version 0.1.5` first. `docs/CLI.md` and this repo's own release checklist say to run it, but nothing stops a tag from being pushed without it.
3. **Fix.** `pnpm set-version 0.1.5`, which writes the version into `package.json`, `packages/cli/package.json`, `packages/cli/src/main.ts` and `packages/api/src/app.ts` together; the mismatched `v0.1.5` tag was deleted and re-pushed against the commit that carries it.
4. **Lesson.** The guard did exactly its job: it failed cheap, before the release job's later, harder-to-undo steps (npm publish has no unpublish after 72 hours). Moving a pushed tag is still a rewrite of shared state, worth naming as one before doing it, even when the fix itself is routine.

## 2026-09-14

### The MCP sign-in ended early, and the lifetimes were not the reason

1. **What happened.** The `cairn` MCP server stopped being authorized and the owner asked why, and how long a sign-in is supposed to last. The obvious reading was that something had expired.
2. **Cause.** Nothing had reached its lifetime. Refresh tokens last 30 days and rotate on every use, so a Cairn used daily never expires by time. What ends a sign-in early is a refresh token presented twice, which the server treated as a stolen token and answered by revoking the whole family. A second use is also what happens when the response was lost on the way back, when two processes refresh at once, or when the container restarted from a replica written just before the last rotation (ADR-020). The exact cause of this instance is not known, because that needs the server's logs and the `auth_records` table on Azure.
3. **Fix.** ADR-033: a used refresh token keeps answering with the tokens it was already given for 60 seconds, so a repeat is a repeat. Past the window, and for a revoked sign-in, the behaviour is unchanged.
4. **Lesson.** Two of them. First, when someone asks for a setting to be raised, check whether the setting is what is actually failing: the answer here was a design flaw, and a longer lifetime would have hidden nothing and fixed nothing. Second, a security rule that assumes the world is reliable will fire on ordinary failures, and every one of those costs a real person something. Single-use rotation assumed responses always arrive and that a replicated database never goes backwards. Neither is true.

### A published page leaked a private page's id through its description

1. **What happened.** Writing the published wiki (ADR-032), the leak test "renders a link to a private page as plain text, and does not name it" failed: the page body rendered correctly, with no link and no title, but the private page's id appeared in the `<meta name="description">` tag of the published page, where it is served to everyone and read by search engines.
2. **Cause.** The description was the page's first line of Markdown, taken as written. The careful work went into the part that was obviously dangerous, the rendered body, and the description was treated as a harmless summary. It is not: it is the same untrusted text, on the same public response, only unrendered.
3. **Fix.** `summaryOf` in `packages/api/src/web/public.tsx` now reduces every link to the words around it, wiki links and Markdown links alike, before taking a line.
4. **Lesson.** When a rule is "this text must never appear", check every field the response carries, not the one the text is normally shown in. Metadata, titles, headers and error messages are all made of the same content, and a test that asks "does this id appear anywhere in the response" catches what a test on the rendered part alone will miss.

### `cairn login` told the owner localhost needs no sign-in, when they meant Azure

1. **What happened.** Following the deploy steps, the owner ran `cairn login` to sign in to Azure and got "http://localhost:8787 does not use OAuth sign-in (HTTP 404). On localhost no sign-in is needed." They could not tell what to do next.
2. **Cause.** Without `CAIRN_URL` or `--instance`, the CLI uses localhost, and the error described localhost without saying it had been chosen by default. `docs/CLI.md` showed a bare `cairn login` for a deployed Cairn, which works only with `CAIRN_URL` already set. The same message was used for any failure, including a server elsewhere that did not answer.
3. **Fix.** `cairn login` now says when it tried localhost because nothing was named, and shows both ways to name a Cairn; other failures have their own messages. The docs show the address with the command.
4. **Lesson.** When a command acted on a default the person did not choose, the error must say it used the default and how to choose. And a command in the docs that depends on an environment variable should show it on the same line.

### Sync ordered edits by when a copy arrived, not when it was made

1. **What happened.** Designing ADR-030 showed that with three Cairns, an edit made on A before one made on C, but relayed to B after it, looked newer on B and could win when B synced with C.
2. **Cause.** `updated_at` meant two things: when this server stored a write, and when the content was edited. Sync wrote a copy through the ordinary `PUT`, which stamped the time of the copy, and then compared those times as if they were edit times. Two servers were enough to hide it, since a copy never competed with a third server's edit.
3. **Fix.** `edited_at` holds the time of the edit and travels with sync; `updated_at` keeps the time of storing (ADR-030).
4. **Lesson.** When data is copied between systems, keep the time an event happened apart from the time a copy of it was stored, and test ordering with three copies, not two.

### Three releases all said they were 0.1.0

1. **What happened.** Explaining to the owner how to keep the CLI updated showed that `cairn -V` printed `0.1.0`, although `v0.1.3` was the newest release. The server's `/health` said the same.
2. **Cause.** The version was written by hand in three places, `packages/cli/package.json`, the CLI's `VERSION` and the server's `SERVER_INFO`, and the release job built whatever they said. Tagging `v0.1.1` to `v0.1.3` changed none of them, and nothing checked.
3. **Fix.** The root `package.json` holds the version, `pnpm set-version` writes the other three, a test fails when they disagree, and the release job fails when the tag does not match.
4. **Lesson.** A number written in more than one place drifts unless something fails when it does. For anything a release stamps, check the stamp in the release job itself, not in the checklist.

### CLI tests read the owner's real sign-ins

1. **What happened.** Adding named instances meant any CLI test with no `CAIRN_URL` could route to whatever the owner had registered on this machine. Checking why showed the older tests already read `~/.config/cairn/credentials.json` when they built the CLI's environment.
2. **Cause.** `cli.test.ts` and `export.test.ts` passed an environment without `CAIRN_CREDENTIALS` or `XDG_CONFIG_HOME`, so the CLI used the default config folder, the real one. They passed only because the owner's tokens did not match the test servers' addresses.
3. **Fix.** Both set `CAIRN_CREDENTIALS` to a path that does not exist, and the new instances tests use a fresh temporary folder, as the sync tests already did.
4. **Lesson.** A CLI test builds its whole environment, config folder included. When a command gains a new file it reads by default, check every test that runs the CLI, not only the new ones.

### A shell variable holding a command does not run in zsh

1. **What happened.** Setting `c="node packages/cli/dist/bin.js"` and running `$c instances` failed with "no such file or directory".
2. **Cause.** zsh does not split an unquoted variable into words, as bash does, so it looked for a program named the whole string.
3. **Fix.** A shell function instead of a variable.
4. **Lesson.** On the owner's Mac the shell is zsh. Use a function or an alias for a command with arguments, or spell it out.

### A test assumed two writes could not share a millisecond

1. **What happened.** The history test for freshness failed every run: an edit made straight after a verification was reported as a verification too.
2. **Cause.** History tells a verifying write by its snapshot's `verified_at` being equal to the revision's time. The in-memory SQLite database finishes a write in well under a millisecond, so the edit's time equalled the carried-over verification time. No real person or agent writes that fast.
3. **Fix.** The test waits 5 ms between the two writes, with a comment saying why, and ADR-028 names the limit in its consequences.
4. **Lesson.** Any rule that compares timestamps needs a test with two writes back to back. Decide whether same-millisecond writes matter, and write the answer down, rather than finding out from a flaky test.

### The MCP instructions test reads any snake_case word as a tool name

1. **What happened.** Adding "verified_at" to the server instructions failed the test that checks every tool the instructions name exists.
2. **Cause.** The test finds tool names with a pattern for snake_case words, so a field name looks like a tool. `change_note` and `version_conflict` were already excluded for the same reason.
3. **Fix.** `verified_at` added to the test's list of words that name a field, not a tool.
4. **Lesson.** When the instructions mention a new field, add it to that list in the same change. The failure is the test doing its job, not a bug in it.

### An unquoted glob in zsh, again

1. **What happened.** `grep -rln "putPage" packages --include=*.ts` failed with "no matches found" while exploring for freshness, the same failure logged earlier the same day.
2. **Cause.** zsh expands `*.ts` itself and stops when nothing in the current folder matches, before grep runs.
3. **Fix.** Quoted the pattern: `--include="*.ts"`.
4. **Lesson.** Quote every glob meant for another program, every time. Logging a lesson did not stop the repeat; typing the quotes by habit does.

### An insertion script deleted the line it inserted before

1. **What happened.** Adding tests for sources, three CLI test files stopped parsing: "`await` is only allowed within async functions", pointing at the body of an existing test.
2. **Cause.** The agent's Python edit found an existing test's first line as an anchor and replaced it with the new test, instead of with the new test followed by the anchor. Each existing test lost its `it(...)` line, leaving its body loose inside the one before.
3. **Fix.** The three anchors put back, checked with `git diff` showing only added tests.
4. **Lesson.** When inserting before an anchor, write the replacement as `new + anchor`, and read the diff of an insertion for removed lines before running anything: an insertion should remove nothing.

### A schema error from the MCP SDK is not the tool's JSON

1. **What happened.** A test that sent a 501-character source to `create_page` failed parsing the answer: "MCP error ..." is not valid JSON.
2. **Cause.** When arguments fail a tool's zod schema, the MCP SDK answers with a plain-text error before the tool runs, so the tool's own JSON error shape never appears. The test assumed every error came from the tool.
3. **Fix.** The limit moved from the MCP schema into core, which every surface already calls, and the test reads the raw result. That also shortened the tool list every session loads.
4. **Lesson.** Errors from an MCP tool come in two shapes: the SDK's text for schema failures, and the tool's JSON for everything else. Put rules that need a helpful message in core, and keep the schema to types.

### The zsh variable mistake, again

1. **What happened.** Seeding a scratch server, `C="node packages/cli/dist/bin.js"` then `$C create ...` failed with "no such file or directory".
2. **Cause.** zsh does not split an unquoted variable into words, which the entry "zsh does not split a command held in a variable" already records. The agent did not apply it.
3. **Fix.** A shell function.
4. **Lesson.** The same as before: a function, never a variable, for a repeated command. Read this file before scripting in the shell here.

Later the same day, `grep --include=*.ts` failed with "no matches found", the empty-glob half of the same entry. Quoting the pattern fixed it.

## 2026-09-13

### A bulk rename silently did nothing, twice

1. **What happened.** Renaming "collection" to "table" across the code, the first two attempts changed nothing and reported no error worth noticing. A `sed` with `\b` word boundaries matched no line, and a `perl -pi ... $files` treated the whole list of 30 files as one file name ("File name too long").
2. **Cause.** macOS ships BSD `sed`, which has no `\b`; it takes the pattern literally and matches nothing, without complaint. And the shell is zsh, which does not split an unquoted variable into words the way bash does, so `$files` was one argument.
3. **Fix.** `perl` for every substitution, and file lists passed through `xargs`. Then `pnpm build` and `git diff --stat` to confirm the edit landed before trusting it.
4. **Lesson.** On this machine, use `perl -pi` rather than `sed -i` for anything beyond a literal, pipe file lists through `xargs`, and check a bulk edit's diff count straight after running it: a rename that changed nothing looks the same as one that worked until something reads the files.

### Titles were stored with every chunk and searched by none

1. **What happened.** A page came first for its own title in 22 of 97 searches. Nothing in the eval noticed, because its queries are phrased as questions, not names.
2. **Cause.** The chunk's heading path, which starts with the page title, was an `UNINDEXED` FTS5 column: kept for display, invisible to matching and ranking. The chunker's comment said the title leads the path "so a title-only match still has somewhere to sit", but that was only true for the empty-page fallback, which puts the title in the text.
3. **Fix.** An indexed `heading` column with a BM25 weight, and an exact-title rule (ADR-025).
4. **Lesson.** Test search with the query an agent sends most: the exact name of a thing. An eval of questions measures recall for questions only.

### Sync promised history that collections do not keep

1. **What happened.** A sync after the ADR-024 change reported two collection conflicts with "The other is in its history". Collection schemas have no history.
2. **Cause.** The report wording was written for pages and rows, which do keep every version, and collections were never checked against it. The conflicts themselves came from the sync hash of a collection gaining a field, which makes every saved hash stale once.
3. **Fix.** The report says a collection's losing schema was replaced; a test covers it.
4. **Lesson.** A promise in an output ("it is in history") is a claim about every kind of record it can print, so check each kind. And a change to what a hash covers invalidates every stored hash: say what that does on the first run after an upgrade.

### The instructions taught a link syntax the code did not read

1. **What happened.** The MCP server instructions told agents to link pages with `[[Page title]]`. The extractor only reads `[[page-id]]`, which the `create_page` tool description and the console both say. Found while answering the owner's question about how cross-linking works.
2. **Cause.** The instructions were written in plain words for readability, and "Page title" read better than "page-id". Nothing compares the instructions with the tool descriptions, and a title like `BPC-157` even matches the id pattern, so the link was stored, pointing at nothing.
3. **Fix.** The instructions now say `[[page-id]]`.
4. **Lesson.** Anything the instructions tell an agent to type is an interface. Check it against the code that reads it, the same way as a tool schema, whenever either changes.

### A shell script change reached CI unlinted

1. **What happened.** CI's shellcheck step failed on a new check in `deploy.sh`: `A && B || C`, flagged SC2015.
2. **Cause.** shellcheck is not installed on the machine the agent works on, so `bash -n` was the only local check, and it only tests syntax.
3. **Fix.** Rewritten as an `if`.
4. **Lesson.** `bash -n` is not a lint. Before pushing a shell change, run shellcheck, or say that it was not run and let CI be the check.

### The amd64 image was two and a half times the arm64 one, and nobody looked

1. **What happened.** Cold starts on Azure took 30 seconds, 19 of them pulling a 342 MB image. The arm64 build of the same commit was 137 MB.
2. **Cause.** onnxruntime-node's install script downloads NVIDIA CUDA and TensorRT libraries on Linux x64 only, from NuGet, at install time. Pruning the other platforms' folders kept the x64 one, with the GPU libraries inside. CI built and ran the image but never reported its size, and the arm64 image, which has no GPU download, hid nothing.
3. **Fix.** `ONNXRUNTIME_NODE_INSTALL=skip` in the build stage; CI fails if a CUDA or TensorRT library is in the image, and prints its size.
4. **Lesson.** Check the image size per architecture whenever a dependency with native code is added, and read what its install script downloads: a postinstall step can add hundreds of megabytes that no lockfile shows.

### A redeploy reported success while the old version was still running

1. **What happened.** After a fix, `deploy.sh` with `CAIRN_IMAGE=...:edge` said Cairn was running, but the fix was not live: the new favicon returned 404. The agent was about to re-run the import against the old code.
2. **Cause.** Two things. Container Apps creates a new revision only when the template changes, and the image name `...:edge` had not, so nothing new was pulled. And when a new revision did start, the script's health check was answered by the old one.
3. **Fix.** The image was pinned by digest to force the change. `deploy.sh` now waits until the latest revision is the ready one before checking health, and the guide says to deploy a version, not a moving tag.
4. **Lesson.** After a deploy, check that the new code is what answers, with something only the new code has, before relying on it. A health check proves something is up, not which version.

### An import failed with "database is locked" on the first slow machine

1. **What happened.** Importing the wiki into Azure stopped after 84 pages with `internal: database is locked`.
2. **Cause.** The document store and the search index each open their own connection to the same file, and neither set `busy_timeout`, so SQLite returned busy at once when the other held the write lock. The search index writes vectors in the background while pages are being written. On a laptop the writes were short enough never to collide; on 0.25 vCPU they did. The auth store had set the timeout from the start, so the pattern existed in the code and was simply not applied everywhere.
3. **Fix.** `PRAGMA busy_timeout = 5000` on both connections, and `packages/adapter-sqlite/test/busy.test.ts`, which holds the lock from another process and fails without it.
4. **Lesson.** Every connection to a shared SQLite file sets a busy timeout, and the test for concurrency uses a second process, not a second call in the same one. A setting applied in one adapter and not its siblings is worth a grep whenever one of them is fixed.

### The released image could not reach its replica, and CI could not have noticed

1. **What happened.** On the first Azure deployment, the container never became healthy. The logs showed only "restore attempt 1 failed" as Container Apps killed it. Storage metrics showed no request from the container at all.
2. **Cause.** The final image is `node:24-slim`, which has no system CA certificates. Node brings its own, so the server worked everywhere. Litestream is a Go program and uses the system's, so every HTTPS request failed with "certificate signed by unknown authority". The Azure SDK inside Litestream retries such errors with backoff for minutes, longer than the three-minute startup probe, so the error was never printed. CI starts the image without a replica, so Litestream never made a request.
3. **Fix.** The image copies `/etc/ssl/certs/ca-certificates.crt` from the Litestream build stage; CI checks the file exists. To see the error, a debug revision was given a ten-minute startup probe, after running a command inside the container was blocked by the agent's permissions.
4. **Lesson.** A path CI never runs is untested, however simple it looks: the replica path had never been exercised until a real deployment. When a base image is "slim", check what else in the image needs from the system (certificates, time zones, locales), not only the main program. And when a startup probe kills a container before it logs anything, lengthen the probe before guessing.

### A default region refused new subscriptions

1. **What happened.** The first deploy pass failed: West Europe was "not accepting new customers". Rerunning in Sweden Central then failed as well, because the resource group from the refused run already existed in West Europe.
2. **Cause.** Azure closes some regions to new subscriptions when capacity is short, and the default was chosen without checking that. `az group create` refuses to move an existing group to another region.
3. **Fix.** The empty group was deleted and the deploy rerun in Sweden Central, the owner's choice. `deploy.sh` now defaults to `swedencentral` and reuses an existing group. `az deployment group validate` checks a region in seconds, and does catch the refusal.
4. **Lesson.** Validate a region before the first deployment in a new subscription; a refusal costs minutes and leaves a group behind.

### The first release went out with no description, and its tag push was blocked

1. **What happened.** `v0.1.0` built and published every file, but the GitHub release had an empty description. Earlier, the agent's push of the tag was blocked by its permissions.
2. **Cause.** The release job in `ci.yml` attaches files and sets no body. Pushing a tag publishes a release, which the agent's permissions treat as outward-facing, like the pull request merge before it.
3. **Fix.** Notes written and added with `gh release edit` after the run. The owner pushed the tag.
4. **Lesson.** Draft the release notes before tagging, and expect the owner to push the tag: give them the two commands, and verify the run once the tag is on GitHub.

### `cairn --version` fails with a confusing error

1. **What happened.** Checking the released executable with `cairn --version` printed "Option '--version <value>' argument missing".
2. **Cause.** `--version` is the page version token on write commands (`--version V`), so the CLI's own version is `cairn version` or `-V`. The agent guessed the conventional flag without reading `--help`.
3. **Fix.** None yet in the CLI; `cairn version` printed `cairn 0.1.0`. Making a bare `--version` with no command print the CLI version is a small follow-up.
4. **Lesson.** Read `--help` before calling a flag broken. A flag name other tools use for something else will be guessed wrong by agents too, so the error should say what to use.

### The first memory measurement missed the worst case by a factor of four

1. **What happened.** The server with the embedding model measured 407 MB, comfortably inside Azure's 0.5 GiB. The bundled server started on a database with no vectors peaked at 1.3 GB and stayed there.
2. **Cause.** The first measurement was of a server with nothing to embed: the vectors had been copied with the database. The real peak comes from embedding, where ONNX Runtime pads every text in a batch to the longest, and the batch was 32.
3. **Fix.** One text per model call: 312 MB at peak for the whole wiki, and faster. The bundled server holds 347 MB with every chunk embedded. CI logs the container's memory.
4. **Lesson.** Measure the worst case, not the resting state: start from empty so the heavy work actually runs. Measure the build that ships (the bundle), not the development runner.

### A test script failed silently, twice, behind a filter

1. **What happened.** A loop comparing memory settings printed nothing useful: the first run hit the database the test server had locked, and the second passed `$cfg` as one argument.
2. **Cause.** The output was piped through `grep`, which hid the errors, and zsh does not split an unquoted variable into words, as an earlier entry here already says.
3. **Fix.** Opened the database read-only, ran each case with explicit arguments, and looked at the full output of one run first.
4. **Lesson.** Never filter the output of a script's first run. The zsh entry below applies to loops over argument lists too.

### Downloads were attempted before asking

1. **What happened.** Looking up the sqlite-vec and transformers.js packages on the npm registry was blocked by the agent's permissions.
2. **Cause.** Fetching packages and a model is a download, which needs the owner's consent with names, sources and sizes, and the agent had not asked yet.
3. **Fix.** Asked once, with the model choice and every download listed with its size, then went ahead.
4. **Lesson.** When a task needs new packages or model files, ask up front with sizes and sources, together with any other decision the owner has to make.

### The stock sqlite3 tool cannot open a database's vector table

1. **What happened.** `DROP TABLE chunk_vectors` in the `sqlite3` command-line tool failed with "no such module: vec0".
2. **Cause.** A `vec0` table needs the sqlite-vec extension loaded, which the stock tool does not do.
3. **Fix.** Documented in `docs/LOCAL.md` and ADR-022. Backups at the file level are unaffected.
4. **Lesson.** An extension's tables are invisible to tools without it. Say so wherever people are told they can inspect the file.

### The file tool turned an escape into a character again

1. **What happened.** `\u2026` in a template string was written as a literal ellipsis.
2. **Cause.** The same tool behaviour as the earlier entries.
3. **Fix.** Found by the check that the file is plain ASCII, and put back as an escape.
4. **Lesson.** Keep checking new files for non-ASCII characters straight after writing them.

## 2026-09-12

### The eval could not see the search bug it was meant to catch

1. **What happened.** Search returned unrelated pages for questions with no answer, visible in any demo, while the eval reported recall@5 of 1.00.
2. **Cause.** Recall only asks whether the right page is among the results, so returning something for every query never costs anything. The queries with no answer had no expected pages and were left unscored.
3. **Fix.** `expected: none` marks a query with no answer, scored as right only when nothing comes back (ADR-021). Six were added, some sharing words with the wiki on purpose.
4. **Lesson.** A metric that only rewards finding things will approve a search that finds everything. Measure the opposite failure too, and write the eval query that shows a bug before fixing it.

### Two plausible search fixes each broke a real query, found only by spot checks

1. **What happened.** Requiring most of a query's words lost "tanning peptide" (the page says "peptides"). The patch for that, not requiring words common across the wiki, then lost the sleep peptides for "peptides that help with sleep", because "help" became required.
2. **Cause.** No stemming, so word forms did not match; and the patch treated a rare vague word as more important than a common precise one. Separately, one page's chunks could fill all five result slots.
3. **Fix.** Porter stemming, the common-word rule removed, and one chunk per page before any second chunk (ADR-021).
4. **Lesson.** The eval was written by the same agent as the fix and passed every variant. Queries phrased another way, run before calling it done, found each regression. Keep a set of spot checks outside the eval, and remove a rule when a better fix makes it unnecessary.

### shellcheck ran for the first time in CI, and failed on a literal `$schema`

1. **What happened.** The "azure template" job failed on the first pull request: SC2016, "Expressions don't expand in single quotes", on the line of `deploy.sh` that writes the parameters file.
2. **Cause.** `$schema` there is a JSON key, meant literally, so the warning is a false positive. It failed the job because shellcheck exits non-zero even for info-level findings. shellcheck is not installed on the development machine, so the script had never been linted before the push.
3. **Fix.** A `shellcheck disable=SC2016` directive on that one line, with a comment saying why.
4. **Lesson.** A check that only CI can run is unverified until CI has run it. Say so when reporting, and lint shell scripts locally before pushing where the tool is available (`brew install shellcheck`).

### pnpm's built-in commands silently replaced two of Cairn's

1. **What happened.** `pnpm rebuild` finished quietly, but the stored search chunks still had the old heading paths. Its output mentioned esbuild's postinstall.
2. **Cause.** `rebuild` and `import` are pnpm built-ins, and a built-in wins over a package script of the same name. `pnpm rebuild` rebuilt native packages; `pnpm import` would have tried to convert an npm lockfile. Neither ever ran Cairn's code, and the docs had recommended both since the PoC.
3. **Fix.** Renamed to `pnpm reindex` and `pnpm import:markdown`, and every reference updated.
4. **Lesson.** Never name a script after a package manager's own command (`rebuild`, `import`, `install`, `add`, `update`, `link`, `pack`, `publish`). When a command's output does not mention what it should have done, check it actually ran.

### The chunker nested sibling sections on pages without an H1

1. **What happened.** Search results showed paths like "Cagrilintide > Status > Stacks" for two sections at the same level.
2. **Cause.** The heading path was cut by depth, `path.slice(0, depth - 1)`, which assumes every page starts at level 1. A page whose first heading is level 2 kept the previous sibling as a parent.
3. **Fix.** The chunker keeps a stack of open headings and closes every one at the same level or deeper. A test covers pages that start at level 2.
4. **Lesson.** The earlier fixture started with an H1, like hand-written notes; real imported pages did not. The same lesson as the repeated-title bug: test the indexer on real content.

### zsh does not split a command held in a variable, and aborts on an empty glob

1. **What happened.** Two live checks failed at once: `C="pnpm -s cairn"; $C export ...` reported "command not found: pnpm -s cairn", and a later `rm -f $S/bundle.sqlite*` with no matching file stopped the whole command chain.
2. **Cause.** The agent's shell is zsh, which does not word-split unquoted variables and treats a glob with no match as an error.
3. **Fix.** A shell function instead of a variable, and explicit file names instead of a glob.
4. **Lesson.** For agents running commands here: use functions for repeated commands, and avoid globs that may match nothing, or the checks you think ran did not.

### The file tool's escape problem came back, and the rule caught it

1. **What happened.** Writing the export format module, a regex with `\u0300-\u036f` was saved as raw combining characters, as in the two entries below.
2. **Cause.** The same tool behaviour.
3. **Fix.** Checked straight after writing, as hard rule 17 asks, and replaced with the Unicode property escape `\p{M}`, which needs no escape codes.
4. **Lesson.** Prefer `\p{...}` property escapes to `\u` ranges in regexes an agent writes, and keep checking new files for raw control or combining characters.

### The Windows smoke test passed, then failed deleting its own temporary folder

1. **What happened.** On the first CI run, the Windows job passed the whole test suite and every smoke test check, then failed with `EPERM, Permission denied` on the temporary data folder.
2. **Cause.** The script called `server.kill()` and deleted the folder straight away. `kill()` only sends a signal; the server had not exited yet and still held its SQLite database open, and Windows refuses to delete an open file. macOS and Linux allow it, so it passed there.
3. **Fix.** The script now waits for the server's `exit` event, deletes with retries, and only warns if cleanup still fails, since cleanup is not what the test checks.
4. **Lesson.** On Windows, wait for a process to exit before deleting files it used. Keep cleanup failures from masking the result of the thing actually under test.

### A mounted Hono app's not-found handler never ran

1. **What happened.** An unknown REST path such as `/api/v1/nothing-here` returned the console's HTML 404 instead of the API's JSON error.
2. **Cause.** The REST routes are a separate Hono app mounted with `app.route`. Hono calls the parent app's not-found handler, not the mounted one's, so `api.notFound(...)` was dead code.
3. **Fix.** A catch-all `api.all("*")` registered last in the REST routes returns the JSON 404.
4. **Lesson.** In Hono, a sub-app's `onError` does apply when mounted, but its `notFound` does not. Test an unknown path on every mounted app.

### A test assumed an order that two writes in one millisecond do not have

1. **What happened.** The changes feed test failed about one run in five: the newest change was sometimes "Owner note" instead of "Second agent page".
2. **Cause.** The two writes landed in the same millisecond. Revisions are ordered by time, then by version id, and version ids are random, so ties come out in any order. The feed was right; the test's expectation was wrong.
3. **Fix.** The test checks that times never increase and which changes are present, not which one is first. It then passed 15 runs in a row. ADR-013 now says same-millisecond changes have no defined order.
4. **Lesson.** Timestamps tie in tests that write quickly. Never assert an order between records written back to back unless the store defines one; run a new ordering test several times before trusting it.

### A raw NUL byte hid a source file from git and grep

1. **What happened.** Checking line endings for Windows, `git ls-files --eol` listed `packages/core/src/services/pages.ts` as binary. Earlier, a plain `grep` on the same file had returned nothing, which went unexplained at the time.
2. **Cause.** The file compared tag lists with `join` on a NUL character, and the NUL was in the source as a raw byte. It came from the same tool behaviour as the entry below: an escape the agent wrote was saved as the character itself. Git and grep treat any file with a NUL as binary.
3. **Fix.** The comparison uses `JSON.stringify` instead. A scan of every file in the repository found no other control bytes, and `.gitattributes` now declares text files.
4. **Lesson.** An unexplained empty grep is a clue, not noise. After an agent writes source with escapes, scan for control bytes; CLAUDE.md hard rule 17 now forbids them.

### Unicode escapes written by the agent's file tool became raw characters

1. **What happened.** The new summary module failed to compile with "Unterminated regular expression literal", and every test file that imported it failed too.
2. **Cause.** The agent wrote a regex containing `\u2028` and similar escapes. The file-writing tool decoded them into the raw characters, and a raw line separator inside a regex literal ends the line. The shell tool refuses such characters outright, so a scripted fix was blocked as well.
3. **Fix.** The check became a small function comparing code points, with no escapes in the source. The test builds its input with `String.fromCharCode`.
4. **Lesson.** When an agent writes source code, avoid `\u` escapes for control or separator characters. Compare code points in code instead. Typecheck straight after writing a new file.

### `pnpm dev` failed with EADDRINUSE while the console looked fine

1. **What happened.** The owner ran `pnpm dev` and got a Node stack trace ending in `listen EADDRINUSE 127.0.0.1:8787`.
2. **Cause.** The agent had started its own copy of the server in the app's browser pane, and it was still holding the port. The raw stack trace did not say that, or what to do.
3. **Fix.** The agent's copy was stopped. `entry/node.ts` now catches EADDRINUSE and prints what it means and three ways out: check `/health`, find the process with `lsof`, or change the port.
4. **Lesson.** A server started by an agent is shared state on the owner's machine. Stop it when handing over, and say so. Errors people will actually hit need a message that names the next step.

### Killing the dev server by process name did not work, twice

1. **What happened.** `pkill -f "tsx src/entry/node.ts"` matched nothing and the server kept running.
2. **Cause.** tsx does not appear in the process table under that name. It runs as `node --require .../preflight.cjs --import .../loader.mjs src/entry/node.ts`.
3. **Fix.** Find the process by the port it holds: `lsof -nP -t -iTCP:8787 -sTCP:LISTEN`, then kill that PID.
4. **Lesson.** Find servers by port, not by command line. After killing, check that the port is actually free.

### The server answered on 127.0.0.1 but not on ::1

1. **What happened.** A probe to `http://[::1]:8787/mcp` got no answer while `localhost` and `127.0.0.1` worked.
2. **Cause.** The server bound only 127.0.0.1. `localhost` resolves to either address depending on the client, so an MCP client that tries IPv6 first would fail with no useful error.
3. **Fix.** The default now binds both 127.0.0.1 and ::1. The IPv6 bind is optional and is skipped on a machine without it. The startup banner lists what was bound.
4. **Lesson.** "Listening on localhost" means both loopback addresses. Probe each one when checking a local server.

### An MCP server added mid-session showed no tools

1. **What happened.** After `claude mcp add`, the owner's Claude session showed no Cairn tools, while `claude mcp list` reported it connected.
2. **Cause.** Claude Code loads MCP servers when a session starts. A server added later appears only in new sessions.
3. **Fix.** Documented in `docs/LOCAL.md`: start a new session after adding the server, and use `--scope user` so it is available in every project.
4. **Lesson.** Separate "is the server reachable" (`claude mcp list`, `curl`) from "does this session have it" (only new sessions do).

### The launcher in the desktop app never started the server

1. **What happened.** The console at localhost did not load. The launch log showed `shell-init: getcwd ... Operation not permitted`.
2. **Cause.** The launch config ran `bash -c` from a working directory it could not read, relied on `$PWD`, and relied on a pnpm installed by nvm. A non-interactive shell does not load nvm, so pnpm was not on the PATH.
3. **Fix.** `.claude/launch.json` uses absolute paths and exports PATH. It stays untracked because the paths are specific to one machine.
4. **Lesson.** Launch configs must not depend on an interactive shell's setup. Use absolute paths, set PATH explicitly, and check the log rather than the page.

### A relative database path moved with the start directory

1. **What happened.** Started through `pnpm dev`, the server opened an empty database under `packages/api` instead of the seeded one at the repo root.
2. **Cause.** `pnpm --filter` runs the script from the package directory, and `./cairn.sqlite` was resolved against the working directory.
3. **Fix.** A relative path in `cairn.config.json` is resolved against the config file (ADR-010).
4. **Lesson.** Resolve paths against a fixed anchor, never the working directory, when a monorepo tool decides where commands run.

### A dev token on localhost made a working console look broken

1. **What happened.** The console redirected to a sign-in form that needed a token the owner did not have to hand. It read as "not working".
2. **Cause.** A design choice, not a bug. The token protected little on a loopback-only server.
3. **Fix.** No sign-in for trusted local requests, with DNS rebinding and cross-site requests still blocked (ADR-010).
4. **Lesson.** Friction in the first minute reads as breakage. Make the local path zero-step, and put the security effort where the threat actually is.

### The console could not be checked visually for a while

1. **What happened.** The browser pane could not screenshot `file://` pages or reach a second server, and no headless Chrome was installed. The console shipped with its visual check marked as not done.
2. **Cause.** The verification path was not planned before the UI was built.
3. **Fix.** The check was done once ADR-010 let the pane open the console with no token. Recorded in the changelog as verified.
4. **Lesson.** Decide how a UI will be looked at before building it. Until then, say plainly that it has not been looked at, which the changelog did.

## 2026-09-11

### Heading paths repeated the page title

1. **What happened.** Search results showed paths like `BPC-157 > BPC-157 > Dosing`.
2. **Cause.** Imported Markdown starts with an H1 equal to the page title, and the chunker added both.
3. **Fix.** The chunker skips the first H1 when it matches the title.
4. **Lesson.** Test the indexer on real imported content, not only on hand-written fixtures.

### Regex rewrites across the code broke SQL, then missed calls

1. **What happened.** Twice. On 2026-09-11 a scripted find-and-replace that added type casts broke several SQL statements in the SQLite adapter. On 2026-09-12 another, adding a new argument to every store write, missed the calls in the conformance suite that were chained onto a new line.
2. **Cause.** A regex cannot tell a call site from similar text inside a SQL string, and a single-line pattern cannot see a call split across lines. This was the agent's mistake.
3. **Fix.** The damaged statements and the missed calls were fixed by hand, and the type checker and tests confirmed every call site.
4. **Lesson.** Change signatures by editing call sites deliberately and letting the type checker list them. Never bulk-rewrite code with a regex, and run the tests straight after any mechanical change.

### Node's type stripping could not run the scripts

1. **What happened.** `node src/entry/node.ts` failed to resolve imports of `./x.js`.
2. **Cause.** Node's built-in type stripping runs `.ts` files but does not map a `.js` import to the `.ts` file beside it, which the TypeScript source uses everywhere.
3. **Fix.** The scripts run with tsx.
4. **Lesson.** Node's type stripping is not a TypeScript runtime. Use it only for code written for it.

### `exactOptionalPropertyTypes` rejected explicit undefined

1. **What happened.** Type errors when passing `sessionIdGenerator: undefined` to the MCP transport, and when forwarding optional fields from zod-parsed tool input.
2. **Cause.** With `exactOptionalPropertyTypes`, an optional property may be missing but may not be set to `undefined`.
3. **Fix.** Omit the key instead of setting it to undefined, and map undefined values out before passing input on.
4. **Lesson.** Under this flag, build option objects by adding keys, not by listing every key with a possibly undefined value.

### Vite 5 could not resolve `node:sqlite`

1. **What happened.** Tests failed to import `node:sqlite`.
2. **Cause.** Vite 5's list of Node built-ins predates `node:sqlite`.
3. **Fix.** Upgraded to vitest 5 and vite 8.
4. **Lesson.** When a design leans on a new Node built-in, check that the test tooling knows about it before writing code against it.
