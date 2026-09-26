# Documentation

Where to find what. Cairn is built in the open, mostly by an AI agent working from the owner's instructions, so the docs keep the reasoning as well as the result: what was asked, what was decided, what changed, and what went wrong.

## Start here

1. `../README.md`. What Cairn is, and the three commands to run it.
2. `LOCAL.md`. Running it on your machine, connecting Claude Code, and the review console.
3. `CLI.md`. Installing the `cairn` command on Windows, macOS or Linux, and teaching Claude Code to use it.
4. `DEPLOY-DOCKER.md`. Running Cairn on your own server, such as a NAS, with the database on a local disk.
5. `DEPLOY-PROXMOX.md`. The same, specifically on Proxmox: VM or LXC, and where the disk lives.
6. `DEPLOY-AZURE.md`. Putting Cairn on Azure with sign-in, connecting Claude from anywhere, and running it day to day.
7. `DEPLOY-AWS.md` and `DEPLOY-GCP.md`. A small cloud VM running the same Docker setup as your own server (ADR-043).
8. `AGENT-INSTALL.md`. The same installs, written for a coding agent to follow with you at the checkpoints.
9. `AGENT-OPERATE.md`. Configuring and running a Cairn, for a coding agent: every setting, updates, sync, backups, access and troubleshooting. A test keeps it in step with the code.
10. `PRD.md`. What Cairn is for, who it is for, the MCP tools, the requirements, and the risks.
11. `ARCHITECTURE.md`. How it is built today: packages, the two adapter ports, the kinds of data, and the write path.

## The four logs

Each answers a different question. Together they mean nothing about the project's history depends on anyone's memory.

| Log | Answers | Entries look like |
|---|---|---|
| `DIRECTIONS.md` | What did the owner ask for? | The owner's words, and where they landed |
| `decisions/` | What did we decide, and why? | One ADR per decision, with context, options and consequences |
| `CHANGELOG.md` | What changed, and why? | Added, changed, fixed, decision, finding |
| `LESSONS.md` | What went wrong, and what did we learn? | What happened, cause, fix, lesson |

How one thing flows through them: the owner asks for something (a direction). If it constrains future work, it becomes an ADR. The work that follows gets a changelog entry. Anything that breaks along the way gets a lesson.

## Status

`ROADMAP.md`. What is done, in progress and next, and what gates each phase.

## Work not yet built

`specs/`. One file per piece of work that has been decided but not written. An ADR says what was decided and why; a spec says what has to exist for that decision to be true, and how anyone can tell whether it is. Each carries numbered acceptance criteria, the hard rules that bear on it, and its open questions. `specs/README.md` indexes them.

## Rules for keeping them

Set in `../CLAUDE.md`, under documentation discipline. In short:

1. Update the docs in the same commit as the code.
2. Never edit a decision away. Supersede it with a new ADR.
3. When a doc and the code disagree, that is a bug. Fix whichever is wrong, and say which in the changelog.
4. Plain, direct writing. Short paragraphs, sentence case headings, numbered lists, no em dashes.
5. Work not yet built has a spec with acceptance criteria and a place in `PLAN.md` before it has code; `HANDOFF.md` exists only while a task is stopped midway.
