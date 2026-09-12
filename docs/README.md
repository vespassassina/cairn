# Documentation

Where to find what. Cairn is built in the open, mostly by an AI agent working from the owner's instructions, so the docs keep the reasoning as well as the result: what was asked, what was decided, what changed, and what went wrong.

## Start here

1. `../README.md`. What Cairn is, and the three commands to run it.
2. `LOCAL.md`. Running it on your machine, connecting Claude Code, and the review console.
3. `CLI.md`. Installing the `cairn` command on Windows, macOS or Linux, and teaching Claude Code to use it.
4. `PRD.md`. What Cairn is for, who it is for, the MCP tools, the requirements, and the risks.
5. `ARCHITECTURE.md`. How it is built today: packages, the two adapter ports, the kinds of data, and the write path.

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

## Rules for keeping them

Set in `../CLAUDE.md`, under documentation discipline. In short:

1. Update the docs in the same commit as the code.
2. Never edit a decision away. Supersede it with a new ADR.
3. When a doc and the code disagree, that is a bug. Fix whichever is wrong, and say which in the changelog.
4. Plain, direct writing. Short paragraphs, sentence case headings, numbered lists, no em dashes.
