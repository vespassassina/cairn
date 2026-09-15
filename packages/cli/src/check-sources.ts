/**
 * `cairn check-sources` (roadmap "Citations kept correct", ADR-036).
 *
 * A read-only report: which sources still answer, and an archived copy for
 * the ones that do not. Modelled on `cairn sync` (ADR-023), a CLI-only job
 * with no server or MCP change, since checking a URL is not something a
 * server should do on anyone's behalf (ADR-013 rule 9's reasoning for sync
 * applies here too: it is a client of the web, not of Cairn).
 */

import type { ExportPage } from "./export-format.js";
import { sourceHref } from "./sources.js";

export type Fetch = (request: Request) => Promise<Response>;

/** One source found on a page or a row, with where it was found. */
export interface FoundSource {
  source: string;
  href: string | null;
  on: { kind: "page"; id: string; title: string } | { kind: "row"; table: string; id: string };
}

export interface SourceCheck {
  href: string;
  ok: boolean;
  /** The HTTP status, when the request reached a server. */
  status?: number;
  /** Why it did not answer, when it never reached a server (DNS, TLS, timeout). */
  error?: string;
  /** A Wayback Machine copy, checked only for a dead http(s) source. */
  archived?: string | null;
}

/** Every page's and row's sources, each tagged with where it was found. Sources with no address (a plain citation) are kept, with `href: null`, so counts add up; only those with one are ever checked. */
export function collectSources(
  pages: ExportPage[],
  tables: Array<{ id: string; rows: Array<{ id: string; sources?: string[] }> }>,
): FoundSource[] {
  const found: FoundSource[] = [];
  for (const page of pages) {
    for (const source of page.sources ?? []) {
      found.push({ source, href: sourceHref(source), on: { kind: "page", id: page.id, title: page.title } });
    }
  }
  for (const table of tables) {
    for (const row of table.rows) {
      for (const source of row.sources ?? []) {
        found.push({ source, href: sourceHref(source), on: { kind: "row", table: table.id, id: row.id } });
      }
    }
  }
  return found;
}

/** One address, HEAD first since most servers answer it, falling back to GET for the ones that reject HEAD. */
export async function checkHref(href: string, fetchFn: Fetch, timeoutMs: number): Promise<{ ok: boolean; status?: number; error?: string }> {
  for (const method of ["HEAD", "GET"]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(new Request(href, { method, signal: controller.signal, redirect: "follow" }));
      clearTimeout(timer);
      if (response.status === 405 && method === "HEAD") continue; // method not allowed: try GET
      return { ok: response.ok, status: response.status };
    } catch (error) {
      clearTimeout(timer);
      if (method === "GET" || !(error instanceof Error)) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      // HEAD itself failed to connect at all (not just refused the method): no point retrying with GET.
      if (error.name === "AbortError") return { ok: false, error: `timed out after ${timeoutMs}ms` };
    }
  }
  return { ok: false, error: "no response" };
}

/** The Internet Archive's availability API: an archived copy of `url`, or null when it has none. */
export async function waybackCopy(url: string, fetchFn: Fetch, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(
      new Request(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { signal: controller.signal }),
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { archived_snapshots?: { closest?: { available?: boolean; url?: string } } };
    const closest = body.archived_snapshots?.closest;
    return closest?.available && typeof closest.url === "string" ? closest.url : null;
  } catch {
    return null; // The report already says the source is dead; a lookup failure just omits the archived copy.
  } finally {
    clearTimeout(timer);
  }
}

/** Checks every linkable source once (by address, so a source repeated across pages is one request), and looks up an archived copy for each dead one. */
export async function checkSources(found: FoundSource[], fetchFn: Fetch, timeoutMs: number): Promise<Map<string, SourceCheck>> {
  const hrefs = [...new Set(found.map((f) => f.href).filter((href): href is string => href !== null))];
  const results = new Map<string, SourceCheck>();
  for (const href of hrefs) {
    const checked = await checkHref(href, fetchFn, timeoutMs);
    const archived = checked.ok || !/^https?:/i.test(href) ? undefined : await waybackCopy(href, fetchFn, timeoutMs);
    results.set(href, { href, ...checked, ...(archived !== undefined ? { archived } : {}) });
  }
  return results;
}
