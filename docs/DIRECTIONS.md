# Owner directions

The instructions and design directions the project owner has given, in the order they were given, with where each one landed. Newest first.

Why this exists: most of Cairn is built with an AI agent, working from short instructions. The ADRs record the decisions that came out of them and the changelog records the work, but neither keeps the original ask. Without it, a reader cannot tell a choice the owner made from one the agent made while filling in the gaps. This log keeps that line visible.

Rules:

1. One entry per direction, logged in the same commit as the work it started. A direction that changed nothing yet still gets an entry.
2. Quote the owner's words where they carry the intent, lightly cleaned for typos. Otherwise summarise, and say it is a summary.
3. Every entry says where it landed: an ADR, a doc, a commit, or "not yet".
4. A later direction that reverses an earlier one does not edit it. Add the new one and point back.

## 2026-09-17

### "why it logs me out of the azure one so often ? can the token survive longer ?"

Asked alongside a sync-progress-bar request (see the CHANGELOG for the sync work, once built). Investigated `packages/api/src/oauth/server.ts`: the console's sign-in cookie was a fixed 7-day JWT that never renewed on activity, so a session expired at the same wall-clock time regardless of how often the console was used. Offered two fixes via `AskUserQuestion`: sliding renewal, or just extending the fixed duration. The owner chose sliding renewal. Landed in `packages/api/src/oauth/server.ts`, `packages/api/src/web/console.tsx`, `packages/api/test/oauth.test.ts` and `docs/CHANGELOG.md`, this commit.

### "the add child should be next to the edit button, similar style. also the publish button. fix then we release"

Moved "Add child" (previously a small text link in the rail) and the publish/unpublish toggle (previously its own button under "Published" in the rail) into the page header, styled as `.ak-btn` alongside Edit. Landed in `packages/api/src/web/console.tsx` and `docs/CHANGELOG.md`, this commit. "Then we release": next step is cutting a release tag once this is committed and pushed, per the same day's finding that `deploy/azure/deploy.sh`'s default `:latest` image only moves on a tag, not on every `main` push.

### A page-actions menu like docs.fabricplan.com's, then "yes build that"

> "i like the top right menu here, the one that allows me to open the page in another tool, share, send etc: https://docs.fabricplan.com/"

Read that menu's actual link targets rather than guessing from its labels. Proposed a Cairn-shaped equivalent (a PDF export using `window.print()`, plus a Claude Code/VS Code MCP-connect button, console-only, leaving the existing `cairn publish` as the share button) and asked which pieces to build. Owner said "yes build that" (below). Landed as the PDF export and "Open in an agent" controls described in `docs/CHANGELOG.md`, `packages/api/src/web/console.tsx` and `assets.ts`, this commit.

### "yes build that"

