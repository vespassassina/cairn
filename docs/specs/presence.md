# Spec: presence

ADR-053. Written 2026-09-16, after a review found that on the owner's own machine nothing could reach Cairn: the server was down, no MCP server was registered, the sign-in had been deleted, no job was installed, and the last write was two days old.

## Goal

Make Cairn reachable and known without anybody having to remember it, so that the Phase 1 gate measures whether Cairn is useful rather than whether it happened to be switched on.

## Success test

On a machine where `cairn hook install` has been run and a pair of Cairns is registered with a schedule, close the laptop overnight, open a new Claude Code session the next morning, and ask a question the workspace can answer. The agent reaches for Cairn without being told Cairn exists, and `cairn status` reports every line green without any command having been run in between.

## Scope

1. `cairn hook install`, `cairn hook status`, `cairn hook uninstall`.
2. The scheduled job runs `cairn start` instead of `cairn sync`.
3. `cairn status`.
4. The two agent guides point at `cairn status` first.

## Non-goals

1. A daemon, a login item, or anything that runs without the person having installed it in that moment.
2. Injecting anything into a session other than the bounded overview the hook prints.
3. A per-project variant of the hook. ADR-053 consequence 6 leaves that open.
4. Anything to do with why the sign-in disappears. That is `sign-in-resilience.md`.

## Constraints

1. Hard rule 15: the CLI talks HTTP only and never opens the database.
2. Hard rule 16: only the listed Node built-ins, and `pnpm smoke:cli` must pass on Node and Bun. `node:child_process` is already allowed and is what `cairn start` uses.
3. Hard rule 19: every new command and setting is documented in the person's guide and in `docs/AGENT-OPERATE.md` in the same commit, or `packages/cli/test/agent-guides.test.ts` fails.
4. Hard rule 14: `status` and `hook` are CLI-only by nature, because they describe and change the state of this machine rather than the state of a Cairn. Both go in the parity allow list of ADR-058 decision 6, each naming this spec.
5. Coding style rule 1: every line `cairn status` prints that reports a problem carries the command that fixes it.

## Design

### `cairn hook install`

New command in `packages/cli/src/main.ts`, with its logic in a new `packages/cli/src/hook.ts` so it can be tested without the argument parsing.

It reads the Claude Code user settings file, `~/.claude/settings.json` on macOS and Linux and `%USERPROFILE%\.claude\settings.json` on Windows, and adds a SessionStart hook entry that runs `cairn overview --brief`. The entry is tagged so it can be found again, and the tag is what `status` and `uninstall` match on rather than the command string, which a person may edit.

Before writing, it prints the file it will change and the exact JSON it will add, and asks for a yes. This is the shape `cairn sync install` already uses, and that code is the model to follow. `--yes` skips the question for an unattended install.

When the settings file does not exist, it is created with only this hook in it. When it exists and cannot be parsed, nothing is written and the error says which file is malformed and that the person should fix or move it.

`cairn hook status` prints installed or not installed, the command it will run, and the settings file it looked in. `cairn hook uninstall` removes the tagged entry and says so, and says so too when there was nothing to remove.

### `cairn overview --brief`

The existing `overview` gains a `--brief` flag that bounds its output to roughly 200 tokens: the instance that answered, the page and table counts, the collections by name with their page counts, and the most recent three changes. It exits zero when Cairn cannot be reached, printing one line naming the instance, the address, and `cairn start`.

The 200 token bound is enforced by a test against a generated workspace of 100 pages and 12 collections, measured the way `pnpm context-cost` measures.

### The scheduled job

`packages/cli/src/sync-install.ts`, or wherever the launchd plist, systemd unit and Task Scheduler XML are generated, changes the command from `cairn sync` to `cairn start`. `cairn start` already checks whether the first instance is answering, starts it from the registered `--start` command when it is not, waits for it, and then syncs every instance. No new code is needed in `start` itself.

A person who already has a job installed keeps the old command until they reinstall. `cairn status` notices a job whose command is `cairn sync` and says to run `cairn sync install` again, with that reason.

### `cairn status`

New command, its logic in a new `packages/cli/src/status.ts`. It prints one line per fact, each marked ok or not, and every line that is not ok carries the command that fixes it.

1. Which instance answered, its name and address, and its version. Not ok: not answering, followed by `cairn start`.
2. Signed in or not, and when the access token expires. Not ok: `cairn login --instance <name>`.
3. When the last sync ran and in which direction. Not ok when it is older than twice the installed interval.
4. Embeddings pending, from the existing health or overview endpoint. Not ok when the number is not falling between two runs.
5. The scheduled job: installed or not, its interval, and its command.
6. The session hook: installed or not.
7. The database: its size and when it was last backed up, from the health endpoint.

`--json` prints the same facts as one object, for an agent, with stable field names per coding style rule 4.

Nothing in `status` opens the database or reads a secret. Line 2 reports the expiry recorded in the credentials file and never the token.

## Acceptance criteria

1. `cairn hook install` on a machine with no `~/.claude/settings.json` creates one containing only the tagged hook, after printing what it will write and being told yes.
2. `cairn hook install` on a machine with an existing settings file adds the entry and leaves every other key byte-identical. A test asserts this by comparing the parsed object minus the hooks key.
3. Running `cairn hook install` twice does not add a second entry, and says the hook is already installed.
4. `cairn hook uninstall` removes it and leaves the rest of the file unchanged.
5. `cairn overview --brief` against a generated 100 page workspace stays within 200 tokens and names at least three collections.
6. `cairn overview --brief` against an unreachable Cairn exits zero, prints one line, and that line contains `cairn start`.
7. A freshly installed job on each of launchd, systemd and Task Scheduler contains `cairn start`, asserted against the generated file.
8. `cairn status` on a healthy machine prints every line ok and exits zero.
9. `cairn status` with the server stopped, the sign-in missing, and no job installed prints three not-ok lines, each containing a runnable command, and exits non-zero.
10. `cairn status --json` emits every field named in the design, and a test asserts the field names so they stay stable.
11. `cairn status` never prints a token, a secret, or the contents of the credentials file.
12. `pnpm smoke:cli` passes on Node and on the compiled Bun executable.
13. `docs/AGENT-OPERATE.md` and the person's guide both open troubleshooting with `cairn status`, and `packages/cli/test/agent-guides.test.ts` passes.

## Risks and open questions

1. The Claude Code settings format is outside this project's control. The installer must tolerate keys it does not know, never rewrite the file wholesale, and fail loudly rather than guess when it cannot parse it. Criterion 2 is the guard.
2. Writing into a file Cairn does not own is the largest new reach in this work. Printing the exact change and asking first is the whole mitigation, and `--yes` exists for unattended installs, which is where it could be abused. `--yes` is documented as such.
3. The hook fires in every project, including ones with nothing to do with Cairn. If that turns out to be noise, the per-project variant in ADR-053 consequence 6 is the answer, and it needs its own ADR.
4. Open: whether `cairn status` should also report whether the MCP server is registered with Claude Code. It is the one item from the review that `status` cannot see, because the registration lives in a config the CLI does not read today. Left out of this spec deliberately; if it is added it belongs with the hook code, which already reads that directory.
