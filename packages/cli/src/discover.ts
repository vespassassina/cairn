/**
 * `cairn discover` (roadmap "Discovery by following citations", ADR-041).
 *
 * Walks outward from a set of starting Cairns, reading each one's
 * `/.well-known/cairn.json` (ADR-034) and following the origins in its
 * `cites` field (ADR-039, ADR-041), breadth first, bounded by depth and by
 * how many Cairns it will visit in total. A client of the web, the same
 * posture `cairn trust` and `cairn check-sources` already take: the owner's
 * own machine walking addresses the owner's own trusted list, or an explicit
 * `--from`, led it to, never an anonymous caller's address.
 */

import { fetchPeerDescription, type Fetch } from "./trust.js";

/** The table `cairn discover` writes to, created on first use if it is not there yet. Kept separate from "Trusted cairns" (ADR-037): finding an address is not the same as trusting it. */
export const DISCOVERED_TABLE_NAME = "Discovered cairns";

export interface DiscoveredCairn {
  url: string;
  name: string | null;
  discoveredVia: string;
  depth: number;
}

export interface DiscoverResult {
  found: DiscoveredCairn[];
  unreachable: { url: string; reason: string }[];
  visitedCount: number;
}

export interface DiscoverOptions {
  /** Starting points: every url already in "Trusted cairns", plus any --from values. */
  from: string[];
  fetchFn: Fetch;
  timeoutMs: number;
  /** How many hops out from a starting point the walk goes. */
  depth: number;
  /** How many Cairns the walk visits in total, starting points included. */
  limit: number;
  /** Origins already in "Trusted cairns", normalized. A Cairn here is never reported as found (ADR-041 decision 4). */
  trustedOrigins: ReadonlySet<string>;
}

function normalizeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export async function discover(options: DiscoverOptions): Promise<DiscoverResult> {
  const { from, fetchFn, timeoutMs, depth: maxDepth, limit, trustedOrigins } = options;
  const visited = new Set<string>();
  const found: DiscoveredCairn[] = [];
  const unreachable: { url: string; reason: string }[] = [];
  const queue: { origin: string; via: string; depth: number }[] = [];

  for (const url of from) {
    const origin = normalizeOrigin(url);
    if (origin && !visited.has(origin)) {
      visited.add(origin);
      queue.push({ origin, via: origin, depth: 0 });
    }
  }

  while (queue.length > 0) {
    const node = queue.shift()!;
    const peer = await fetchPeerDescription(node.origin, fetchFn, timeoutMs).catch((error: unknown) => {
      unreachable.push({ url: node.origin, reason: error instanceof Error ? error.message : String(error) });
      return null;
    });
    if (!peer) continue;
    if (node.depth > 0 && !trustedOrigins.has(node.origin)) {
      found.push({ url: node.origin, name: peer.name, discoveredVia: node.via, depth: node.depth });
    }
    if (node.depth >= maxDepth) continue;
    for (const cited of peer.cites) {
      if (visited.size >= limit) break;
      const origin = normalizeOrigin(cited);
      if (!origin || visited.has(origin)) continue;
      visited.add(origin);
      queue.push({ origin, via: node.origin, depth: node.depth + 1 });
    }
  }

  return { found, unreachable, visitedCount: visited.size };
}
