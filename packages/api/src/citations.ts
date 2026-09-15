import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { AppContext } from "./context.js";
import { ownerVia } from "./context.js";

/**
 * Receiving a Webmention-style citation notice (ADR-040): a page elsewhere
 * says it links to one of this Cairn's published pages. This is the one
 * place a request from an anonymous, unauthenticated caller makes this
 * server fetch an address it did not choose, so the SSRF guard below is
 * this module's central concern, not an afterthought.
 */

/** The table this feature reads and writes, created on first use, like ADR-037's "Trusted cairns". */
export const CITATIONS_TABLE_NAME = "Citations";

/**
 * Duplicated from `packages/cli/src/trust.ts`'s `TRUSTED_TABLE_NAME` because
 * `packages/api` and `packages/cli` must not import each other's runtime
 * code (hard rule 16, the same reason ADR-039 duplicates `isCairnPageAddress`).
 */
const TRUSTED_TABLE_NAME = "Trusted cairns";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 2_000_000;

export class WebmentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebmentionError";
  }
}

/** Private, loopback and link-local ranges: never a valid target for a webmention fetch. */
function isDisallowedAddress(address: string, family: number): boolean {
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local
    if (a === 0) return true; // "this network"
    return false;
  }
  const lower = address.toLowerCase();
  if (lower === "::1") return true; // loopback
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  if (lower.startsWith("::ffff:")) return isDisallowedAddress(lower.slice(7), 4); // IPv4-mapped
  return false;
}

/**
 * Fetches `url`, refusing anything that is not plain http or https, or that
 * resolves (not just spells itself) to a private, loopback or link-local
 * address, at the initial address and at every redirect hop: DNS rebinding
 * defeats a check made once against the hostname alone. Bounded timeout and
 * response size, and a small, fixed number of redirects.
 */
export async function safeFetchText(url: string, fetchFn: typeof fetch = fetch): Promise<string> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = (() => {
      try {
        return new URL(current);
      } catch {
        throw new WebmentionError(`${current} is not a valid URL`);
      }
    })();
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new WebmentionError(`${current} must be http or https, not ${parsed.protocol}`);
    }
    const literalFamily = isIP(parsed.hostname);
    const addresses = literalFamily
      ? [{ address: parsed.hostname, family: literalFamily }]
      : await lookup(parsed.hostname, { all: true }).catch(() => {
          throw new WebmentionError(`${current}'s address (${parsed.hostname}) did not resolve`);
        });
    if (addresses.length === 0 || addresses.some((a) => isDisallowedAddress(a.address, a.family))) {
      throw new WebmentionError(`${current} resolves to an address this server will not fetch`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchFn(current, { signal: controller.signal, redirect: "manual" });
    } catch (error) {
      const why = error instanceof Error && error.name === "AbortError" ? `timed out after ${FETCH_TIMEOUT_MS}ms` : error instanceof Error ? error.message : String(error);
      throw new WebmentionError(`${current} did not answer (${why})`);
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new WebmentionError(`${current} redirected with no Location header`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) throw new WebmentionError(`${current} answered ${response.status}`);

    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new WebmentionError(`${current}'s response is larger than ${MAX_BODY_BYTES} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf-8");
  }
  throw new WebmentionError(`${url} redirected more than ${MAX_REDIRECTS} times`);
}

/** Whether an anchor in `html` points at `target`, resolved against `base`. */
export function linksTo(html: string, base: string, target: string): boolean {
  const wanted = normalizeForComparison(target);
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']*)["']/gi)) {
    try {
      const resolved = new URL(match[1] ?? "", base).toString();
      if (normalizeForComparison(resolved) === wanted) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function normalizeForComparison(url: string): string {
  return url.replace(/\/+$/, "");
}

async function findOrCreateTable(context: AppContext, name: string, fields: Parameters<AppContext["tables"]["create"]>[1]["fields"]) {
  const existing = (await context.tables.list(context.workspaceId)).find((t) => t.name === name);
  if (existing) return existing;
  return context.tables.create(context.workspaceId, { name, fields }, { actor: ownerVia("webmention") });
}

/** Origins in the "Trusted cairns" table (ADR-037), lowercase, no trailing slash. */
async function trustedOrigins(context: AppContext): Promise<Set<string>> {
  const table = (await context.tables.list(context.workspaceId)).find((t) => t.name === TRUSTED_TABLE_NAME);
  if (!table) return new Set();
  const origins = new Set<string>();
  let cursor: string | null = null;
  do {
    const batch = await context.tables.queryRows(context.workspaceId, table.id, { limit: 500, cursor });
    for (const row of batch.items) {
      const url = row.values["url"];
      if (typeof url === "string") {
        try {
          origins.add(new URL(url).origin.toLowerCase());
        } catch {
          continue;
        }
      }
    }
    cursor = batch.cursor;
  } while (cursor !== null);
  return origins;
}

export interface ReceiveCitationResult {
  status: "accepted" | "pending";
}

/**
 * Verifies a Webmention-shaped notice and records it (ADR-040 decisions 2-4).
 * `pageId` must already be confirmed as a currently published page by the
 * caller (the route knows the published set; this module does not).
 */
export async function receiveCitation(
  context: AppContext,
  params: { pageId: string; source: string; target: string },
  fetchFn: typeof fetch = fetch,
): Promise<ReceiveCitationResult> {
  const html = await safeFetchText(params.source, fetchFn);
  if (!linksTo(html, params.source, params.target)) {
    throw new WebmentionError(`${params.source} does not link to ${params.target}`);
  }

  const table = await findOrCreateTable(context, CITATIONS_TABLE_NAME, [
    { name: "page", type: "relation", target: "pages" },
    { name: "source", type: "url", required: true },
    { name: "status", type: "select", options: ["pending", "accepted"] },
  ]);

  const trusted = await trustedOrigins(context);
  const status: "accepted" | "pending" = trusted.has(new URL(params.source).origin.toLowerCase()) ? "accepted" : "pending";

  const existing = await context.tables.queryRows(context.workspaceId, table.id, {
    where: [
      { field: "page", op: "eq", value: params.pageId },
      { field: "source", op: "eq", value: params.source },
    ],
    limit: 1,
  });
  const row = existing.items[0];
  await context.tables.upsertRow(
    context.workspaceId,
    table.id,
    { values: { page: params.pageId, source: params.source, status } },
    { actor: ownerVia("webmention") },
    row ? { id: row.id, expectedVersion: row.version } : {},
  );

  return { status };
}

/** Accepted citation sources for a published page, for its "Cited by" section (ADR-040 decision 5). */
export async function citedByOf(context: AppContext, pageId: string): Promise<string[]> {
  const table = (await context.tables.list(context.workspaceId)).find((t) => t.name === CITATIONS_TABLE_NAME);
  if (!table) return [];
  const sources: string[] = [];
  let cursor: string | null = null;
  do {
    const batch = await context.tables.queryRows(context.workspaceId, table.id, {
      where: [
        { field: "page", op: "eq", value: pageId },
        { field: "status", op: "eq", value: "accepted" },
      ],
      limit: 500,
      cursor,
    });
    for (const row of batch.items) {
      const source = row.values["source"];
      if (typeof source === "string") sources.push(source);
    }
    cursor = batch.cursor;
  } while (cursor !== null);
  return sources;
}
