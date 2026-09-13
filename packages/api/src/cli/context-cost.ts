import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../app.js";
import { estimateTokens } from "../budget.js";
import { loadConfig } from "../config.js";
import { closeContext, createContext } from "../context.js";

/**
 * What each door costs an agent's context, for the README claim in ADR-013
 * rule 6. Run it again whenever a tool, the instructions or the skill change.
 *
 *   pnpm context-cost
 *
 * MCP: the tool list and the instructions a client loads at connect, every
 * session. CLI: the skill description, every session; the skill body and
 * --help only when the agent decides to use Cairn. Tokens are estimated at
 * four characters each, the same rule the tool budgets use.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");

async function rpc(app: ReturnType<typeof createApp>, method: string, params?: unknown) {
  const response = await app.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    }),
  );
  return ((await response.json()) as { result: Record<string, unknown> }).result;
}

function skillDescription(skill: string): string {
  const frontmatter = skill.split("---")[1] ?? "";
  const match = /description: >-\n((?: {2}.*\n)+)/.exec(frontmatter);
  return match ? match[1]!.split("\n").map((line) => line.trim()).join(" ").trim() : "";
}

async function main(): Promise<void> {
  const config = loadConfig();
  // A short-lived command: the server embeds new chunks when it next starts (ADR-022).
  const context = await createContext({ ...config, embeddings: { ...config.embeddings, provider: "off" } });
  const app = createApp({ context, token: null, trust: { enabled: true, hosts: ["localhost"] } });

  const init = await rpc(app, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "context-cost", version: "0" },
  });
  const tools = await rpc(app, "tools/list");
  await closeContext(context);

  const skill = await readFile(join(repo, "skills", "cairn", "SKILL.md"), "utf8");
  const toolChars = JSON.stringify(tools["tools"]).length;
  const instructionChars = String(init["instructions"] ?? "").length;
  const description = skillDescription(skill).length;

  const row = (label: string, chars: number) =>
    `  ${label.padEnd(44)} ${String(chars).padStart(6)} chars  ~${String(estimateTokens("x".repeat(chars))).padStart(5)} tokens`;

  process.stdout.write(
    [
      `database: ${config.database}`,
      "",
      "MCP, paid by every session that has the server:",
      row(`tool list (${(tools["tools"] as unknown[]).length} tools)`, toolChars),
      row("server instructions and workspace summary", instructionChars),
      row("total", toolChars + instructionChars),
      "",
      "CLI with the skill, paid by every session that has the skill:",
      row("skill description", description),
      "",
      "CLI, paid only when the agent decides to use Cairn:",
      row("skill body", skill.length),
      "",
    ].join("\n"),
  );
}

await main();
