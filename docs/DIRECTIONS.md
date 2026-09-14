# Owner directions

The instructions and design directions the project owner has given, in the order they were given, with where each one landed. Newest first.

Why this exists: most of Cairn is built with an AI agent, working from short instructions. The ADRs record the decisions that came out of them and the changelog records the work, but neither keeps the original ask. Without it, a reader cannot tell a choice the owner made from one the agent made while filling in the gaps. This log keeps that line visible.

Rules:

1. One entry per direction, logged in the same commit as the work it started. A direction that changed nothing yet still gets an entry.
2. Quote the owner's words where they carry the intent, lightly cleaned for typos. Otherwise summarise, and say it is a summary.
3. Every entry says where it landed: an ADR, a doc, a commit, or "not yet".
4. A later direction that reverses an earlier one does not edit it. Add the new one and point back.

## 2026-09-14

### The CLI knows every instance, uses the best, and catches up on start

> "allow cli to know all the endpoints and use the best. when starting check for sync from cloud if someone has changed something. and sync local"

A follow-up to the direction below, refining the same roadmap item. Landed in: the roadmap item "Named instances, kept in sync", whose notes now include both. Not built yet.

### Sync as backup and a hybrid service across clouds

> "add to the features : use sync as a backup/ha strategy, allow cairn cli to register multiple instances and keep them synced regularly, for example work local and sync remote every x minutes (or hours to keep cost low) so we have a hybrid service running cross cloud using the same atomic unit"

"The same atomic unit" is the one container every deployment runs (ADR-020). Landed in: a new roadmap item, "Named instances, kept in sync", marked next. Not built yet; it needs an ADR first, since ADR-023 covers only two Cairns.

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
