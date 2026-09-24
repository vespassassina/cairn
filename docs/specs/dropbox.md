# Spec: the dropbox

The owner's direction of 2026-09-24: a place to upload and write notes and files that an agent later processes and incorporates, reachable by agents without the CLI or MCP but with auth. ADR to write on agreement: ADR-079.

## Goal

Anything the owner has in hand, a thought, a photo, a PDF, a link, lands in Cairn in under two seconds from a phone, a browser, a shell or a script, and an agent can find it, file it into the wiki and mark it done.

## Success test

From a phone, share a photo and two words to Cairn: it appears under Inbox within seconds, with the photo attached. Run `curl -H "Authorization: Bearer <drop token>" -F text="call Anna re: NAS" https://cairn.example/api/v1/drops`: same. Start Claude Code: the workspace summary says "3 drops waiting"; the agent reads them, appends the note to the right page, moves the drop under that page, and the Inbox is empty.

## Scope

1. A well-known root collection, `Inbox`, created on first use (the ADR-075 pattern).
2. `POST /api/v1/drops`: multipart or JSON, text plus files, one page per drop.
3. Drop tokens: named, revocable, scoped to that one endpoint.
4. Console: `/inbox` list with file-away actions; drop-token management; an Inbox count on the home page.
5. CLI: `cairn drop`, `cairn drops`, `cairn drop-token create|list|revoke`.
6. MCP: the summary counts waiting drops; the instructions and skill say how to process one. No new tool: `list_children`, `get_page`, `move`, `update_page` and `delete_page` already do the work.

## Non-goals

1. No email-to-Cairn. It needs an inbound mail provider outside the container.
2. No OCR, transcription or summarising on the server. The agent does that when it processes the drop, with whatever it can read.
3. No processing state field. A drop is unprocessed while it sits under Inbox; filing it means moving it under the page it belongs to (its history keeps the fact that it was a drop) or deleting it.
4. No drop from anonymous callers. Every drop is authenticated.

## Constraints

Hard rules 14 (every surface), 15 (the CLI talks HTTP), 16 (CLI builtins only), 18 (tokens are secrets: hashed at rest, shown once), 19 (`docs/AGENT-OPERATE.md` and the person's guide in the same commit). ADR-064 for files (attachments need `CAIRN_ATTACHMENTS_TO`). ADR-066's publish tokens as the pattern for drop tokens. ADR-017: on a non-loopback bind, a drop token is the only way in without OAuth, so its scope must be tight.

## Design

### The Inbox

`INBOX_COLLECTION_NAME = "Inbox"` in `packages/api/src/templates.ts` beside Templates and Daily notes. A drop is an ordinary page under it:

1. Title: the `title` field if given; else the first line of `text`, cut at 80 characters; else the first filename; else the timestamp `2026-09-24 19:31`.
2. Body: `text` as given. Files are appended as `attachment:<id>` links, images as image links, one per line, after a blank line.
3. Tags: those given plus `drop`. Sources: the `url` field if given (a browser share of a link).
4. Actor: the person for session and drop tokens (the token's name is recorded in the revision note, `Dropped via token "phone"`), the OAuth subject otherwise. An agent using a drop token is recorded as that token, not as a person: open question 1.

### The endpoint

`POST /api/v1/drops`, `multipart/form-data` or `application/json`. Fields: `text`, `title`, `tags` (comma list), `url`, `files[]`. Returns `201` with the page id, title and the console link. Files go through the existing attachment path (ADR-064) but the server does the upload on the caller's behalf, since a share sheet or a `curl` cannot run the three-step signed-URL dance. Limits: 25 MB per file, 10 files per drop, 64 KB of text. With attachments off, a drop with files fails with `attachments_off` naming `CAIRN_ATTACHMENTS_TO`; a text-only drop always works.

The console's `/inbox/new` and the mobile app's `/m` post to the same operation, `createDrop` in `operations.ts`.

### Drop tokens

Same shape as `publish-tokens.ts`: a well-known table `Drop tokens` with `name`, `description`, `token_hash`, `created_at`, `last_used_at`, `revoked_at`. The token string is `cairn_drop_` plus 32 random bytes base64url, shown once. Accepted only on `POST /api/v1/drops`; any other route with a drop token answers `403 drop_token_scope` saying what the token is for. Created and revoked in the console at `/settings/drop-tokens` and with `cairn drop-token create <name>`. `last_used_at` updates on each use so a leaked token shows up.

### Console

`/inbox`: every page under Inbox, newest first, with its text's first lines, thumbnails for images, file names, and a file-away form per row: a page picker (search field posting to `/p/:id/move`) and a delete button. The home page shows "N drops waiting" linking here. `/inbox/new` is the desktop capture form (textarea, files, tags).

### CLI

`cairn drop "text" [--title T] [--tag t]... [--file path]... [--url U]` and `cairn drops` (the list, with ids). `cairn drop-token create|list|revoke`. Files are read with `node:fs/promises` and sent as multipart with `fetch`, inside hard rule 16.

### Agents

The summary line: `Inbox: 3 drops waiting`. The instructions and skill add one paragraph: process a drop by reading it, searching for where it belongs, appending or creating with a change note that names the drop, then `move` the drop under that page (or `delete_page` if fully absorbed). Never leave a drop under Inbox after using it. An agent with only a drop token (no MCP, no CLI) can still write into the Inbox from a script; that is the point of the token.

## Acceptance criteria

1. `POST /api/v1/drops` with a session cookie, an OAuth token and a drop token each create a page under Inbox with the right title, body, tags, sources and actor; the response carries the id and link.
2. A drop with two files attaches both and the body links them; with `CAIRN_ATTACHMENTS_TO=off` the same request fails with `attachments_off` and the setting's name, and a text-only drop still succeeds.
3. A drop token used on `GET /api/v1/pages` gets `403 drop_token_scope`; a revoked token gets `401` naming revocation; `last_used_at` moves on use.
4. Tokens are stored hashed; the plain token never appears in any list, log or page.
5. `/inbox` lists drops newest first; filing one from the row form moves it and it leaves the list; the home page count matches.
6. `cairn drop` and `cairn drops` round-trip; `cairn drop --file` on a 25 MB file succeeds and on a 26 MB file fails with the limit in the message. `pnpm smoke:cli` passes.
7. The workspace summary reports the waiting count; the skill and instructions carry the processing paragraph; `pnpm context-cost` rerun.
8. A drop under Inbox is searchable like any page; after the agent moves it, backlinks from the target page show where it went.
9. `docs/AGENT-OPERATE.md` describes drop tokens and the Inbox; `docs/CLI.md` the commands; the person's guide the phone and `curl` recipes.

## Risks and open questions

1. Actor for drops by token: a person's phone and an agent's script use the same kind of token. Proposal: the token has a `kind` chosen at creation (`person` or `agent`), recorded on each drop's revision, so the changes feed and the review queue stay honest. Decide in ADR-079.
2. Server-side upload buffers a file in the container; at 25 MB and 10 files that is 250 MB per request. Stream to the blob and cap concurrent drops at 2.
3. Thumbnails exist for PNG, JPEG and WebP only (ADR-064); HEIC from an iPhone shows as a file link. Note it in the guide; conversion is a later item.
