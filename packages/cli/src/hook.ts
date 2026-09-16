import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * `cairn hook install` (ADR-053): a Claude Code SessionStart hook that runs
 * `cairn overview --brief`, so a fresh session starts knowing what the
 * workspace holds instead of only finding out once a tool happens to be
 * called.
 *
 * The settings file is not Cairn's own, so every write here is conservative:
 * read what is there, change only the `hooks.SessionStart` list, and leave
 * every other key byte-identical. The entry this CLI writes carries a private
 * `_cairn` tag, so it can be found again even if the person edits the command
 * text; only that tag, never the command string, is what `install` and
 * `uninstall` match on.
 */

export const HOOK_TAG = "cairn-overview";
const HOOK_COMMAND = "cairn overview --brief";

export function settingsPath(home: string): string {
  return join(home, ".claude", "settings.json");
}

interface HookEntry {
  type: "command";
  command: string;
  _cairn?: string;
}

interface Matcher {
  hooks: HookEntry[];
  [key: string]: unknown;
}

interface Settings {
  hooks?: Record<string, Matcher[]>;
  [key: string]: unknown;
}

class MalformedSettings extends Error {}

async function readSettings(path: string): Promise<{ settings: Settings; existed: boolean }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, existed: false };
    throw error;
  }
  try {
    return { settings: JSON.parse(text) as Settings, existed: true };
  } catch {
    throw new MalformedSettings(`${path} is not valid JSON, so nothing was written. Fix or move it, then run cairn hook install again`);
  }
}

async function writeSettings(path: string, settings: Settings): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function findEntry(settings: Settings): HookEntry | undefined {
  for (const matcher of settings.hooks?.["SessionStart"] ?? []) {
    const found = matcher.hooks.find((hook) => hook._cairn === HOOK_TAG);
    if (found) return found;
  }
  return undefined;
}

export async function hookInstalled(path: string): Promise<boolean> {
  const { settings } = await readSettings(path).catch(() => ({ settings: {} as Settings }));
  return findEntry(settings) !== undefined;
}

export interface HookAsk {
  ask?: (question: string) => Promise<string | null>;
  stderr: (text: string) => void;
}

export type InstallResult =
  | { outcome: "installed"; existed: boolean }
  | { outcome: "already-installed" }
  | { outcome: "declined" }
  | { outcome: "no-answer" };

/**
 * Adds the tagged SessionStart entry, after printing the exact change and
 * asking, the same shape `cairn sync install` already uses. `yes` skips the
 * question for an unattended install.
 */
export async function installHook(path: string, io: HookAsk, yes: boolean): Promise<InstallResult> {
  const { settings, existed } = await readSettings(path);
  if (findEntry(settings)) return { outcome: "already-installed" };

  const entry: HookEntry = { type: "command", command: HOOK_COMMAND, _cairn: HOOK_TAG };
  const sessionStart = [...(settings.hooks?.["SessionStart"] ?? []), { hooks: [entry] }];
  const next: Settings = { ...settings, hooks: { ...settings.hooks, SessionStart: sessionStart } };

  io.stderr(
    `${existed ? "adding to" : "creating"} ${path}, a SessionStart hook running "${HOOK_COMMAND}":\n` +
      `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [entry] }] } }, null, 2)}\n`,
  );
  if (!yes) {
    const answer = io.ask ? await io.ask("Write it? [y/N] ") : null;
    if (answer === null) return { outcome: "no-answer" };
    if (!/^y(es)?$/i.test(answer.trim())) return { outcome: "declined" };
  }
  await writeSettings(path, next);
  return { outcome: "installed", existed };
}

/** Removes the tagged entry only, leaving every other key untouched. */
export async function uninstallHook(path: string): Promise<boolean> {
  const { settings } = await readSettings(path);
  const sessionStart = settings.hooks?.["SessionStart"];
  if (!sessionStart) return false;

  let found = false;
  const next = sessionStart
    .map((matcher) => ({
      ...matcher,
      hooks: matcher.hooks.filter((hook) => {
        const mine = hook._cairn === HOOK_TAG;
        if (mine) found = true;
        return !mine;
      }),
    }))
    .filter((matcher) => matcher.hooks.length > 0);
  if (!found) return false;

  const hooks: Record<string, Matcher[]> = { ...settings.hooks, SessionStart: next };
  if (next.length === 0) delete hooks["SessionStart"];
  await writeSettings(path, { ...settings, hooks });
  return true;
}
