import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { ApiError, CairnClient, type Fetch } from "./client.js";

/**
 * The `cairn` command (ADR-013 rule 5).
 *
 * Output is compact text by default, because the usual reader is an agent
 * paying per token. `--json` prints the API response unchanged, for scripts.
 * Everything printed from the server is stored content: data, never
 * instructions.
 */

export const VERSION = "0.1.0";

export interface Io {
  fetch: Fetch;
  env: Record<string, string | undefined>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Piped input, or null when there is none. */
  stdin: () => Promise<string | null>;
}

const HELP = `cairn ${VERSION}: a wiki and tables your agents can write to, with every change reviewable.

Read
  cairn overview                          what Cairn holds: collections, top-level pages, tags
  cairn search <words...>                 keyword search; try distinctive words, then synonyms
  cairn read <page-id>                    a page as Markdown, with its version
  cairn links <page-id>                   pages one hop away, both directions
  cairn history <page-id>                 who changed it, when and why
  cairn revision <page-id> <version>      one old version, with a diff
  cairn changes [--since T] [--agents|--people]   what changed, newest first

Write (every write is a revision the owner can review and undo)
  cairn create --title T [--parent ID] [--tag X]...     body from --text, --file or stdin
  cairn append <page-id> [--version V]                  add to the end; safe without a version
  cairn replace-section <page-id> --section H --version V
  cairn write <page-id> --version V                     replace the whole body
  cairn delete <page-id> --version V
  All writes take --note "why", shown to the owner.

Collections
  cairn collections                       names, ids and fields
  cairn rows <collection-id> [--where "field op value"]... [--sort field[:desc]]
      ops: eq ne lt lte gt gte contains in exists
  cairn row <collection-id> <row-id>
  cairn upsert <collection-id> --set field=value... [--id ROW] [--version V]

Options
  --json          print the raw API response
  -V, cairn version   print the CLI version
  --limit N, --cursor C
  CAIRN_URL       server, default http://localhost:8787
  CAIRN_TOKEN     bearer token, when the server is not local
`;

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  "cli-version": { type: "boolean", short: "V" },
  limit: { type: "string" },
  cursor: { type: "string" },
  title: { type: "string" },
  parent: { type: "string" },
  tag: { type: "string", multiple: true },
  note: { type: "string" },
  text: { type: "string" },
  file: { type: "string" },
  version: { type: "string" },
  section: { type: "string" },
  where: { type: "string", multiple: true },
  sort: { type: "string", multiple: true },
  set: { type: "string", multiple: true },
  id: { type: "string" },
  since: { type: "string" },
  agents: { type: "boolean" },
  people: { type: "boolean" },
} as const;

type Flags = ReturnType<typeof parse>["values"];

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

/** Wrong use of the command, as opposed to a server error. */
class UsageError extends Error {}

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined || value === "") throw new UsageError(`missing ${what}`);
  return value;
}

