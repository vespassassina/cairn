/**
 * `cairn trust <url>` (roadmap "A local trusted friends catalog", ADR-037).
 *
 * Confirms an address answers with a Cairn's self-description (ADR-034)
 * before the owner adds it to this Cairn's own "Trusted cairns" table: a
 * client of the web, the same posture `cairn check-sources` (ADR-036) and
 * `cairn sync` (ADR-023) already take toward an address that is not this
 * CLI's own server.
 */

export type Fetch = (request: Request) => Promise<Response>;

/** The table this command reads and writes, created on first use if it is not there yet. */
export const TRUSTED_TABLE_NAME = "Trusted cairns";

export interface PeerDescription {
  name: string | null;
  description: string | null;
}

/** Fetches `<url>/.well-known/cairn.json` and confirms it looks like a Cairn's self-description: JSON with a "cairn" field. Throws a plain, specific message naming the address and the next thing to check, on any other outcome. */
export async function fetchPeerDescription(url: string, fetchFn: Fetch, timeoutMs: number): Promise<PeerDescription> {
  const base = url.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchFn(new Request(`${base}/.well-known/cairn.json`, { signal: controller.signal }));
  } catch (error) {
    const why = error instanceof Error && error.name === "AbortError" ? `timed out after ${timeoutMs}ms` : error instanceof Error ? error.message : String(error);
    throw new Error(`${base} did not answer (${why}). Check the address, or pass --timeout to wait longer`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`${base}/.well-known/cairn.json answered ${response.status}. A public Cairn always serves this file (ADR-034); check the address, or that this Cairn is public`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${base}/.well-known/cairn.json did not answer with JSON, so this does not look like a Cairn`);
  }
  if (typeof body !== "object" || body === null || !("cairn" in body)) {
    throw new Error(`${base}/.well-known/cairn.json has no "cairn" field, so this does not look like a Cairn's self-description`);
  }
  const record = body as Record<string, unknown>;
  return {
    name: typeof record["name"] === "string" ? record["name"] : null,
    description: typeof record["description"] === "string" ? record["description"] : null,
  };
}
