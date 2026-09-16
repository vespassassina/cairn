import { join } from "node:path";

/**
 * `cairn sync install` (ADR-029): a job the operating system runs on a
 * schedule, so the registered instances stay in sync with no terminal open.
 *
 * 1. macOS: a launchd agent in ~/Library/LaunchAgents, run at login and then
 *    every interval.
 * 2. Linux: a systemd user service and timer in ~/.config/systemd/user, run a
 *    minute after boot and then every interval.
 * 3. Windows: a scheduled task, every interval.
 *
 * The files are built here as plain text, so they can be printed on a dry run
 * and tested without installing anything. The job carries no token: it signs
 * in with what `cairn login` stored, like any other run.
 */

export interface Job {
  /** The program and its first arguments: this CLI, however it was installed. */
  program: string[];
  everyMs: number;
  /** Environment the job needs to find the same config, never a secret. */
  env: Record<string, string>;
  /** Where the job's output goes. */
  log: string;
}

export const LAUNCHD_LABEL = "dev.cairn.sync";
export const SYSTEMD_UNIT = "cairn-sync";
export const WINDOWS_TASK = "Cairn sync";

/** The variables a job passes on, when set: where the CLI keeps its files. */
export const PASSED_ENV = ["CAIRN_CREDENTIALS", "XDG_CONFIG_HOME"] as const;

const xml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function launchdPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function launchdPlist(job: Job): string {
  const strings = (items: string[]) => items.map((item) => `    <string>${xml(item)}</string>`).join("\n");
  const env = Object.entries(job.env)
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    strings([...job.program, "start"]),
    "  </array>",
    "  <key>StartInterval</key>",
    `  <integer>${Math.round(job.everyMs / 1000)}</integer>`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    ...(env ? ["  <key>EnvironmentVariables</key>", "  <dict>", env, "  </dict>"] : []),
    "  <key>StandardOutPath</key>",
    `  <string>${xml(job.log)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${xml(job.log)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function systemdDir(home: string, env: Record<string, string | undefined>): string {
  return join(env["XDG_CONFIG_HOME"] ?? join(home, ".config"), "systemd", "user");
}

/** One argument for ExecStart: quoted, with systemd's own escapes. */
const systemdArg = (arg: string) => `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

export function systemdUnits(job: Job): { service: string; timer: string } {
  const env = Object.entries(job.env).map(([key, value]) => `Environment=${systemdArg(`${key}=${value}`)}`);
  const service = [
    "[Unit]",
    "Description=Keep the local Cairn running and the registered instances in sync (cairn start)",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${[...job.program, "start"].map(systemdArg).join(" ")}`,
    ...env,
    `StandardOutput=append:${job.log}`,
    `StandardError=append:${job.log}`,
    "",
  ].join("\n");
  const seconds = Math.round(job.everyMs / 1000);
  const timer = [
    "[Unit]",
    "Description=Run cairn start on a schedule",
    "",
    "[Timer]",
    "OnBootSec=1min",
    `OnUnitActiveSec=${seconds}s`,
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return { service, timer };
}

/** A Windows command line argument, quoted when it needs to be. */
const windowsArg = (arg: string) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg);

/**
 * The arguments to `schtasks /Create`. Task Scheduler counts in minutes, so
 * the interval is rounded up to one; whole hours use an hourly schedule.
 * It cannot set environment variables, so a job that needs one says so.
 */
export function schtasksArgs(job: Job): string[] {
  const minutes = Math.max(1, Math.ceil(job.everyMs / 60_000));
  const schedule = minutes % 60 === 0 ? ["/SC", "HOURLY", "/MO", String(minutes / 60)] : ["/SC", "MINUTE", "/MO", String(minutes)];
  if (minutes > 1439 && minutes % 60 !== 0) throw new Error("on Windows, an interval over a day must be whole hours");
  const run = [...job.program, "start"].map(windowsArg).join(" ");
  return ["/Create", "/F", "/TN", WINDOWS_TASK, ...schedule, "/TR", run];
}

/** How the interval reads back to a person. */
export function describeInterval(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}