Confirmed the proposal above. Built: a "PDF" button and a "PDF (page + subtree)" link on every page (`/p/:id/print`), and an "Open in an agent" control in the page rail giving the `claude mcp add` command (with a copy button) and a `vscode:mcp/install` link. Both console-only, with the reasoning logged in `docs/CHANGELOG.md`. Not built: a prepopulated-chat deep link (GitBook's ChatGPT/Claude buttons), since that pattern needs a published, public page and only opens a read-only chat, not an edit — noted as a possible later addition against `cairn publish` rather than built without a reason to think it is wanted.

### Configure Claude to use Cairn, a quick way to see which server a command uses, and a review of what editing and sharing a page already supports

> "commit, push, deploy and test live environment. also make sure my claude is configured to use cairn (local that syncs to remote). also via cli i can ask cairn --server and it spits the local server running. if i run cairn --servers then it spits all http servers he knows about (the api can return the address of own server). for the user to click and open the wiki for review. also did we implement more types of pages/data ? is it easy to modify the pages, removing, adding, annotating ? is it easy to add a button on any page to link back to my agent for edits ... or a share button to send the link to somebody and set the page as public (only the page or the subtree can be shared and published). adding a pdf button to export to pdf, again selecting just the page or the whole subtree"

Several asks in one message, landed differently:

1. **Commit and push:** done, this commit.
2. **Deploy:** not done. Deploys are the owner's to run, never the agent's (standing constraint); `deploy/azure/.cairn-deploy.env` is also never read by the agent. Given the exact command instead: `CAIRN_IMAGE=ghcr.io/vespassassina/cairn:edge deploy/azure/deploy.sh`.
3. **Test the live environment:** the deployed app's public `/health` was checked (read-only, no credentials) and answered healthy, still on the digest last deployed; today's commits are not live until a redeploy runs.
4. **Claude configured to use Cairn:** it was not configured at all. Added with `claude mcp add --transport http --scope user cairn http://localhost:8787/mcp`, matching `README.md`. The local server was started for this session to confirm it answers; syncing to Azure needs `cairn login --instance azure` first, which the agent will not run (a credential action). Registered instances (`laptop`, `azure`) already existed from an earlier session; no recurring `cairn sync install` job exists yet.
5. **`cairn --server` / `--servers`:** `cairn instances` already lists every registered address (the `--servers` half). The other half, which one a command would use right now, did not exist: added as `cairn server`.
6. **More page/data types, easy editing, an agent-edit button, a share button, a PDF button:** answered in chat rather than built blind, since some already exist and the rest are real design decisions. Findings: still two data types, pages and tables; editing (create, append, replace-section, write, delete, move, with `--source` and `--verified`) is already there on all three doors (CLI, REST, console); a share/publish button already exists (`cairn publish`, ADR-032, page or subtree, no sign-in, owner-only by design). Not yet implemented: a button to open a page in a coding agent with the chat prepopulated, and a PDF export button (page or subtree). Both need a design decision before building.

### Run the write-loss test, then fix or minimise it, and do two of the three proposals

> "run the write loss test, then propose fixes or ways to minimize impact and recover"

The test that ADR-020 deferred to "the first real Azure deployment": how much a crash can lose, and whether a graceful stop loses anything. Run locally against a `file://` Litestream replica, using the real `docker/start.sh`, the real pinned Litestream binary and the real `recover.mjs`, so as to never touch the live Azure deployment or its credentials. Results: a graceful stop loses nothing (20/20 marker writes survived, every run); a hard kill loses only the last ~840-930ms of writes, and nothing at all once 2 seconds have passed since the last write.

Three fixes were proposed: (1) a regression test for "graceful stop loses nothing", (2) tuning Litestream's `sync-interval` down via a generated config, to shrink the crash-only window further, (3) telling the operator how stale an ordinary restore is, not only a rewound or backup one. The owner's reply:

> "do 1 and 3"

Landed in: (1) `.github/workflows/ci.yml`'s `image` job, a new step that writes a page, stops the container gracefully, wipes its local volume and restarts against a `file://` replica, asserting the page survives; (2) `packages/api/src/recovery/ladder.ts` (the `restored` outcome now carries `latest`, the newest moment the replica held), `packages/api/src/recovery/litestream.ts` (`ageOf`) and `packages/api/src/entry/recover.ts`, which now logs how old that point was. Option 2, the `sync-interval` tuning, was left undone: the measured window is already sub-second and bounded, so it was not judged worth the added `-config` YAML plumbing yet.

### Implement all the ADRs from the 2026-09-16 review, and stop asking

> "implement all adrs"

Then, mid-session:

> "work non stop, keep questions for tomorrow mornign"

The first direction is to build the code for ADR-053 through ADR-058 and their four specs, not to plan it further; the review and the specs already exist. The second changed how to work through it: make reasonable engineering calls alone rather than pausing for confirmation, and save any real open question for the next session. Landing this and the next entries: ADR-055 first, since the summary budget fix was already mid-edit when the direction arrived; the rest follow in the priority order `docs/ROADMAP.md`'s "The review of 2026-09-16" section sets.

### Review the app, then write up the fixes properly

> "review the app, propose fixes and improvements to make this tool really useful."

Then, once the review was delivered:

> "analize the fixes, write detailed adrs, specs and roadmap."

Two directions, logged together because the second is what turned the first into something the project keeps. The word that shaped the first was "really useful": not a code review and not a list of features, but a question about whether the thing works as a tool for the person who built it. So the review was done against the running system, by using it: the laptop copy, the console at a desktop width and on a phone, a live MCP initialize, and the CLI pushed at deliberately.

The answer was that on that day, on the owner's own machine, nothing could reach Cairn at all, for four separate reasons that were each a piece of setup quietly decayed. That is the finding the whole review turns on, and it is why the first two items of work are about presence and sign-in rather than about anything a feature list would have named.

The second direction is the one that decided the shape. Analyse before writing, so the ADRs are checkable against code rather than asserted, and every claim in them was traced to the line responsible before it was written down. "Specs" also filled a gap: the global instructions have asked for `docs/specs/<name>.md` all along and this project had no such directory.

Landed as ADR-053 to ADR-058, four specs in the new `docs/specs/`, a "The review of 2026-09-16" section in `docs/ROADMAP.md`, and a changelog entry. The review itself is a page in the owner's Cairn, "Cairn review 2026-09-16: fixes and improvements", under the Cairn project page. No code changed.

### Paired Cairns should sync themselves

> "paired instance should sync every few hours automatically"

`cairn sync install` had existed since ADR-029 and nobody had run it, including on the owner's own laptop and Azure pair, so two registered Cairns were paired in name and drifting in fact. Two things in the direction needed the owner rather than the agent, and both were put back to them. "Every few hours" was made four hours, because every run wakes the Azure copy for its 30 minute idle timeout and the interval is really a choice about how much of the day the cloud is awake; the old default of an hour left it awake about half the time. And "automatically" was made an offer rather than an action, taken at the moment a second Cairn is registered, because installing the job writes a launchd agent or a systemd timer on the person's own machine. The owner chose both. ADR-052.

### Give --instance a short form

> "for CLI cairn login, instead of --instance, also allow -i"

Asked while signing in to the Azure Cairn, which is the moment the flag is unavoidable: sign-in is the one command that cannot fall back to whichever instance answers, so the full flag has to be typed. Landed as `short: "i"` on the existing option in `packages/cli/src/main.ts`, which makes it the same flag everywhere rather than a second one on `login` alone, and in the help line and `docs/CLI.md`. `-i` was free; only `-h` and `-V` existed.

### Build the startup recovery before committing

> "build startup recovery then we commit and deploy"

Given as a correction: the previous instruction had been to commit, push and redeploy the cloud archives, and this replaced it. The archives were only half the answer. They gave Cairn somewhere to recover from, and nothing yet climbed down to it, so a deploy at that point would have shipped backups that still nothing would ever read.

It completes the earlier direction of the same day, "when starting and db corrupted, catch the error, log, then move the broken version (rename) then check for backup", quoted in full below. Landed in `docs/decisions/ADR-051.md`, `packages/api/src/recovery/ladder.ts`, `packages/api/src/entry/recover.ts` and `docker/start.sh`.

### Backups belong in the platform's own object storage

> "on azure the backup must go to blob, on aws on s3 and so on."

Given immediately after the backup engine landed with only a folder archive, which on Azure meant the container's own disk. Cairn warned at startup that those backups would be lost with the container, and the direction is the correct response to that warning: a warning that your backups are worthless is not a backup.

"And so on" set the shape rather than naming a list. One setting, `CAIRN_BACKUP_TO`, whose scheme picks the destination, mirroring `CAIRN_REPLICA_URL`, which already resolves to `abs://` on Azure and `s3://` elsewhere. S3 covers AWS and everything else that speaks S3, including MinIO and Backblaze through `CAIRN_BACKUP_ENDPOINT`, which is also the honest route to GCP.

Landed in `docs/decisions/ADR-050.md`, `packages/api/src/backup/azure.ts`, `packages/api/src/backup/s3.ts`, `packages/api/src/backup/open.ts` and `deploy/azure/main.bicep`.

### Make it start and deploy clean, and back up before shutting down

> "my take: make it start and deploy clean, then add the import, wrap into error management. log issues"
>
> "also when starting and db corrupted, catch the error, log, then move the broken version (rename) then check for backup (are we doing backups right?), ingest last good backed up version (by cloning the backup into the current filename), then log the broken one position and what happened."
>
> "starting older and replicating SHOULD pull new data not overwrite older. old records should be marked with timestamp and when replicating to a newer version it should automatically pull not push new records. why not?"
>
> "for backups, do a new backup before shutting down, is it possible?"
>
> "for local just run an internal timer every 12 hours. or at shutdown"
>
> "same for cloud, if it never shuts down, do a backup every 12 hours"
>
> "keep them rolling, backups older than a week get delete"
>
> "so let's change the game here, every new write if last backup is older than 3 hours, we backup. change rolling days to 2. min backups to keep 3"
>
> "basically when we launch we also load the date of last backup as reference"
>
> "add a bit more error and warning logging"

Given while recovering the Azure Cairn from the outage in ADR-046, after three runs of `deploy/azure/deploy.sh` turned out to have deployed nothing at all.

The question "why not?" was answered rather than acted on: Cairn's own sync already works exactly as described, comparing records by timestamp and merging both sides (ADR-023, ADR-030), but Litestream replicates SQLite pages and a linear transaction log, where there is no record to carry a timestamp and no merge to perform. The conclusion was not to make Litestream smarter but to move recovery up to the layer that does have records, which is what makes a logical reconstruction the right shape for a backup: a mirror replicates corruption, a reconstruction cannot carry a damaged page. At the time this was written the reconstruction was assumed to be a `cairn export`. It is not; ADR-049 settled on `VACUUM INTO`, which is a logical reconstruction that comes out as a real SQLite database, for the reasons in the entry below.

"Are we doing backups right?" was answered no. `docs/AGENT-OPERATE.md` called the Litestream replica a backup and said "nothing to do", and the only readable copy was a manual `cairn export` suggested "now and then". Measured during the discussion: an export of the live workspace takes 0.089 seconds and 640 KB against a 30-second shutdown grace period, and Litestream 0.5.17 was confirmed to forward SIGTERM to its `-exec` child and wait for it, so a backup on shutdown is viable.

Landed so far in: `docs/decisions/ADR-047.md`, `deploy/azure/deploy.sh`, `docs/DEPLOY-AZURE.md`, `docs/AGENT-OPERATE.md`. The backup engine, the SIGTERM handler and the start-up recovery path are not yet built.

### Two questions that set the recovery order

> "can we avoid running abroken transaction ? why did that happen ?"

> "also if we have backups and the wals are aligned, why don't we start from a backup instead of a restore ?"

Both were answered before any code was written, and both changed the design.

The first sent the investigation back to the evidence rather than to a guess. The answer, in ADR-048: the truncated transaction was written by a Litestream that was killed rather than allowed to finish, and Cairn had no signal handler at all, so we had built the conditions for it. That turned "add a shutdown backup" into "handle the signal first", which is the order the work then followed. The second half of the answer is that a truncated upload is always at the tail of the replica, so dropping it costs one transaction and nothing else, which is why walking back is cheap.

The second question corrected the recovery order. Starting from a backup by default would discard up to three hours of work on every cold start, and then replicate that older state back over the good copy, which is the ADR-046 hazard in a new form. The alignment the question assumes does not exist either: the backup is a logical export with no pages, and Litestream's files are physical page writes keyed to a database file that no longer exists, so they cannot be replayed onto it. That disconnection is the backup's value rather than its limitation, because an export cannot carry a corrupt page. What the question did sharpen is the middle rung: on a failed restore, ask the replica for the newest transaction that both restores and passes its integrity check, before falling back to a backup that is hours older.

So the agreed ladder is: restore, then the newest sound transaction, then the newest verified backup, then stop and say so. The owner's reply to the plan was "ok. deal", with the order set as shutdown first, then the recovery ladder, then the logging.

One part of that answer was later found to be wrong, and correcting it improved the design. The backup is not a logical export with no pages. `VACUUM INTO` was measured during the build and turned out to be a logical reconstruction whose output is a real SQLite database: it reads through the B-trees, writes a fresh file, folds the write-ahead log in, and refuses a source it cannot read through, which is the property that keeps it from copying corruption. That keeps everything the answer above relied on, a backup that cannot carry a damaged page, and drops the part that was only a limitation. It also dissolved the question of sharing `packages/cli/src/export-format.ts` between the CLI and the server, since nothing needs to be shared. Landed in ADR-049.

### Stream the last log file over the API, and rotate log files

> "add an api call to stream last logfile contents."
>
> "logfile rotation"

Not yet. Raised in reply, and still open: an API cannot serve the log of a process that will not start, which was precisely this incident, and on Container Apps a log file under `/data` does not outlive the container that wrote it because Litestream replicates the database and not arbitrary files. So the question the design has to answer first is where a log lives such that a later boot can read what an earlier failed boot said. Also flagged: a log endpoint must be authenticated and scrubbed before it serves anything, and hard rule 14 means REST, MCP and the CLI each gain the capability or an ADR says why not.

The owner answered all of that the same day:

> "log to blob storage directly for startup and log file for rest. do not incrtease size of sqlite."
>
> "try to keep logs clean of secrets. and logs go to a protected, private blob and the stream only to authenticated users."
>
> "implement in mcp/cli/api"

That settles the four open points. Start-up writes straight to blob storage, because that is the only place a log survives a container that never finishes starting, and it is reachable before the database is. Everything after start-up goes to a rotating file, which is cheap and needs no network on the write path. The database is explicitly not a log store: SQLite stays the size of the wiki, which also keeps the Litestream replica and the backups small. Secrets are scrubbed on the way in rather than on the way out, so a leak cannot be one forgotten endpoint away. The blob container is private, and the stream endpoint requires a signed-in user. And it lands on all three surfaces, which is hard rule 14 applied rather than excused.

### Ingest an existing wiki from the filesystem

> "add a tool in the cli to ingest an existing wiki from the filesystem"

Not yet. Distinct from `cairn import`, which reads Cairn's own export format and keeps its ids (ADR-016). Ingesting a foreign wiki means deriving stable ids from paths, mapping folders onto the page tree (ADR-024, ADR-026) and turning wikilinks and relative Markdown links into edges. Fits the CLI's constraints as they stand: read files, write over HTTP, never open the database (hard rules 15 and 16). Open question before building: which source format is the real target, since Obsidian, MkDocs, a Notion export and plain Markdown differ mostly in frontmatter and link syntax.

### Stop the database corrupting, and stop the container starting on a bad one

> "we can restore from laptop, meanwhile we need to figure out how to prevent the db from corrupting and the container from starting."
>
> "this is a real learning and chance to make it better"
>
> "also add logging so we can diagnose"

Given after asking "is cairn connected? how do i keep it running?" and finding the Azure Cairn had been in a restart loop: Litestream could not decode its copy of the database, and the start script retried that failure twelve times, exited, and was restarted, forever. The owner's own copy on the laptop is the good one, so recovery was not the problem; not being told what was wrong was. Landed in: `docs/decisions/ADR-046.md`, `docker/start.sh`, `Dockerfile` (Litestream 0.5.7 to 0.5.17), `packages/cli/src/client.ts`, `docs/AGENT-OPERATE.md`, with tests in `packages/api/test/container-start.test.ts` and `packages/cli/test/client.test.ts`.

## 2026-09-15

### Add `cairn restore` and `cairn peek`

> "do cairn restore and cairn peek (to view an old revision but not revert)"

Followed on from a question about what else the CLI might need, where the answer named restore (already in core and the console, missing from REST and the CLI) as the real gap. Landed in: `docs/decisions/ADR-045.md`, `packages/api/src/rest/routes.ts`, `packages/cli/src/main.ts`, `docs/CLI.md`, with contract tests in `packages/api/test/rest.test.ts` and `packages/cli/test/cli.test.ts`.

### Close the name question: keep Cairn, no dedicated domain

> "Keep Cairn, no dedicated domain" (chosen from three options after a domain check found the short obvious names already taken)

Asked which of the roadmap's `next` items to pick up; chose "Name decided" (PRD Q5). Checked domain availability (`cairn.dev`, `cairn.app`, `cairn.io`, `getcairn.com`, `usecairn.com` all registered; `cairnwiki.com` free) and presented the choice: keep Cairn as-is, keep it and buy `cairnwiki.com`, or reconsider the name entirely. The owner chose to keep Cairn with no domain purchase, matching the name already used everywhere (GitHub, npm, container images). Landed in: `docs/decisions/ADR-044.md`, `CLAUDE.md`, `docs/PRD.md`, `docs/ROADMAP.md`.

### Deploy guides for AWS, GCP and Proxmox

> "make an aws and gcp deploy and a proxmog deploy guide"

Asked for three new deployment guides. Rather than building AWS/GCP-specific managed-container infrastructure (ECS, Cloud Run, and the new storage, IAM and CI work that would need), ADR-043 extends the existing "one container, Docker, local-or-replicated SQLite" model (ADR-020) onto a plain cloud VM, since it reuses `deploy/docker/compose.yaml` and `docker/start.sh` unchanged. Landed in: `docs/decisions/ADR-043.md`, `docs/DEPLOY-AWS.md`, `docs/DEPLOY-GCP.md`, `docs/DEPLOY-PROXMOX.md` (new), `docs/DEPLOY-DOCKER.md`, `docs/AGENT-INSTALL.md`, `docs/README.md`, `docs/ROADMAP.md`.

### The npm package settled on `@vespassassina/cairncli`, after `@cairn/cli` and `cairncli` both failed to publish

> "name not available" / "ditch the org, let's stick to a name" / "@vespassassina/cairncli (Recommended)"

Three names in a row hit a wall on npm. `@cairn/cli` failed with a 404 ("could not be found or you do not have permission to access it"): a scoped package's first publish needs its scope's org to exist, and the `cairn` org was already held by someone unrelated. Asked the owner to choose between a different scope, an unscoped name, or disputing the existing claim; they chose unscoped. `cairn-cli` was taken outright; `cairncli` looked free on the registry but npm's publish-time similarity check rejected it as "too similar to existing package cairn-cli" with a 403, an error the registry lookup alone does not surface. npm's own error suggested the fix: publish scoped to the owner's existing npm username instead, `@vespassassina/cairncli`, which needs no separate org and is exempt from the similarity check. Confirmed available and asked the owner, who agreed. Landed in: `packages/cli/package.json` (name, `publishConfig.access: "public"` restored since it is scoped again), `.github/workflows/ci.yml` (`pnpm --filter` targets and step names), `docs/CLI.md`, `packages/cli/README.md`.

### Which roadmap item next: publish the CLI to npm

> "next item"

Checked the npm registry for candidates first, since PRD Q5 makes the name an owner decision, not an engineering one: `cairn`, `cairn-cli` and `cairn-mcp` are all taken (the first two unrelated and dormant since 2017 and irrelevant respectively; `cairn-mcp` close enough in its own description, "MCP server for Cairn, a shared knowledge base of AI agent observations", to be worth a look), while the scoped `@cairn/cli` already used in `packages/cli/package.json` is free. Asked; the owner chose to keep `@cairn/cli` rather than pick a new name. Landed in: `packages/cli/package.json` no longer private, with `publishConfig.access: "public"`, `files`, and `exports` fixed to point at the built `dist/`; a `pnpm publish` step added to CI's `release` job, gated the same way the GitHub release already is, on a `v*` tag. No tag was pushed; publishing itself needs the owner to add an `NPM_TOKEN` repository secret first (never done by the agent) and to push the tag (ADR-014, `docs/CLI.md`, `docs/ROADMAP.md`).

### A dark desaturated night blue background

> "can we use a dark desaturated night blue for the background of cairn?"

Landed as a token override in `CAIRN_CSS` (`packages/api/src/web/assets.ts`), outside any `@layer` so it beats artifactkit's own layered tokens without `!important`: `--t-bg:#161A22`, `--t-ink:#E8EAEE`, `--t-accent:#6AA9D8`, `--t-accent-2:#4E86AC`, `--t-lift-amt:7%`. Everything else (surfaces, rules, washes, chart colours) derives from these automatically, the same way artifactkit's own dark example works. Covers the review console and the public wiki, since both serve the one `/assets/console.css`. The PWA manifest and `theme-color` meta tag match. This is a fixed palette, not a settable theme with a live preview; that stays the separate, larger "Reskin the wiki: a theme setting" roadmap row.

### Which roadmap item next: search quality

> "next item"

By this point "Bridges between Cairns" was fully done, so there was no longer a single unambiguous next item: the roadmap's remaining `later` rows spanned unrelated areas (search quality, npm publishing, sync and console features, the Obsidian bridge, a git mirror, and more). Asked which area to pick from; the owner chose "Search quality", specifically the one known eval miss: "search does not know direction (e.g. 'appetite suppressant' vs 'appetite stimulant')". Landed in: ADR-042, a negation-aware keyword match, and a new roadmap item recording a second, separate cause found along the way (the vector margin filter, left alone rather than tuned to fit one query).

### Which roadmap item next: discovery by following citations

> "next item"

By this point "Discovery by following citations" was the only item left on "Bridges between Cairns", so no choice was offered; picked up directly. Landed in: ADR-041, `/.well-known/cairn.json`'s `cites` field filled in from published pages' citations, and `cairn discover`, a new CLI-only command that walks outward from "Trusted cairns" following each Cairn's `cites`, landing newly found Cairns in a new "Discovered cairns" table for the owner to review.

### Which roadmap item next: "cited by", across Cairns

> "next item"

Offered a choice of what remained on "Bridges between Cairns", the owner picked "'Cited by', across Cairns" over discovery by following citations. Landed in: ADR-040, `POST /webmention`, an SSRF-safe verification fetch, a new "Citations" table read and managed through the same generic table tools ADR-037 already gave "Trusted cairns", and a "Cited by" section on published pages.

### Which roadmap item next: machine-readable citations on public pages

> "next adr"

Offered a choice of what remained on "Bridges between Cairns", the owner picked "Machine-readable citations on public pages" over "cited by" and discovery by following citations. Landed in: ADR-039, schema.org `citation` and `isBasedOn` as JSON-LD on every published page and every page in `cairn export --format site`.

### Which roadmap item next: links to the original, across Cairns

> "next item"

Offered a choice of what remained on "Bridges between Cairns", the owner picked "Links to the original, across Cairns" over machine-readable citations, "cited by" and discovery by following citations. Landed in: ADR-038, a new `cairn_link` edge type recognising a Markdown link to another Cairn's published page (`<origin>/w/<id>`) as part of the link graph.

### No registry. A cairn keeps its own trusted friends instead

> "avoid the registry. not my place. but a cairn can keep references to other cairns and act as a local 'trusted friends' catalog"

Asked what to pick up next on "Bridges between Cairns", the owner rejected "A registry of public Cairns on GitHub": running or curating a shared registry is not something they want to take on. In its place, a Cairn keeps its own local list of other Cairns it trusts, so discovery and "cited by" do not depend on any registry existing. Landed in: ADR-037 and `cairn trust <url>`, an ordinary table "Trusted cairns" with no new storage or schema, and `docs/ROADMAP.md` (the registry item marked rejected, "Discovery by following citations" and "'Cited by', across Cairns" reframed around this local list, still `later`).

### Which roadmap item next: citations kept correct

> "ok, next item"

Asked to choose from the roadmap's "Bridges between Cairns" section, the owner picked "Citations kept correct" over links to the original across Cairns and machine-readable citations on public pages. Landed in: ADR-036, `cairn check-sources`, and `sourceHref` recognising a DOI or a PubMed id as a link.

## 2026-09-14

### Which roadmap item next: static site export

> "commit and next item"

Asked to choose again from the roadmap's "Bridges between Cairns" section, the owner picked "Static site export" over citations kept correct and links to the original across Cairns. Landed in: ADR-035, `cairn export --format site`.

### Which roadmap item next: a Cairn describes itself

> "next item"

Asked to choose from the roadmap's "Bridges between Cairns" section, the owner picked "A public Cairn describes itself" over the static site export and the Obsidian bridge. Landed in: ADR-034, `/.well-known/cairn.json`.

### Make the sign-in survive a lost refresh

> "can we make the token last longer ?"

Asked after the Cairn MCP sign-in expired and the owner was told the lifetimes: one hour for an access token, 30 days for a refresh token that rotates on every use. Lengthening those would not have helped, because rotation restarts the clock and the sign-in was not idle. What ends a sign-in early is a refresh token presented twice, which Cairn treated as theft even when it was a lost response, two processes refreshing at once, or a database restored to a moment before the last rotation. Offered the choice, the owner picked the fix rather than the longer lifetime: "Add the 60 second replay grace. This is the fix." Landed in: ADR-033 and `packages/api/src/oauth/server.ts`.

### Build the public wiki

> "implement next"

Said again after the eval set landed. Asked which roadmap item, the owner chose the public wiki: mark a collection public, serve it read-only with no sign-in, with `sitemap.xml` and `robots.txt`, private by default, and nothing private leaking. It follows the earlier direction that Cairn "can be a knowledge manager as well as a free knowledge source", and the owner's note that "cairn documents and wikis can be made public but they default to private". Landed in: ADR-032, the published surface at `/w`, the console control, `cairn publish` and `cairn unpublish`, `CAIRN_CONTENT_LICENCE`, and section 7 of `docs/AGENT-OPERATE.md`.

### Finish the eval set and publish the number

> "implement next"

Said after the console change landed, with the roadmap's "next" rows in front of us. The oldest of them was the one Phase 0 item still open and the one blocking any claim about search, so that is what was done. Landed in: 14 new queries in `eval/queries.yaml`, the two placeholders removed, and recall@5 published in the README and PRD section 11.

### A new page starts under the page you are reading

> "in cairn web, when i click create a new page and i am inside a page, it should default to that. note and then implement next"

The console's "New page" button always started a page at the top level, whatever you were reading, and only a small "New child page" link in the sidebar carried the parent. Landed in: the header button on a page, its history and its old versions now starts under that page, the form says which page it chose and why, and a parent that no longer exists starts at the top level with a banner saying so.

### Errors that guide, and sensible defaults

> "add to our coding style guide that we always try to write the best possible useful errors. user needs to be guided as much as possible by the code (hence sensible defaults) even when the user is an agent."

Cairn had no coding style guide beyond the hard rules, so the agent added a "Coding style" section to `CLAUDE.md`, which `AGENTS.md` points every agent to. Landed in: that section, PRD principle 7, and ADR-031 point 4.

### An agent-first guide to deploying, configuring and running Cairn, kept up to date

> "also we need to make sure that there is an agent first deployment, configuration and operation guide and that it is up to date."

`docs/AGENT-INSTALL.md` covered deploying; nothing covered configuring or running a Cairn for an agent, and the install guide had drifted. Landed in: `docs/AGENT-OPERATE.md`, fixes to `docs/AGENT-INSTALL.md`, a test that checks both against the code, hard rule 19 widened, and ADR-031.

### More kinds of content, and an editor that helps create them

> "add to the roadmap to have a bit more options to write to the web store. allowing notes (linked from the wiki) blog, diagrams, pictures and other information formats. the online editor should help the user create those. agent goes through the cli/api, user through the agent or manually from the ditor."

Landed in: the roadmap item "More kinds of content: notes, blog posts, diagrams, pictures", under Phase 2. Not built; needs an ADR.

### Reskin the wiki

> "also nice to have a style customization option in the online editor that allows the user to reskin his wiki (by changing the config of the css ofc)"

Landed in: the roadmap item "Reskin the wiki: a theme setting", under Phase 2, built on the theme tokens the console already uses. Not built; needs an ADR.

### Fix the login error message

> "correct and improve the login error message."

After `cairn login` failed for the owner with "http://localhost:8787 does not use OAuth sign-in (HTTP 404). On localhost no sign-in is needed." while they meant to sign in to Azure. Landed in: the changelog entry "`cairn login` says how to sign in to the Cairn you meant", and `docs/CLI.md`.

### Keep building: ordered history and merge in sync

> "then keep building"

Said after the roadmap items above were added, with the next roadmap item "Ordered history and three-way merge in sync". The owner did not choose among the options the direction below raised, so **the agent chose them**: edit times on each page and row, from a clock that never repeats, carried by sync, instead of a hybrid logical clock; a three-way merge line by line, as git does, instead of by section; and the newer edit for a part both sides changed, with the other kept in history. Linking revisions across instances and a console list of conflicts were left for later. Landed in: ADR-030, and the roadmap items "History as one chain across instances" and "Sync conflicts to review in the console".

### A registry of public Cairns

> "can we think of a registry for public cairns ? would that make sense? even an index on github, a reddit post, something to allow a search engine to pull the link and make a public one discoverable"

Then, after the agent proposed three layers: "add them as roadmap". Landed in: three items in the roadmap section "Bridges between Cairns": a public Cairn describes itself at `/.well-known/cairn.json`, a registry on GitHub added to by pull request and checked by CI, and discovery by following citations. Posts on Reddit and similar sites are for announcing it, not the registry itself. Not built; each needs the public wiki first.

### Bridges, not islands: citations and links to the original

> "let's also make sure we always keep citations correct and links to original content. this is the key for semantic internet across cairns. we are not going to be islands with no bridges"

Landed in: PRD principle 6, "Bridges, not islands", and a new roadmap section, "Bridges between Cairns": checking citations, links to the original across Cairns, machine-readable citations on public pages, and an optional "cited by" across Cairns. The static site item now says it keeps every source. Not built; each needs an ADR, and the first supersedes ADR-027's "Cairn does not check citations".

### Publish a wiki: read-only, indexable, or as a static site

> "add to comments and docs that the wiki can be made public (readonly) and indexable by search engines. it can even be just exported and dumped in github or a blob storage or s3 static website or google cloud or dropbox to be shared on the web. cairn can be a knowledge manager as well as a free knowledge source."

Read as the roadmap and docs. Landed in: two roadmap items, "Public wiki: read-only and indexable by search engines" and "Static site export", replacing the public half of the phone-console item, and the PRD's users and P2 list. Not built; the public wiki needs an ADR amending ADR-017.

### The CLI's version, and how to update it

> "fix both"

In answer to the agent's finding, while explaining how to install and update the CLI, that `cairn -V` printed `0.1.0` in every release and that `docs/CLI.md` said nothing about updating. Landed in: the changelog entry "One version for a release, and how to update the CLI", with 0.1.4 set for the next tag.

### Put the features that answer Obsidian on the roadmap

> "add these in our docs and roadmap"

Followed by the ten features proposed in answer to the question below, in the same order: an Obsidian bridge both ways; a git mirror of the export; an agent activity digest with optional approvals; stale-page reviews; quick capture from a web clipper and a phone; a graph view; templates, daily notes, attachments and images; a console that works on a phone and an optional public read-only page; sharing with permissions; and a published search-quality number. Landed in: a new roadmap section, "Against a notes app kept in git", and a fourth entry in the PRD's landscape. None is built; each needs an ADR.

### Sync keeps order, and settles conflicts the way git does

> "for sync to work we need to use very granular timestamps. no doc shall conflict and order should always be maintained. also in case of conflicts, how do we solve ? take the newest and merge ? newest and link the older keeping the chain in order ? how does git do it we could do the same"

Said while ADR-029 was being built. Landed in: a new roadmap item, "Ordered history and three-way merge in sync", marked next, with a hybrid logical clock for order, revisions linked across instances, and a three-way merge by section. The question of how git does it was answered in the conversation: git orders by parent links, not clocks, and merges three ways against the common ancestor. Built in ADR-030 after "then keep building" (above), with the choices the agent made listed there.

### Why Cairn and not Obsidian on GitHub

> "evaluate why users would use cairn and not obsidian stored on github. propose features we can add to make cairn more appealing"

A question, answered in the conversation with a comparison and a list of candidate features. Landed in: nothing yet; the features become roadmap items only when the owner picks them.

### The CLI knows every instance, uses the best, and catches up on start

> "allow cli to know all the endpoints and use the best. when starting check for sync from cloud if someone has changed something. and sync local"

A follow-up to the direction below, refining the same roadmap item. Landed in: the roadmap item "Named instances, kept in sync", whose notes now include both. Built in ADR-029, where the owner chose, from four questions and each time the recommended answer: the first instance that answers, in the owner's order; a `cairn start` command; a background job the CLI installs; and a hub, the first instance that answers syncing with each of the others.

### Sync as backup and a hybrid service across clouds

> "add to the features : use sync as a backup/ha strategy, allow cairn cli to register multiple instances and keep them synced regularly, for example work local and sync remote every x minutes (or hours to keep cost low) so we have a hybrid service running cross cloud using the same atomic unit"

"The same atomic unit" is the one container every deployment runs (ADR-020). Landed in: a new roadmap item, "Named instances, kept in sync", marked next. Built in ADR-029.

### Freshness: when a page was last verified

> "done, do next"

Said after deploying provenance to Azure. The next roadmap item was "Freshness: `verified_at` on pages", when a fact was last confirmed, separate from last edited. Asked four questions, the owner chose the recommended answer each time: a page is marked verified by a flag on a write (`verified: true`), with an empty append for a check that changes nothing else, and no new tool; a page created with sources counts as verified at creation, one without starts never verified; the console shows the age everywhere ("Verified 3 months ago", "Never verified") with a list of the least recently verified pages, and no staleness threshold; and pages only, not rows. Landed in: ADR-028 and the matching changelog entry.

### The table inside Peptides is Peptides Index

> "rename the inner peptide table to Peptides Index"

This settles the name clash left open on 2026-09-13, where the Peptides collection held a table also called Peptides. Landed in: the changelog entry "The Peptides table is now Peptides Index".

### Provenance: sources on every write

> "next item"

The next roadmap item was "Provenance: `sources` on every write", where a fact came from, shown in the console. Asked three questions, the owner chose the recommended answer each time: sources live on the page or row, as a list that each write adds to, with history showing which change added each one; they are optional but prompted, so agents are told to add one whenever a fact came from somewhere and a write without one still goes through; and a source is a short text, a URL or a citation such as "Smith 2021, J Pept Sci", with URLs shown as links. Landed in: ADR-027 and the matching changelog entry.

## 2026-09-13

### Start step 2 of the rename

> "start next"

The go-ahead for ADR-026 step 2, which the agent had proposed: tables are called tables in the API, the MCP tools, the CLI and the export too, with the old REST paths and CLI command still answering. Landed in: ADR-026 "Step 2, as built" and the matching changelog entry.

### Collections are wikis, and the home shows them

> "the pages page, what does it mean? why not just have collections and start the browsing from there? for a human that's the first entry point. home should just show available collections. a collection is kind of a database, tree shaped not table shaped"

> "i open cairn web app, i see what collections are available each is a wiki. i navigate there"

> "so in the sidebar, the collection is inside the subcollection" (with a screenshot of the sidebar)

Asked three questions, the owner chose: a collection is a top-level page and its tree, not a new kind of record; the peptide wiki becomes one collection, Peptides. For the tables, they asked "isn't a table a tree? what about trunks? or branches"; after the agent explained that a branch is any page with children, they chose "table", with a table shown as one node in the sidebar. Landed in: ADR-026 and the web app change (step 1), then the API, MCP and CLI rename (step 2). The wiki restructure on Azure is in the changelog entry "The peptide wiki is one collection".

### The root page read as a loop

> "the way the 2 collections are inside peptides is weird. it's like now it is a referencing recursive link. my idea was that a new page could be created and promoted to root of both."

> "also when opening the collections page, show the root and sub collections"

Lightly cleaned. Asked for a name, the owner chose "Peptide database" for the root page; asked how a page should show its collections, they chose inside the page, below its text. Landed in: the "A page shows its collections inside it" changelog entry, and ADR-024's amended decision 7.

### Proper HTML head, collections under a root, and links between rows

> "cairn webapp also needs proper html tags including title which should read Cairn."

> "the current wiki has 2 collections but these are related to each other, they should be under peptides collection as sub collections. is it possible to add a new root/collection and move sub collections there by just adding a link? this should be a feature of cairn"

> "what about crosslinking in the same collection? is it implemented? how does the scan and crosslink update works?"

Landed in: the "proper head" changelog entry for the first. For the second and third, the agent explained how links work, then asked three questions. The owner chose collections under a page (over collections inside collections, or links only), moving only the two collections under a new "Peptides" page, and row links built now. Landed in ADR-024.

Also: "update claude.md", done in the owner's own global instructions, which now say Cairn runs on Azure; not in this repository.

### Fix the cold start

> "how can we fix the cold start issue ?"

> "what other options we have to additionally cut cold start ? can we store a fully baked image ?"

Landed in: the "Shorter and fewer cold starts on Azure" changelog entry (a smaller image, `CAIRN_IDLE_MINUTES`, `CAIRN_ALWAYS_ON`). The image was already fully baked; the other options are in the answer given with that change, and not built.

### Move everything to Azure, and let two Cairns sync

> "move everything to azure, migrate memory. add an automigration feature to allow 2 cairns to be synced. azure works perfectly"

Landed in: the migration of the local wiki with `cairn export` and `cairn import`, and the "database is locked" fix it needed; Claude Code's `cairn` server now points at Azure. Sync: ADR-023 and `cairn sync`. Asked how conflicts should resolve, the owner chose "newest wins, loser kept" in history; asked where sync should run, they chose the `cairn` command over a server syncing by itself.

### A favicon

> "also add a favicon to cairn."

Landed in: the "Added: a tab icon for the console" changelog entry.

### Deploy to Azure, in a new subscription, in Sweden Central

A summary. Asked what was next, the owner said "deployment?", agreed to Azure first, created a new pay-as-you-go subscription in a new tenant for it, and said "go". When West Europe refused new customers, they chose Sweden Central from the regions that accepted the subscription.

Landed in: the deployment itself, and the "Fixed: the image could not reach its replica" changelog entry, which also makes Sweden Central the script's default. The subscription and tenant ids stay out of this repository.

### Publish the first release

> "then publish and build"

Given after the image was made public, in answer to the agent asking whether to tag `v0.1.0`. The agent's push of the tag was blocked by its permissions, so the owner pushed it.

Landed in: the `v0.1.0` tag and GitHub release, and the "Released: v0.1.0" changelog entry. The CLI was not published to npm: the package is private and PRD Q5 (the name) is still open.

### No pull requests: commit to main

> "for the repo, disable PRs and just keep committing."

Landed in: the Workflow section of `CLAUDE.md`. PR #1 still needs merging, and the repository setting that turns pull requests off still needs switching; both are the owner's to do in GitHub, because the agent's attempt to merge was blocked by its permissions. Update, same day: both done. PR #1 was merged into `main` and pull requests are turned off in the repository settings.

### Vector search in SQLite, with a small model in the container, English only

> "add vector search to sqlite. there is an extension. plus in container embedding with small model"

> "add notes that this works only for english"

Asked which model, the owner chose bge-small-en-v1.5 (English only, 34 MB) over multilingual-e5-small (118 MB) and all-MiniLM-L6-v2, and approved the downloads (the npm packages and the model). Landed in: ADR-022, the `Embedder` port, `packages/adapter-embeddings-local`, sqlite-vec in the SQLite adapter, hybrid search, the image, and "English only" in the README, PRD, ADR, guides and agent guide.

### Fuzzy search asked about, not requested

> "for the search, are you implementing fuzzy? bm25?"

A question. Answered: BM25 yes, fuzzy no; typo correction was offered and not taken up. No change.

## 2026-09-12

### Next open point: search over-matching

> "next open point", then "next"

After the agent listed the open points and offered to take search over-matching while the others waited for the owner. Landed in: ADR-021, the search changes, and no-answer queries in the eval.

### One container, as small as possible, and Proxmox with local storage

Asked first whether Functions and Cosmos would be better on Azure: "for azure wouldn't be better to use functions? shouldn't we use cosmos? i get that aca is better for multiplatform. i could have the same container in aws, local etc. but aren't we throwing away good capabilities?" After the comparison, three directions:

> "ok, let's go with containers"

> "keep it as compact as possible, not a fleet of containers"

> "i am going to run on proxmox later, add local mounted storage"

Landed in: ADR-020 (one container everywhere, Functions and Lambda dropped, Cosmos and DynamoDB optional behind triggers, SQLite on a mounted volume or a Litestream replica), `deploy/docker/`, `docs/DEPLOY-DOCKER.md`, the own-server path in `docs/AGENT-INSTALL.md`, a start script that knows about mounted volumes, and a CI check that starts the image with one.

"aca" lightly cleaned from "acs".

### Reprocess the wiki, build export and OAuth, deploy to Azure, and let agents install it

> "reprocess the wiki we added, add the data in the updated wiki. build the export. data should be owned by users and be reprocessable. export can work globally or by root. add oauth. add a few extra queries. build instructions to deploy on azure, build the cli in various systems. instructions to clone and deploy must be easy to follow. add instructions for agents to clone and deploy, most users will do it this way. agents should ask where to deploy and follow up with keys or auth."

Lightly cleaned from bullet points. Landed in:

1. The peptide wiki seed, extended for stacks, citations and mixing notes, and rerun: 96 pages, 2 collections.
2. ADR-016 and `cairn export` and `cairn import`.
3. ADR-017, the OAuth server, console sign-in and `cairn login`.
4. Fourteen eval queries, q03 to q16.
5. ADR-018, the Dockerfile, `deploy/azure/` and `docs/DEPLOY-AZURE.md`. The CLI builds for every OS were already in place (ADR-014).
6. ADR-019, `docs/AGENT-INSTALL.md` and `AGENTS.md`, and a README that leads with "let your agent do it".

### Free for anyone, but not for profit

> "done authenticating. change the license, i want anyone to be able to use, change and do whatever BUT not for profit"

Landed in: ADR-015 (PolyForm Noncommercial 1.0.0), `LICENSE`, the licence fields, "source-available" in place of "open source", PRD risk R6, and the first push. The AGPL choice above was never published.

### The public repository

> "i created the public repo at: https://github.com/vespassassina/cairn"

Asked before the first push, the owner chose:

1. Commits carry the GitHub no-reply address, not a personal email.
2. The licence is AGPL-3.0. Replaced before the push by the next entry.

Landed in: the rewritten commit authorship.

### Commit, then make the CLI build for Windows, macOS and Linux

> "commit this, then question: make sure we can build the cli for win/mac/linux and docs explain it clearly"

Landed in: commit `bcf303d`, ADR-014, `pnpm build:cli`, `pnpm smoke:cli`, the CI workflow, and `docs/CLI.md`.

### Write it down, then start

> "write then start working"

Landed in: ADR-013, the REST API with its changes feed, the `cairn` CLI and skill, and a measured context cost in the README.

### Keep the tagline; add an API next to MCP

> "i love the: a wiki and tables your agents can write to, with every change reviewable. we keep this. anything i could pivot this to make it more useful, and slightly different from everything out there? What about adding an API next to the MCP, and the API can be a tool and require less context?"

Landed in:

1. The tagline, in the PRD and the README.
2. ADR-013: MCP, REST and a CLI with a skill file, over one core, with a changes feed.
3. The roadmap: provenance (`sources` on writes), freshness (`verified_at`), and a sync design built on the revision log, in that order after the three surfaces.

Not taken, and why: fact extraction from conversations (it fills the wiki with fragments nobody reads), per-agent access control, and bundled embeddings.

### Review the project before publishing

> "review the project, goals, ideas and status. validate if it makes sense, if there are any obvious failures or it is 'just another repo' (check hacker news for similar projects). my goal is to build something simple, that is useful to me and many, can run local/azure/aws practically for free and can be deployed by anyone (hence the docs). i will publish this as opensource on github and advertise on hacker news. The basic idea is to have a good, fast, structured, safe repo of information and memories and 'stuff' to be shared between multiple agents, online and offline."

Landed in: the landscape and launch findings in the changelog, PRD section 1 and section 13, and a launch checklist in the roadmap.

### Build the live summary

> "build the live summary"

Landed in: ADR-012. The server instructions now end with what the workspace holds: collections with row counts, top-level pages with their size, and common tags.

### Use Cairn from every session, and advertise what it holds

> "can we amend the main claude guide to use cairn when available? is cairn advertising the topics/projects it holds?"

Landed in:

1. The owner's global Claude Code instructions (outside this repo): a short section saying to check Cairn before answering on topics with history, save what lasts, never store secrets, and carry on without it when the server is down.
2. Advertising topics: at the time, not yet, because the instructions were fixed text. Proposed, then built on the owner's go-ahead (next entry).

### Keep logs of instructions, failures, lessons and decisions

> "we need to keep a log of instructions, failures and lessons learned. we need to keep a log of decisions. this will be open source so it needs to be properly documented"

Landed in:

1. This file, for instructions.
2. `docs/LESSONS.md`, for failures and lessons, backfilled from the start of the project.
3. `docs/decisions/`, which already held the decisions.
4. `docs/README.md`, a map of which document answers which question.
5. CLAUDE.md, whose documentation discipline now names all four logs.

### Tell Claude when to use Cairn, and make it run

> "add server instructions then check why i cannot run it, i tried it returns an error and adding mcp returns no mcp"

Landed in: ADR-011 (server instructions), and fixes logged in `docs/LESSONS.md` (port in use, IPv6 loopback, MCP added mid-session).

### What next, and is the MCP use automatic?

Summary: the owner asked whether to add the MCP server and whether Claude would use it on its own. The answer was that tools are available but not required, which led to the server instructions above.

Landed in: ADR-011.

### No token on localhost

> "when in localhost, can we skip the token? if domain is localhost or anything local (can be added to a config file) not auth required"

Landed in: ADR-010, `cairn.config.json`, commit `5d52bb8`.

### The console does not work at localhost

> "not working at localhost"

Landed in: launcher and database path fixes, `docs/LESSONS.md`, commit `5d52bb8`.

### Commit the work

> "Commit the working tree changes with a sensible message."

Landed in: commits from `1519596` onwards. Commits are made when the owner asks, not automatically.

### Track every change, decision and design direction

> "track all changes, decisions and design directions we take. let's never forget the what and the why. also keep the docs (blueprints, prd, roadmap etc) updated and aligned"

Landed in: `docs/CHANGELOG.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, and the documentation discipline section of CLAUDE.md. Commit `1519596`.

### Agents write without approval, and the console uses artifactkit

> "auto write, we are safe with versioning. we also add a small review screen. also the html on the server side should/could use my artifactkit for styling"

Landed in: ADR-008 (agents write directly, every write is a revision) and ADR-009 (review console, styled with artifactkit).

### A small server-side interface, wiki-like, versioned

> "it would be nice to have a small interface serverside to review, navigate, edit and add content. what would be the ideal UI here? wikilike? always in read mode and a button to edit. versioned records (applies to agents too)."

Landed in: ADR-008 (revisions for pages and rows, for every actor) and ADR-009 (read mode by default, Edit button, no rich editor).

## 2026-09-11

### Seed with the peptide wiki

Summary: the owner named their peptide wiki folder as the real content to test with.

Landed in: `examples/peptide-wiki`, a seed script that reads the wiki's source JSON rather than its HTML, because the HTML pages are filled in by JavaScript and carry little static text. Commit `ed2f1f3`.

### A quick local PoC

> "plan for a quick PoC version to run locally and start testing features"

The owner chose Claude Code as the first client, and content imported from a real folder of Markdown.

Landed in: the local PoC (commit `d9419b6`) and `docs/LOCAL.md`.

### The adapter architecture: six directions

The owner asked whether an adapter architecture could deploy to AWS, Azure or local while keeping the free tiers, then settled it:

> "1 - split adapters. search and storage. 2 - ok - derived data can always be rebuilt 3 - agreed no transaction across docs, imply eventual consistency 4 - agreed, collections queries in core and a flag to pushdown to the database. 5 - we need to settle for the lowest common denominator of the 2. if hono solves and is available for both, let's use it? 6 - yes, but let's keep it small. update the docs then start building"

Landed in:

1. Directions 1 to 4: ADR-005 (adapter boundary).
2. Direction 5: ADR-006 (Hono, stateless MCP transport, lowest common denominator).
3. Direction 6: ADR-007 (one small OAuth server in front of any OIDC provider).

### Project Cairn: memory for the agents

> "Project Cairn - memory for the agents"

The first build session, working from the PRD below. The owner then pointed the session at this repository's folder.

Landed in: the repository.

## 2026-09-10

### Design discussion: PRD v0.1

Summary: before the build sessions, the owner framed Cairn as memory for AI agents: a self-hosted document and collection store with Claude as the primary client over MCP, deployable to Azure, AWS or a single container while staying within free tiers. The original wording of that discussion was not kept; the PRD is the record.

Landed in: `docs/PRD.md` v0.1 and ADR-001 to ADR-004.
