import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/main.js";

/**
 * The agent guides are checked against the code (ADR-031), so an agent never
 * follows a setting or a command that no longer exists, and a new setting
 * cannot ship without the operation guide saying what it does.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const GUIDES = ["docs/AGENT-INSTALL.md", "docs/AGENT-OPERATE.md"];

const read = (path: string) => readFile(join(ROOT, path), "utf8");

function all(pattern: RegExp, text: string): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1]!);
}

/** Every CAIRN_ setting the server, the CLI, the image and the deploy files read. */
async function settingsRead(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const pkg of await readdir(join(ROOT, "packages"))) {
    const src = join("packages", pkg, "src");
    const files = await readdir(join(ROOT, src), { recursive: true }).catch(() => [] as string[]);
    for (const file of files.filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))) {
      for (const name of all(/env\["(CAIRN_[A-Z_]+)"\]/g, await read(join(src, file)))) names.add(name);
    }
  }
  for (const file of ["deploy/azure/deploy.sh", "deploy/docker/compose.yaml", "docker/start.sh"]) {
    for (const name of all(/\$\{?(CAIRN_[A-Z_]+)/g, await read(file))) names.add(name);
  }
  for (const name of all(/name: '(CAIRN_[A-Z_]+)'/g, await read("deploy/azure/main.bicep"))) names.add(name);
  return names;
}

/** The text inside code spans and code blocks, where commands and settings are written. */
const code = (markdown: string) => all(/```[a-z]*\n([\s\S]*?)```/g, markdown.replace(/`([^`\n]+)`/g, "```\n$1```"));

describe("the agent guides match the code", () => {
  it("list every setting the code reads, in the operation guide", async () => {
    const guide = await read("docs/AGENT-OPERATE.md");
    const missing = [...(await settingsRead())].filter((name) => !guide.includes(`\`${name}\``));
    expect(missing, "settings the code reads that docs/AGENT-OPERATE.md does not describe").toEqual([]);
  });

  it("name only settings the code reads", async () => {
    const known = await settingsRead();
    for (const path of GUIDES) {
      const named = all(/\b(CAIRN_[A-Z_]+)\b/g, await read(path));
      expect([...new Set(named)].filter((name) => !known.has(name)), `settings in ${path} that nothing reads`).toEqual([]);
    }
  });

  it("name only cairn commands that exist", async () => {
    let help = "";
    await run(["--help"], {
      fetch: async () => new Response(null, { status: 500 }),
      env: {},
      stdout: (text) => {
        help += text;
      },
      stderr: () => undefined,
    });
    const commands = new Set(all(/\bcairn ([a-z][a-z-]*)\b/g, help));
    expect(commands.size).toBeGreaterThan(20);
    for (const path of GUIDES) {
      const named = code(await read(path)).flatMap((text) => all(/(?:^|[\s(`])cairn ([a-z][a-z-]*)(?![:\w.-])/gm, text));
      expect([...new Set(named)].filter((name) => !commands.has(name)), `commands in ${path} that cairn --help does not list`).toEqual([]);
    }
  });
});
