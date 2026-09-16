# Spec: sign-in resilience

ADR-054, which amends ADR-033. Written 2026-09-16, after the owner's stored Azure sign-in was found deleted with 28 days left on its refresh token and nothing revoked.

## Goal

A sign-in is lost only when the server says the grant is invalid. Neither a race between two `cairn` processes nor a slow or unreachable server costs the person their credentials.

## Success test

Start twenty `cairn` commands at once against a Cairn whose access token is about to expire, on a container that has just cold started. Every command succeeds, and the credentials file afterwards holds a working sign-in.

## Scope

1. The refresh branch of `packages/api/src/oauth/server.ts`.
2. `storedToken` and `writeCredentials` in `packages/cli/src/login.ts`.
3. The error text the CLI prints when a refresh fails for a reason that is not `invalid_grant`.

## Non-goals

1. Changing the access token lifetime. ADR-033 decision 5 and ADR-054 decision 7 both keep it at one hour.
2. A lock file around the credentials file. ADR-054 consequence 5 leaves that open.
3. Anything about why the server was unreachable in the first place.

## Constraints

1. ADR-005 rule 3, restated as hard rule 10: no transactions across documents. The auth store offers `getAuth`, `putAuth` and `takeAuth`, and `takeAuth` is the only atomic operation. The design must work with those three.
2. Hard rule 16: the CLI's Node built-ins. Nothing new is needed.
3. ADR-033 decisions 1, 2, 3 and 5 are unchanged. Decision 4 is restated as an outcome by ADR-054 decision 3.

## Design

### Server: wait for the answer another request is writing

In the `refresh_token` branch, the block that runs when `takeAuth` returns nothing currently reads the replay record once, then the used record, then fails. It gains one step between them.

When the replay record is absent and the used record is absent, poll for the replay record until it appears or one second has passed, then decide. A constant `REFRESH_RACE_WAIT_MS = 1000` sits beside the existing token lifetime constants at the top of the file, with a comment saying what it covers: the window between `takeAuth` deleting the grant and the winning request writing the replay record, which includes the store write inside `issueTokens`.

The poll interval is 25 milliseconds. The wait is skipped entirely when a used record exists, because that is a genuine second use past the grace window and must be refused at once, and when the family is revoked.

The comment above the replay write is corrected. It currently claims the replay record is written first, which is true only relative to the used record and is the sentence that hid this defect. It is replaced with one that says the replay record is written after the tokens exist, that the gap is covered by the wait above, and that ADR-054 explains why.

`issueTokens` is left alone. Narrowing the window is not the fix, because the window can never be closed with the primitives available.

### Client: forget only on invalid_grant

`storedToken` currently wraps the whole refresh in a `try` whose `catch` deletes the server's credentials. That becomes three cases.

1. A response arrived and parsed, and its OAuth error is `invalid_grant`. The credentials for that server are removed and the caller is told to sign in again, with the exact command including the instance name.
2. A response arrived and parsed with any other status or error. The credentials are kept. The error names the status and what the server said, and says the sign-in was kept.
3. Nothing arrived, or what arrived could not be parsed: a timeout, a connection failure, an HTML proxy page. The credentials are kept. The error says the server could not be reached, names the instance and address, gives the timeout that was used, and says to try again or run `cairn status`.

The refresh request gets its own timeout of 30 seconds, larger than the roughly 25 second Azure cold start, via `AbortSignal.timeout`, with one retry on a connection-level failure. The timeout is stated in the message when it is hit, per coding style rule 1.

### Client: never overwrite credentials you have not just read

`writeCredentials` takes the server key and the entry rather than the whole file. It re-reads the file from disk, replaces or removes only that one server's entry, and writes the result. A process that has been asleep for 30 seconds can then no longer erase an entry another process wrote while it slept.

## Acceptance criteria

1. A test drives two refresh requests with the same token concurrently, through an auth store whose `putAuth` is delayed by 200 milliseconds, and asserts both get 200 and the same tokens.
2. The same test with the delay raised past the wait asserts the second request fails, so the bound is proven to be a bound and not an unlimited wait.
3. A refresh presenting a token that was never issued is refused within the wait and not before it, and no store write happens for it.
4. A refresh presenting a token with a used record past the grace window is refused immediately, with no wait, and revokes the family. This is ADR-033's theft case and must not be slowed or weakened.
5. A refresh against a revoked family is refused immediately.
6. The CLI deletes credentials when the server answers `invalid_grant`, and the message names the login command with the instance.
7. The CLI keeps credentials on a timeout, on a connection refusal, on a 500, and on a body that is not JSON. Four tests, one each, and each asserts the credentials file is unchanged byte for byte.
8. Each of those four messages names the instance, the address, and a next step. The messages are asserted in the tests, per coding style rule 5.
9. A test writes an entry for server A, then has a stale in-memory copy write an entry for server B, and asserts both entries survive.
10. `pnpm test` and `pnpm smoke:cli` pass, and the OAuth end-to-end tests still pass unchanged.

## Risks and open questions

1. The one second wait is a constant chosen to be comfortably larger than the window it covers on a cold container. If a Litestream write is ever slower than that, the defect returns narrowed. Criteria 1 and 2 exercise the bound rather than assume it.
2. Holding a failing request for up to a second is a small denial-of-service lever. It is bounded, it costs no store write, and it applies only to a request that is about to fail. Accepted.
3. The wait makes a wrong token take a second to be refused, which is a brake on guessing rather than a cost. Noted so nobody later removes it as a performance problem.
4. Open: the credentials file still has no lock, and criterion 9 narrows the damage rather than removing it. A lock file is the next step if two processes are ever observed losing an entry.
