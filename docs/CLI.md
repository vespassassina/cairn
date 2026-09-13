# Installing the cairn command

`cairn` is the command-line way into Cairn, for you and for agents with a shell, such as Claude Code or Codex. It talks to a running Cairn server over HTTP, so the same command works against Cairn on your machine or in the cloud. For why it exists and what it costs an agent, see ADR-013.

It runs on Windows, macOS and Linux (ADR-014). Pick one way to install it:

1. **Download a ready-made executable.** Nothing else needed. Best for most people.
2. **Install it with npm.** Needs Node 22 or later.
3. **Build the executables yourself** from this repository.

Then check it works, point it at your server, and optionally teach Claude Code to use it.

## 1. Download an executable

Executables are attached to each release at https://github.com/vespassassina/cairn/releases, with a `SHA256SUMS` file to check them against. The first release is `v0.1.0`. To run unreleased code from `main`, build them yourself (section 3).

The newest file for your machine is always at the same address, for example on an Apple silicon Mac:

```
curl -LO https://github.com/vespassassina/cairn/releases/latest/download/cairn-darwin-arm64
curl -LO https://github.com/vespassassina/cairn/releases/latest/download/SHA256SUMS
```

Replace `cairn-darwin-arm64` with the file for your machine from the table below. On Windows, PowerShell has `curl.exe` built in, used the same way.

### Which file you need

| Your machine | File |
|---|---|
| Mac with Apple silicon (M1 and later) | `cairn-darwin-arm64` |
| Mac with an Intel chip | `cairn-darwin-x64` |
| Linux on a normal PC or server | `cairn-linux-x64` |
| Linux on Arm, such as a Raspberry Pi 4 or 5 with a 64-bit OS | `cairn-linux-arm64` |
| Windows | `cairn-windows-x64.exe` |

Not sure which chip you have?

1. **macOS or Linux:** run `uname -m`. `arm64` or `aarch64` means Arm; `x86_64` means x64.
2. **Windows:** Settings, System, About, then "System type". Windows on Arm runs the x64 file under emulation.

Linux executables are built for glibc systems such as Ubuntu, Debian, Fedora and Arch. On Alpine or other musl systems, use npm (section 2).

### Check the download

Before installing, compare the file with `SHA256SUMS` from the same release. Run this in the folder holding both.

macOS:

```
shasum -a 256 -c SHA256SUMS --ignore-missing
```

Linux:

```
sha256sum -c SHA256SUMS --ignore-missing
```

Windows, then compare the printed hash with the line for `cairn-windows-x64.exe` in `SHA256SUMS`:

```
Get-FileHash cairn-windows-x64.exe -Algorithm SHA256
```

### macOS

In Terminal, from the folder the file is in. Use `cairn-darwin-x64` instead on an Intel Mac.

```
mv cairn-darwin-arm64 cairn
chmod +x cairn
mkdir -p ~/.local/bin && mv cairn ~/.local/bin/
```

If `~/.local/bin` is not on your PATH yet, add it and open a new terminal:

```
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

If you downloaded the file with a browser, macOS will refuse to open it and say it cannot check the developer. The executables are not signed with an Apple developer account yet (ADR-014 rule 7). Remove the download flag once:

```
xattr -d com.apple.quarantine ~/.local/bin/cairn
```

A file downloaded with `curl` does not get that flag.

### Linux

From the folder the file is in. Use `cairn-linux-arm64` instead on Arm.

```
mv cairn-linux-x64 cairn
chmod +x cairn
mkdir -p ~/.local/bin && mv cairn ~/.local/bin/
```

Most distributions already have `~/.local/bin` on the PATH. If `cairn` is not found in a new terminal, add it:

```
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

### Windows

In PowerShell, from the folder the file is in. This puts it in your own programs folder and adds that folder to your PATH, with no administrator rights needed.

```
$dir = "$env:LOCALAPPDATA\Programs\cairn"
New-Item -ItemType Directory -Force $dir | Out-Null
Move-Item cairn-windows-x64.exe "$dir\cairn.exe"
$path = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable("Path", "$path;$dir", "User")
```

Open a new PowerShell window so it picks up the new PATH.

The first time you run it, Windows may show "Windows protected your PC", because the executable is not signed yet (ADR-014 rule 7). Choose "More info", then "Run anyway". Or clear the download flag first:

```
Unblock-File "$env:LOCALAPPDATA\Programs\cairn\cairn.exe"
```

## 2. Install with npm

With Node 22 or later, on any OS, from this repository:

```
pnpm install
pnpm build
npm install -g ./packages/cli
```

npm puts `cairn` on your PATH, and on Windows it writes the `cairn.cmd` launcher itself. Once the CLI is published to npm, this becomes a single `npm install -g` with the package name.

To remove it: `npm uninstall -g @cairn/cli`.

## 3. Build the executables yourself

You need Node 22 or later and pnpm (`corepack enable` provides it). Bun is used to compile, and if it is not installed the build fetches the pinned version for you.

```
pnpm install
pnpm build:cli
```

That builds all five executables into `dist/cli/`, with a `SHA256SUMS` file, from whichever OS you run it on. To build fewer:

```
pnpm build:cli host
pnpm build:cli linux-x64 windows-x64
```

`host` means the machine you are on. Each file is 60 to 86 MB, because it carries its own runtime.

To test a build against a real server on this machine:

