#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { run } from "./main.js";

/** The OS's own way to open a URL. No shell, so the URL cannot be misread. */
async function openBrowser(url: string): Promise<void> {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["explorer.exe", [url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
}

/** Runs a program with no shell and waits, for cairn sync install. */
function exec(command: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("error", (error) => resolve({ code: 127, output: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

/**
 * Starts an instance's start command, left running after cairn exits. It is
 * the owner's own command from instances.json, so it runs through the shell.
 */
async function launch(command: string, log: string): Promise<void> {
  await mkdir(dirname(log), { recursive: true });
  const file = await open(log, "a");
  const child = spawn(command, { shell: true, detached: true, stdio: ["ignore", file.fd, file.fd] });
  child.on("error", () => undefined);
  child.unref();
  await file.close();
}

/**
 * How a scheduled job runs this CLI again: the executable itself, or Node or
 * Bun with this script. Not from source, where the script is TypeScript.
 */
async function self(): Promise<string[]> {
  const runtime = basename(process.execPath).toLowerCase().replace(/\.exe$/, "");
  if (runtime !== "node" && runtime !== "bun") return [process.execPath];
  const script = await realpath(process.argv[1] ?? "");
  if (script.endsWith(".ts")) {
    throw new Error("this is cairn running from source. Install it first (pnpm build, then npm install -g ./packages/cli) and run that");
  }
  return [process.execPath, script];
}

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return chunks.length === 0 ? null : Buffer.concat(chunks).toString("utf8");
}

const code = await run(process.argv.slice(2), {
  fetch: (request) => fetch(request),
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  stdin: readStdin,
  openBrowser,
  exec,
  launch,
  self,
});
process.exitCode = code;
