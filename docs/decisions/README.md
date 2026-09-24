# Decisions

Architecture decision records. One file per decision, numbered, never renumbered.

A decision that changes is not edited away. Add a new ADR that supersedes it, and mark the old one `Status: superseded by ADR-NNN` with a line saying why. The history of why we changed our minds is worth as much as the current answer.

## Index

| ADR | Decision | Status | Date |
|---|---|---|---|
| [001](ADR-001.md) | MCP server is the primary interface | accepted, refined by 013 | 2026-09-10 |
| [002](ADR-002.md) | Graph as edge documents, no Gremlin | accepted | 2026-09-10 |
| [003](ADR-003.md) | Bring-your-own embeddings endpoint | superseded as the default by 022 | 2026-09-10 |
| [004](ADR-004.md) | Separate chunks store, vector container created on enable | accepted, model change amended by 022 | 2026-09-10 |
| [005](ADR-005.md) | Adapter boundary: search separate, derived data rebuildable, no cross-document transactions | accepted | 2026-09-11 |
| [006](ADR-006.md) | Hono plus stateless MCP transport, lowest common denominator | accepted, runtime targets superseded by 020 | 2026-09-11 |
| [007](ADR-007.md) | Auth is one small OAuth server in front of any OIDC provider | accepted, amended by 017 | 2026-09-11 |
| [008](ADR-008.md) | Every write is a revision, and agents write directly | accepted | 2026-09-12 |
| [009](ADR-009.md) | A server-rendered review console, styled with artifactkit | accepted, rule 5 amended by 010, extended by 056 | 2026-09-12 |
| [010](ADR-010.md) | No sign-in for trusted local requests | accepted | 2026-09-12 |
| [011](ADR-011.md) | Cairn tells clients when to use it | accepted, extended by 012 | 2026-09-12 |
| [012](ADR-012.md) | The server instructions carry a live summary of the workspace | accepted, amended by 055 | 2026-09-12 |
| [013](ADR-013.md) | One core, three surfaces: MCP, REST and a CLI | accepted, extended by 058 | 2026-09-12 |
| [014](ADR-014.md) | The CLI ships as an npm package and as standalone executables | accepted | 2026-09-12 |
| [015](ADR-015.md) | Source-available under PolyForm Noncommercial 1.0.0 | accepted | 2026-09-12 |
| [016](ADR-016.md) | Export is a folder of Markdown and JSON that imports back without loss | accepted | 2026-09-12 |
| [017](ADR-017.md) | The OAuth server as built | accepted, amends 007 | 2026-09-12 |
| [018](ADR-018.md) | The first Azure deployment: Container Apps with Litestream | accepted, decision 6 superseded by 020 | 2026-09-12 |
| [019](ADR-019.md) | Installation is written for an agent to follow, with the person at the checkpoints | accepted | 2026-09-12 |
| [020](ADR-020.md) | One container everywhere, as small as it can be, with SQLite on a mounted volume or a replica | accepted, supersedes parts of 006 and 018 | 2026-09-12 |
| [021](ADR-021.md) | Keyword search returns pages that hold most of the query's words, stemmed | accepted, amended by 025 and 057 | 2026-09-12 |
| [022](ADR-022.md) | Vector search in SQLite with sqlite-vec, and a small English model inside the container | accepted, supersedes 003 as the default | 2026-09-13 |
| [023](ADR-023.md) | Two Cairns sync through the cairn command, by comparing each record with the last sync | accepted, amended by 024, extended by 029 and 030 | 2026-09-13 |
| [024](ADR-024.md) | Collections sit in the page tree, and relation fields are links | accepted | 2026-09-13 |
| [025](ADR-025.md) | Headings weigh more than text, and a search for a page's exact title finds that page first | accepted, amends 021, amended by 057 | 2026-09-13 |
| [026](ADR-026.md) | A collection is a top-level page and its tree; typed tables are tables | accepted, amends 009 and 024 | 2026-09-13 |
| [027](ADR-027.md) | Pages and rows keep a list of sources | accepted | 2026-09-14 |
| [028](ADR-028.md) | Pages record when their facts were last verified | accepted | 2026-09-14 |
| [029](ADR-029.md) | The CLI keeps several named Cairns as one | accepted | 2026-09-14 |
| [030](ADR-030.md) | Sync orders edits by when they were made, and merges both sides the way git does | accepted, extends 023 | 2026-09-14 |
| [031](ADR-031.md) | Agents run Cairn from a guide written for them, checked against the code, and the code guides them too | accepted, extends 019 | 2026-09-14 |
| [032](ADR-032.md) | A collection can be published, read-only and without sign-in | accepted, amends 017 | 2026-09-14 |
| [033](ADR-033.md) | A refresh token answers a repeat for one minute before it counts as theft | accepted, amended by 054 | 2026-09-14 |
| [034](ADR-034.md) | A public Cairn describes itself at /.well-known/cairn.json | accepted | 2026-09-14 |
| [035](ADR-035.md) | cairn export can write a static site, no server required | accepted | 2026-09-14 |
| [036](ADR-036.md) | cairn check-sources reports dead links and recognises DOIs and PubMed ids | accepted | 2026-09-15 |
| [037](ADR-037.md) | A Cairn's trusted friends are rows in a table, not a registry | accepted | 2026-09-15 |
| [038](ADR-038.md) | A link to another Cairn's page is an edge, by its address alone | accepted | 2026-09-15 |
| [039](ADR-039.md) | A published page's sources are also JSON-LD, for machines to follow | accepted | 2026-09-15 |
| [040](ADR-040.md) | A Cairn accepts a citation notice, Webmention-shaped, from a trusted address or on review | accepted | 2026-09-15 |
| [041](ADR-041.md) | Discovery by following citations | accepted | 2026-09-15 |
| [042](ADR-042.md) | A negated keyword match does not count | accepted | 2026-09-15 |
| [043](ADR-043.md) | AWS and GCP run the same Docker path as Proxmox, not a managed container service | accepted | 2026-09-15 |
| [044](ADR-044.md) | The project's name is Cairn, with no dedicated domain | accepted | 2026-09-15 |
| [045](ADR-045.md) | Restore reaches REST and the CLI, MCP keeps its own way | accepted | 2026-09-15 |
| [046](ADR-046.md) | Cairn never starts on a database it cannot vouch for | accepted | 2026-09-16 |
| [047](ADR-047.md) | A deploy names the image by digest, and says when it changes nothing | accepted | 2026-09-16 |
| [048](ADR-048.md) | Cairn stops on purpose, inside the time the platform allows | accepted, extends 046 | 2026-09-16 |
| [049](ADR-049.md) | A backup is a whole database, taken because something changed | accepted | 2026-09-16 |
| [050](ADR-050.md) | Backups go to the platform's own object storage, named by one setting | accepted, completes 049 | 2026-09-16 |
| [051](ADR-051.md) | Cairn climbs down a ladder before it starts, and stops when it runs out of rungs | accepted, extends 046 | 2026-09-16 |
| [052](ADR-052.md) | A pair of Cairns is offered a schedule the moment it becomes a pair | accepted, extends 029 | 2026-09-16 |
| [053](ADR-053.md) | Cairn makes itself present, or it is not memory | accepted | 2026-09-16 |
| [054](ADR-054.md) | A sign-in survives a lost race and a slow start | accepted, amends 033 | 2026-09-16 |
| [055](ADR-055.md) | The workspace summary gets its own budget, not the leftovers | accepted, amends 012 | 2026-09-16 |
| [056](ADR-056.md) | The console is readable on a phone | accepted, extends 009 | 2026-09-16 |
| [057](ADR-057.md) | A search result names each page once | accepted, amends 021 and 025 | 2026-09-16 |
| [058](ADR-058.md) | An agent can walk the tree, and MCP catches up with the other two surfaces | accepted, extends 013 | 2026-09-16 |
| [059](ADR-059.md) | Undelete, a deleted-pages list, and per-page vacuum | accepted, cause of the 2026-09-17 loss corrected by 060, confirmed by 061 | 2026-09-18 |
| [060](ADR-060.md) | `cairn sync` never deletes a page it cannot prove was deleted | accepted | 2026-09-18 |
| [061](ADR-061.md) | The Azure losses were Litestream issue #1515, a confirmed upstream bug with no fix released | accepted | 2026-09-18 |
| [062](ADR-062.md) | Mitigate the Litestream stall with a tighter backup cooldown and a source build of the unmerged fix | backup cooldown accepted, source build superseded by 063 | 2026-09-18 |
| [063](ADR-063.md) | Revert the source-built Litestream, its first restore corrupted a snapshot and lost data | accepted | 2026-09-18 |
| [064](ADR-064.md) | Attachments are rows plus content-addressed blobs, uploaded direct | accepted | 2026-09-19 |
| [065](ADR-065.md) | Mermaid, Vega-Lite and Viz.js are the text-form visualizations; everything else is an attachment | accepted | 2026-09-19 |
| [066](ADR-066.md) | A published subtree can be gated by a named token | accepted | 2026-09-19 |
| [067](ADR-067.md) | A guest is an email address, proven against a provider Cairn already trusts | accepted, design only, deferred | 2026-09-19 |
| [068](ADR-068.md) | jSquash is the WASM codec for attachment thumbnails | accepted, GIF part superseded by 069 | 2026-09-23 |
| [069](ADR-069.md) | GIF is dropped from attachment thumbnails; `@jsquash/gif` does not exist | accepted | 2026-09-23 |
| [070](ADR-070.md) | A sync conflicts list in the console, derived from history | accepted, Context corrected by 071 | 2026-09-23 |
| [071](ADR-071.md) | ADR-070's "three note shapes" was wrong; there are two, and that's complete | accepted | 2026-09-23 |
| [072](ADR-072.md) | The vector margin miss on q17 is an accepted limitation, not a bug | accepted | 2026-09-23 |
| [073](ADR-073.md) | Stale-page reviews reach MCP, REST and the CLI, not just the console | accepted | 2026-09-23 |
| [074](ADR-074.md) | Publish and unpublish notify IndexNow, opt-in | accepted | 2026-09-23 |
| [075](ADR-075.md) | Templates and daily notes are pages with a shape | accepted | 2026-09-23 |
| [076](ADR-076.md) | A quoted phrase in a search query asks FTS5 for NEAR proximity, fixed at distance 10 | accepted | 2026-09-24 |
| [077](ADR-077.md) | Per-collection search synonyms, a dedicated store, expanded workspace-wide at query time | accepted | 2026-09-24 |

## Writing one

1. Copy the shape of an existing ADR: context, decision, consequences.
2. Context says what forced the decision and what the options were.
3. Decision says what we chose, specifically enough to check code against.
4. Consequences says what this makes easier, harder, or still open.
5. Add it to the index above and to `docs/CHANGELOG.md` in the same commit.
