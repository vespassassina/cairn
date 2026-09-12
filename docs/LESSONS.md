# Failures and lessons learned

What broke, why, how it was fixed, and what to do differently. Newest first.

This log holds failures: bugs, broken tooling, wrong assumptions, and mistakes made while building, including the agent's own. Findings that shaped a decision, such as a spike result, go in `docs/CHANGELOG.md` and the ADR they support. A failure that led to a decision gets an entry here and a link to the ADR.

Each entry answers four questions:

1. **What happened.** The symptom, as it was seen.
2. **Cause.** The real reason, not the first guess.
3. **Fix.** What changed, with the commit or file.
4. **Lesson.** What to do differently next time. This is the part worth reading.

## 2026-09-12

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
