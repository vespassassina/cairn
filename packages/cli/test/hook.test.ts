import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hookInstalled, HOOK_TAG, installHook, settingsPath, uninstallHook } from "../src/hook.js";

/**
 * `cairn hook install/uninstall` (ADR-053, presence.md acceptance criteria
 * 1-4): the settings file is the person's own, so every test checks that
 * unrelated keys survive untouched, not just that the tagged entry appears.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-hook-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const path = () => settingsPath(dir);

describe("installHook", () => {
  it("creates the settings file when none exists", async () => {
    const result = await installHook(path(), { stderr: () => undefined }, true);
    expect(result).toEqual({ outcome: "installed", existed: false });
    expect(await hookInstalled(path())).toBe(true);
    const settings = JSON.parse(await readFile(path(), "utf8"));
    const entry = settings.hooks.SessionStart[0].hooks[0];
    expect(entry._cairn).toBe(HOOK_TAG);
    expect(entry.command).toBe("cairn overview --brief");
  });

  it("adds to an existing settings file, keeping every other key", async () => {
    await mkdir(dirname(path()), { recursive: true });
    await writeFile(
      path(),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] }, otherSetting: "keep me" }, null, 2),
      "utf8",
    );
    const result = await installHook(path(), { stderr: () => undefined }, true);
    expect(result).toEqual({ outcome: "installed", existed: true });
    const settings = JSON.parse(await readFile(path(), "utf8"));
    expect(settings.otherSetting).toBe("keep me");
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("echo hi");
  });

  it("is idempotent: installing twice leaves one tagged entry", async () => {
    await installHook(path(), { stderr: () => undefined }, true);
    const second = await installHook(path(), { stderr: () => undefined }, true);
    expect(second).toEqual({ outcome: "already-installed" });
    const settings = JSON.parse(await readFile(path(), "utf8"));
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it("asks before writing, and does not write on a decline", async () => {
    const result = await installHook(path(), { ask: async () => "n", stderr: () => undefined }, false);
    expect(result).toEqual({ outcome: "declined" });
    expect(await hookInstalled(path())).toBe(false);
  });

  it("writes when the person answers yes", async () => {
    const result = await installHook(path(), { ask: async () => "y", stderr: () => undefined }, false);
    expect(result).toEqual({ outcome: "installed", existed: false });
    expect(await hookInstalled(path())).toBe(true);
  });
});

describe("uninstallHook", () => {
  it("removes the tagged entry, leaving the rest of the file unchanged", async () => {
    await mkdir(dirname(path()), { recursive: true });
    await writeFile(
      path(),
      JSON.stringify(
        { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } },
        null,
        2,
      ),
      "utf8",
    );
    await installHook(path(), { stderr: () => undefined }, true);
    const removed = await uninstallHook(path());
    expect(removed).toBe(true);
    const settings = JSON.parse(await readFile(path(), "utf8"));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("echo hi");
    expect(await hookInstalled(path())).toBe(false);
  });

  it("removes the SessionStart key entirely when it becomes empty", async () => {
    await installHook(path(), { stderr: () => undefined }, true);
    await uninstallHook(path());
    const settings = JSON.parse(await readFile(path(), "utf8"));
    expect(settings.hooks?.SessionStart).toBeUndefined();
  });

  it("reports false when nothing was installed", async () => {
    expect(await uninstallHook(path())).toBe(false);
  });
});
