#!/usr/bin/env node
import { spawn } from "node:child_process";
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
});
process.exitCode = code;
