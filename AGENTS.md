# AGENTS.md

Instructions for coding agents (Codex, Cursor, Claude Code and others) working in this repository.

## If you were asked to configure or run a Cairn that is already installed

Follow `docs/AGENT-OPERATE.md`: settings, health checks, updates, sync between Cairns, backups, access and troubleshooting, with the same rules about credentials.

## If you were asked to install or deploy Cairn

Follow `docs/AGENT-INSTALL.md` from the top. It tells you what to ask first (on this computer or on Azure), how to keep the person's credentials out of the chat, and how to check each step. Do not change code while installing.

## If you were asked to work on Cairn itself

Read `CLAUDE.md`: the project's rules, stack, documentation discipline and way of working apply to every agent, not only Claude. In short: design, spec and plan before a major feature, with the owner's yes on both; a failing test before each task; one sprint at a time from `docs/PLAN.md`; verify for real and show the evidence; the four logs in the same commit as the work; commit to `main` and push, with the no-reply author.
