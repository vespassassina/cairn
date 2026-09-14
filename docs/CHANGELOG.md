# Changelog

What changed, and why. Newest first. One entry per meaningful change: code, design direction or decision. The why matters more than the what: the code already records the what.

Entries link to the ADR when there is one. A change of direction that has no ADR yet still gets an entry here.

## 2026-09-14

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
