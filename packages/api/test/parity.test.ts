import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The cross-surface parity test (ADR-058, docs/specs/agent-navigation.md
 * "The parity test"): a capability that reaches MCP, REST or the CLI should
 * reach the other two, or a reason lives in the allow list below.
 *
 * This is static analysis over source text, not behaviour: it maps identifiers
 * (tool names, route method+path, CLI command names) onto a canonical list of
 * domain capabilities and fails when a capability's mapping has a hole that
 * is not covered by an allow-list entry. It intentionally does not import the
 * three surfaces, so it fails the moment a name is renamed or removed,
 * without needing a running app.
 */

const mcpToolsSrc = readFileSync(fileURLToPath(new URL("../src/mcp/tools.ts", import.meta.url)), "utf8");
const restRoutesSrc = readFileSync(fileURLToPath(new URL("../src/rest/routes.ts", import.meta.url)), "utf8");
const cliMainSrc = readFileSync(fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url)), "utf8");

function mcpTools(src: string): Set<string> {
  return new Set([...src.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!));
}

function restRoutes(src: string): Set<string> {
  const found = new Set<string>();
  // The top-level `api` router, paths as mounted.
  for (const m of src.matchAll(/\bapi\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)) {
    found.add(`${m[1]!.toUpperCase()} ${m[2]}`);
  }
  // The `/tables` sub-router (also aliased at `/collections`, ADR-026), whose
  // handlers are declared with paths relative to its own mount point.
  for (const m of src.matchAll(/\btables\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g)) {
    const path = m[2] === "/" ? "" : m[2];
    found.add(`${m[1]!.toUpperCase()} /tables${path}`);
  }
  return found;
}

function cliCommands(src: string): Set<string> {
  return new Set([...src.matchAll(/^\s*case "([a-z-]+)":/gm)].map((m) => m[1]!));
}

const tools = mcpTools(mcpToolsSrc);
const routes = restRoutes(restRoutesSrc);
const commands = cliCommands(cliMainSrc);

/**
 * One domain capability, and how each surface names it. `null` on a surface
 * means the spec's allow list excuses it, with why.
 */
interface Capability {
  name: string;
  mcp: string | null;
  rest: string | null;
  cli: string | null;
  why?: string;
}

const CAPABILITIES: Capability[] = [
  { name: "search", mcp: "search", rest: "GET /search", cli: "search" },
  { name: "get_page", mcp: "get_page", rest: "GET /pages/:id", cli: "read" },
  { name: "list_children", mcp: "list_children", rest: "GET /pages", cli: "ls" },
  { name: "create_page", mcp: "create_page", rest: "POST /pages", cli: "create" },
  { name: "update_page", mcp: "update_page", rest: "PUT /pages/:id", cli: "write" },
  { name: "delete_page", mcp: "delete_page", rest: "DELETE /pages/:id", cli: "delete" },
  { name: "get_backlinks", mcp: "get_backlinks", rest: "GET /pages/:id/backlinks", cli: "links" },
  { name: "get_neighbours", mcp: "get_neighbours", rest: "GET /pages/:id/neighbours", cli: "links" },
  { name: "move", mcp: "move", rest: "POST /move", cli: "move" },
  { name: "list_tables", mcp: "list_tables", rest: "GET /tables", cli: "tables" },
  { name: "create_table", mcp: "create_table", rest: "POST /tables", cli: "create-table" },
  { name: "update_table", mcp: "update_table", rest: "PUT /tables/:cid", cli: "update-table" },
  { name: "query_table", mcp: "query_table", rest: "POST /tables/:cid/query", cli: "rows" },
  { name: "upsert_row", mcp: "upsert_row", rest: "POST /tables/:cid/rows", cli: "upsert" },
  { name: "get_history", mcp: "get_history", rest: "GET /pages/:id/history", cli: "history" },
  { name: "get_revision", mcp: "get_revision", rest: "GET /pages/:id/revisions/:version", cli: "revision" },
  {
    name: "get_changes",
    mcp: "get_changes",
    rest: "GET /changes",
    cli: "changes",
  },
  // Settled by ADR-045: restoring an old revision is a REST and CLI action
  // (the review console and `cairn restore`), never offered as an MCP tool,
  // so an agent cannot silently discard the owner's later edits.
  {
    name: "restore",
    mcp: null,
    rest: "POST /pages/:id/revisions/:version/restore",
    cli: "restore",
    why: "ADR-045: restore is a human action taken from history, not an agent one",
  },
  // The rest of this list is named against presence.md: each of these
  // describes or changes the local machine running the CLI, not a Cairn
  // workspace, so there is nothing for MCP or REST, which speak to one
  // workspace, to expose.
  { name: "status", mcp: null, rest: null, cli: "status", why: "presence.md: describes this machine, not a Cairn" },
  { name: "hook", mcp: null, rest: null, cli: "hook", why: "presence.md: installs a local git hook" },
  { name: "sync", mcp: null, rest: null, cli: "sync", why: "presence.md: a local job between two Cairns" },
  { name: "instances", mcp: null, rest: null, cli: "instances", why: "presence.md: this machine's registered servers" },
  { name: "start", mcp: null, rest: null, cli: "start", why: "presence.md: starts a local server process" },
  { name: "import", mcp: null, rest: null, cli: "import", why: "presence.md: reads a local export folder" },
];

interface Surfaces {
  tools: Set<string>;
  routes: Set<string>;
  commands: Set<string>;
}

/** Throws naming the first surface a capability is missing from. */
function checkCapability(capability: Capability, surfaces: Surfaces): void {
  if (capability.mcp !== null && !surfaces.tools.has(capability.mcp)) {
    throw new Error(`${capability.name}: no MCP tool "${capability.mcp}"`);
  }
  if (capability.rest !== null && !surfaces.routes.has(capability.rest)) {
    throw new Error(`${capability.name}: no REST route "${capability.rest}"`);
  }
  if (capability.cli !== null && !surfaces.commands.has(capability.cli)) {
    throw new Error(`${capability.name}: no CLI command "${capability.cli}"`);
  }
}

const live: Surfaces = { tools, routes, commands };

describe("cross-surface parity (ADR-058)", () => {
  it.each(CAPABILITIES)("$name reaches every surface the allow list does not excuse", (capability) => {
    expect(() => checkCapability(capability, live)).not.toThrow();
  });

  it("every allow-list exception names why", () => {
    for (const capability of CAPABILITIES) {
      const excused = capability.mcp === null || capability.rest === null || capability.cli === null;
      if (excused) expect(capability.why, `${capability.name} excuses a surface with no reason`).toBeTruthy();
    }
  });

  it("fails when a capability is deliberately removed from one surface", () => {
    const mutated: Surfaces = { tools: new Set(tools), routes, commands };
    mutated.tools.delete("create_table");
    const capability = CAPABILITIES.find((c) => c.name === "create_table")!;
    expect(() => checkCapability(capability, mutated)).toThrow('no MCP tool "create_table"');

    const missingRoute: Surfaces = { tools, routes: new Set(routes), commands };
    missingRoute.routes.delete("GET /changes");
    const changes = CAPABILITIES.find((c) => c.name === "get_changes")!;
    expect(() => checkCapability(changes, missingRoute)).toThrow('no REST route "GET /changes"');

    const missingCommand: Surfaces = { tools, routes, commands: new Set(commands) };
    missingCommand.commands.delete("delete");
    const del = CAPABILITIES.find((c) => c.name === "delete_page")!;
    expect(() => checkCapability(del, missingCommand)).toThrow('no CLI command "delete"');
  });
});