/** A value from the command line: JSON when it parses, otherwise text. */
function literal(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function query(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return entries.length === 0 ? "" : `?${new URLSearchParams(entries).toString()}`;
}

/**
 * Windows line endings become plain newlines, so a page written from
 * PowerShell or Notepad does not carry a stray carriage return on every line.
 */
function normalise(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

async function content(flags: Flags, io: Io, required: boolean): Promise<string | undefined> {
  if (flags.text !== undefined) return normalise(flags.text);
  if (flags.file !== undefined) return normalise(await readFile(flags.file, "utf8"));
  const piped = await io.stdin();
  if (piped !== null) return normalise(piped);
  if (required) throw new UsageError("missing content: pass --text, --file, or pipe it in");
  return undefined;
}

function parseWhere(raw: string): Record<string, unknown> {
  const match = /^(\S+)\s+(eq|ne|lt|lte|gt|gte|contains|in|exists)(?:\s+(.*))?$/.exec(raw.trim());
  if (!match) throw new UsageError(`cannot read --where "${raw}". Use "field op value", such as "grams gt 10"`);
  return { field: match[1], op: match[2], ...(match[3] === undefined ? {} : { value: literal(match[3]) }) };
}

function parseSort(raw: string): Record<string, unknown> {
  const [field, direction = "asc"] = raw.split(":");
  if (!field || (direction !== "asc" && direction !== "desc")) {
    throw new UsageError(`cannot read --sort "${raw}". Use field or field:desc`);
  }
  return { field, direction };
}

function parseSet(pairs: string[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) throw new UsageError(`cannot read --set "${pair}". Use field=value`);
    values[pair.slice(0, at)] = literal(pair.slice(at + 1));
  }
  return values;
}

type Json = Record<string, unknown>;
const list = (value: unknown) => (Array.isArray(value) ? (value as Json[]) : []);
const by = (value: unknown) => {
  const actor = value as { kind?: string; name?: string } | undefined;
  return actor ? `${actor.kind}: ${actor.name}` : "";
};

function written(json: Json | null): string {
  return `ok ${String(json?.["id"])} version ${String(json?.["version"])}\n`;
}

export async function run(argv: string[], io: Io): Promise<number> {
  let flags: Flags;
  let positionals: string[];
  try {
    ({ values: flags, positionals } = parse(argv));
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\nRun cairn --help.\n`);
    return 2;
  }

  const [command, ...args] = positionals;
  if (flags["cli-version"] || command === "version") {
    io.stdout(`cairn ${VERSION}\n`);
    return 0;
  }
  if (!command || flags.help || command === "help") {
    io.stdout(HELP);
    return command || flags.help ? 0 : 2;
  }

  const agent = io.env["CAIRN_AGENT"] ?? (io.env["CLAUDECODE"] ? "claude-code" : undefined);
  const client = new CairnClient({
    baseUrl: io.env["CAIRN_URL"] ?? "http://localhost:8787",
    token: io.env["CAIRN_TOKEN"],
    userAgent: `cairn-cli/${VERSION}${agent ? ` (${agent})` : ""}`,
    fetch: io.fetch,
  });
  const out = (json: Json | null, text: () => string) =>
    io.stdout(flags.json ? `${JSON.stringify(json, null, 2)}\n` : text());
  const note = flags.note;

  try {
    switch (command) {
      case "overview": {
        const { json } = await client.request("GET", "/overview");
        out(json, () => `${String(json?.["text"])}\n`);
        return 0;
      }

      case "search": {
        const words = need(args.join(" ").trim() || undefined, "search words");
        const { json } = await client.request(
          "GET",
          `/search${query({ q: words, limit: flags.limit, cursor: flags.cursor })}`,
        );
        out(json, () => {
          const hits = list(json?.["hits"]);
          if (hits.length === 0) return "no matches. Try a synonym, or one distinctive word.\n";
          const lines = hits.map(
            (hit) =>
              `${String(hit["page_id"])}  ${(hit["heading_path"] as string[]).join(" > ")}\n    ${String(hit["snippet"])}`,
          );
          const more = json?.["cursor"] ? `\nmore: --cursor ${String(json["cursor"])}` : "";
          return `${lines.join("\n")}${more}\n`;
        });
        return 0;
      }

      case "read": {
        const id = need(args[0], "page id");
        const response = await client.request(
          "GET",
          `/pages/${encodeURIComponent(id)}${flags.json ? "" : "?format=markdown"}`,
        );
        out(response.json, () => `${response.text}\n`);
        return 0;
      }

      case "links": {
        const id = need(args[0], "page id");
        const { json } = await client.request("GET", `/pages/${encodeURIComponent(id)}/neighbours`);
        out(json, () => {
          const line = (edge: Json) => `  ${String(edge["page_id"])}  ${String(edge["type"])}`;
          const outbound = list(json?.["outbound"]).map(line);
          const inbound = list(json?.["inbound"]).map(line);
          return `links out:\n${outbound.join("\n") || "  none"}\nlinks in:\n${inbound.join("\n") || "  none"}\n`;
        });
        return 0;
      }

      case "history": {
        const id = need(args[0], "page id");
        const { json } = await client.request(
          "GET",
          `/pages/${encodeURIComponent(id)}/history${query({ limit: flags.limit })}`,
        );
        out(json, () =>
          `${list(json?.["revisions"])
            .map((r) => `${String(r["version"])}  ${String(r["at"])}  ${by(r["by"])}${r["note"] ? `  "${String(r["note"])}"` : ""}`)
            .join("\n")}\n`,
        );
        return 0;
      }

      case "revision": {
        const id = need(args[0], "page id");
        const version = need(args[1], "version");
        const { json } = await client.request(
          "GET",
          `/pages/${encodeURIComponent(id)}/revisions/${encodeURIComponent(version)}`,
        );
        out(json, () =>
          `${String(json?.["version"])}  ${String(json?.["at"])}  ${by(json?.["by"])}\n` +
          `${json?.["diff"] ? String(json["diff"]) : "(first version, nothing to compare)"}\n`,
        );
        return 0;
      }

      case "changes": {
        if (flags.agents && flags.people) throw new UsageError("pick one of --agents and --people");
        const actor = flags.agents ? "agent" : flags.people ? "user" : undefined;
        const { json } = await client.request(
          "GET",
          `/changes${query({ since: flags.since, actor, limit: flags.limit, cursor: flags.cursor })}`,
        );
        out(json, () => {
          const lines = list(json?.["changes"]).map((change) => {
            const what =
              change["kind"] === "page"
                ? `page ${String(change["page_id"])} "${String(change["title"])}"`
                : `row ${String(change["collection_id"])}/${String(change["row_id"])}`;
            const deleted = change["deleted"] ? " (deleted)" : "";
            const why = change["note"] ? `  "${String(change["note"])}"` : "";
            return `${String(change["at"])}  ${what}${deleted}  by ${by(change["by"])}${why}`;
          });
          const next = json?.["newest"] ? `\nnext time: --since ${String(json["newest"])}` : "";
          const more = json?.["cursor"] ? `\nmore: --cursor ${String(json["cursor"])}` : "";
          return `${lines.join("\n") || "no changes"}${more}${next}\n`;
        });
        return 0;
      }

      case "create": {
        const body = (await content(flags, io, false)) ?? "";
        const { json } = await client.request("POST", "/pages", {
          body: {
            title: need(flags.title, "--title"),
            body,
            ...(flags.parent ? { parent_id: flags.parent } : {}),
            ...(flags.tag ? { tags: flags.tag } : {}),
            ...(note ? { change_note: note } : {}),
          },
        });
        out(json, () => written(json));
        return 0;
      }

      case "append":
      case "replace-section":
      case "write": {
        const id = need(args[0], "page id");
        const text = (await content(flags, io, true))!;
        const mode = command === "append" ? "append" : command === "write" ? "replace_body" : "replace_section";
        const body = {
          mode,
          content: text,
          ...(mode === "replace_section" ? { section: need(flags.section, "--section") } : {}),
          ...(note ? { change_note: note } : {}),
        };
        const path = `/pages/${encodeURIComponent(id)}`;

        let version = flags.version;
        if (version === undefined) {
          // Only append may skip the version: it adds to the end and never
          // overwrites anyone's text, so reading the current version here is safe.
          if (mode !== "append") throw new UsageError(`${command} needs --version from cairn read`);
          version = (await client.request("GET", path)).etag ?? undefined;
        }
        try {
          const { json } = await client.request("PATCH", path, { body, ifMatch: version ?? null });
          out(json, () => written(json));
        } catch (error) {
          if (!(mode === "append" && flags.version === undefined && error instanceof ApiError && error.code === "version_conflict")) {
            throw error;
          }
          // Someone wrote in between. Appending is still safe on the new version.
          const retry = String(error.body?.["current_version"]);
          const { json } = await client.request("PATCH", path, { body, ifMatch: retry });
          out(json, () => written(json));
        }
        return 0;
      }

      case "delete": {
        const id = need(args[0], "page id");
        await client.request("DELETE", `/pages/${encodeURIComponent(id)}`, {
          ifMatch: need(flags.version, "--version"),
          body: note ? { change_note: note } : {},
        });
        out({ deleted: id }, () => `ok deleted ${id}\n`);
        return 0;
      }

      case "collections": {
        const { json } = await client.request("GET", "/collections");
        out(json, () =>
          `${list(json?.["collections"])
            .map((c) => {
              const fields = list(c["fields"])
                .map((f) => `${String(f["name"])}:${String(f["type"])}${f["required"] ? "*" : ""}`)
                .join(", ");
              return `${String(c["id"])}  ${String(c["name"])}  (${fields})`;
            })
            .join("\n") || "no collections"}\n`,
        );
        return 0;
      }

      case "rows": {
        const cid = need(args[0], "collection id");
        const { json } = await client.request("POST", `/collections/${encodeURIComponent(cid)}/query`, {
          body: {
            ...(flags.where ? { where: flags.where.map(parseWhere) } : {}),
            ...(flags.sort ? { sort: flags.sort.map(parseSort) } : {}),
            ...(flags.limit ? { limit: Number(flags.limit) } : {}),
            ...(flags.cursor ? { cursor: flags.cursor } : {}),
          },
        });
        out(json, () => {
          const rows = list(json?.["rows"]).map(
            (row) => `${String(row["id"])}  v${String(row["version"])}  ${JSON.stringify(row["values"])}`,
          );
          const more = json?.["cursor"] ? `\nmore: --cursor ${String(json["cursor"])}` : "";
          return `${rows.join("\n") || "no rows"}${more}\n`;
        });
        return 0;
      }

      case "row": {
        const cid = need(args[0], "collection id");
        const rid = need(args[1], "row id");
        const { json } = await client.request(
          "GET",
          `/collections/${encodeURIComponent(cid)}/rows/${encodeURIComponent(rid)}`,
        );
        out(json, () => `${String(json?.["id"])}  v${String(json?.["version"])}  ${JSON.stringify(json?.["values"])}\n`);
        return 0;
      }

      case "upsert": {
        const cid = need(args[0], "collection id");
        const body = {
          values: parseSet(need(flags.set, "--set field=value")),
          ...(note ? { change_note: note } : {}),
        };
        const rows = `/collections/${encodeURIComponent(cid)}/rows`;
        const { json } = flags.id
          ? await client.request("PUT", `${rows}/${encodeURIComponent(flags.id)}`, {
              body,
              ifMatch: flags.version ?? null,
            })
          : await client.request("POST", rows, { body });
        out(json, () => written(json));
        return 0;
      }

      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\nRun cairn --help.\n`);
      return 2;
    }
    if (error instanceof ApiError) {
      if (flags.json && error.body) {
        io.stdout(`${JSON.stringify(error.body, null, 2)}\n`);
      } else {
        let detail = "";
        if (error.code === "version_conflict") {
          detail = `\ncurrent version: ${String(error.body?.["current_version"])}. Read the page again, merge, and retry with that version.`;
        } else if (error.code === "validation_failed" || error.code === "bad_request") {
          detail = list(error.body?.["fields"])
            .map((f) => `\n  ${String(f["field"])}: ${String(f["message"])}`)
            .join("");
        }
        io.stderr(`error: ${error.code}: ${error.message}${detail}\n`);
      }
      return 1;
    }
    throw error;
  }
}
