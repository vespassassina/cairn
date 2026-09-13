# Failures and lessons learned

What broke, why, how it was fixed, and what to do differently. Newest first.

This log holds failures: bugs, broken tooling, wrong assumptions, and mistakes made while building, including the agent's own. Findings that shaped a decision, such as a spike result, go in `docs/CHANGELOG.md` and the ADR they support. A failure that led to a decision gets an entry here and a link to the ADR.

Each entry answers four questions:

1. **What happened.** The symptom, as it was seen.
2. **Cause.** The real reason, not the first guess.
3. **Fix.** What changed, with the commit or file.
4. **Lesson.** What to do differently next time. This is the part worth reading.

## 2026-09-13

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