```
pnpm smoke:cli
```

It starts Cairn on port 8797 with an empty database in a temporary folder, runs the executable the way an agent would, and stops the server.

## Check it works

```
cairn -V
cairn overview
```

`cairn -V` prints the version. `cairn overview` needs a running server; without one it says it cannot reach Cairn, which also proves the executable runs.

## Your data: export and import

```
cairn export <folder>                   everything: pages as Markdown, collections as JSON
cairn export <folder> --root <page-id>  one page and everything under it
cairn import <folder> --dry-run         what an import would change
cairn import <folder>                   read an export back in, keeping ids; safe to repeat
```

The format is in ADR-016. On Windows, give folders as you normally would, such as `cairn export C:\Users\you\cairn-backup`.

## Keep two Cairns the same: sync

`cairn sync` keeps two Cairns in step: your laptop and Azure, or your own server and Azure (ADR-023).

```
cairn sync http://localhost:8787 https://your-address --dry-run   what a sync would change
cairn sync http://localhost:8787 https://your-address             sync once
cairn sync http://localhost:8787 https://your-address --every 5m  keep syncing, every 5 minutes
```

1. **Sign in to both first.** `cairn login` with `CAIRN_URL` set to each server that uses OAuth; localhost needs no sign-in. Sync uses those sign-ins, not `CAIRN_TOKEN`.
2. **What it copies:** every page, collection and row, both ways. A change on one side goes to the other, and so does a deletion.
3. **When both sides changed the same record,** the newer edit wins on both, and the edit it replaced stays in that record's history, where the console can restore it. The report lists each one as a conflict.
4. **Moving to a new Cairn** is one sync into an empty one. Ids and links are kept, as with an import.
5. **It remembers the last sync** in a small file per pair of servers, next to the CLI's sign-ins. Deleting it loses nothing: the next run compares everything again and changes only what differs, with one catch. A record deleted on one side since the last sync comes back from the other, because without the file sync cannot tell a deletion from a record the other side never had.
6. **Collections are never deleted by sync;** it warns instead.
7. **`--every`** keeps it running, at least 30 seconds apart, on a machine that stays on. A failed run is reported and tried again next time. Each run reads everything from both sides, which for a personal wiki takes about a second, plus the cold start when a Cairn on Azure was asleep.

## Point it at your server

By default `cairn` talks to `http://localhost:8787`, which is where `pnpm dev` runs Cairn. For another server, set `CAIRN_URL`, and `CAIRN_TOKEN` if that server needs one.

macOS and Linux, for the current terminal, or add the lines to `~/.zshrc` or `~/.bashrc` to keep them:

```
export CAIRN_URL=https://cairn.example.com
export CAIRN_TOKEN=your-token
```

Windows PowerShell, for the current window:

```
$env:CAIRN_URL = "https://cairn.example.com"
```

Windows, kept for new windows:

```
[Environment]::SetEnvironmentVariable("CAIRN_URL", "https://cairn.example.com", "User")
```

Keep the token out of shell history and shared files where you can. A password manager's CLI, or your OS keychain, is a better home for it than a dotfile.

### Signing in to a deployed Cairn

A Cairn on Azure asks everyone to sign in (ADR-017). Instead of a token:

```
cairn login
cairn whoami
cairn logout
```

`cairn login` opens your browser, you sign in and approve the CLI, and it keeps the tokens for that server in `~/.config/cairn/credentials.json` (on Windows, `%APPDATA%\cairn\credentials.json`), readable only by you. They refresh by themselves. `cairn logout` revokes them on the server and forgets them. On a machine with no browser, it prints the address to open elsewhere.

A local Cairn needs no sign-in at all.

## Teach Claude Code to use it

The skill in `skills/cairn` tells Claude Code when and how to use `cairn`: check it before answering, save what lasts, give every write a note. It costs about 115 tokens per session until used.

macOS and Linux:

```
mkdir -p ~/.claude/skills && cp -r skills/cairn ~/.claude/skills/
```

Windows PowerShell:

```
New-Item -ItemType Directory -Force "$HOME\.claude\skills" | Out-Null
Copy-Item -Recurse skills\cairn "$HOME\.claude\skills\"
```

Start a new Claude Code session afterwards. On Windows, Claude Code runs commands through Git Bash, which finds `cairn.exe` on your PATH as `cairn`.

Give an agent the skill or the MCP server, not both, or it pays for both.

## Uninstall

1. Delete the executable: `~/.local/bin/cairn` on macOS and Linux, `%LOCALAPPDATA%\Programs\cairn` on Windows. Remove that folder from your PATH if you added it.
2. Delete the skill folder `~/.claude/skills/cairn`.

## What has been tested where

| File | Status |
|---|---|
| `cairn-darwin-arm64` | Built and smoke-tested on an Apple silicon Mac |
| `cairn-darwin-x64` | Built and smoke-tested on the same Mac under Rosetta |
| `cairn-linux-x64` | Built and smoke-tested by CI on Ubuntu x64 |
| `cairn-linux-arm64` | Built and smoke-tested by CI on Ubuntu Arm |
| `cairn-windows-x64.exe` | Built and smoke-tested by CI on Windows. Every check passed on the first run; the script's own cleanup failed and was fixed (`docs/LESSONS.md`) |

CI builds each executable on its own OS and runs the smoke test on every push: https://github.com/vespassassina/cairn/actions
