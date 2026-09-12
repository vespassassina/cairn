#!/usr/bin/env node
import { run } from "./main.js";

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
});
process.exitCode = code;
