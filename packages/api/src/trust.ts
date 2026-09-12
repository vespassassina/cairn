/**
 * Local trust (ADR-010): on a loopback server, a request addressed to a
 * trusted local host name needs no token.
 *
 * Two checks make that safe against a hostile web page in the owner's own
 * browser:
 *
 * 1. The Host header must be a trusted local name. A DNS rebinding attack
 *    points an attacker's domain at 127.0.0.1, but the browser still sends
 *    that domain as the Host, so it fails this check.
 * 2. For MCP, the request must carry no Origin (Claude Code and other
 *    non-browser clients send none) or a local one. A page on another site
 *    can make the browser post to localhost, but it cannot hide its Origin.
 *    Console form posts already require a same-origin Origin.
 */

export interface LocalTrust {
  enabled: boolean;
  /** Lower-case host names, without brackets or ports. */
  hosts: string[];
}

export const NO_LOCAL_TRUST: LocalTrust = { enabled: false, hosts: [] };

function normalise(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

export function isLocalHost(request: Request, trust: LocalTrust): boolean {
  return trust.hosts.includes(normalise(new URL(request.url).hostname));
}

export function isLocalOrigin(origin: string, trust: LocalTrust): boolean {
  try {
    return trust.hosts.includes(normalise(new URL(origin).hostname));
  } catch {
    return false;
  }
}

/** Console pages: trusted by host name. Form posts still need a same-origin Origin. */
export function trustedForConsole(request: Request, trust: LocalTrust): boolean {
  return trust.enabled && isLocalHost(request, trust);
}

/** MCP: trusted by host name, and only when no foreign page sent the request. */
export function trustedForMcp(request: Request, trust: LocalTrust): boolean {
  if (!trust.enabled || !isLocalHost(request, trust)) return false;
  const origin = request.headers.get("origin");
  return origin === null || isLocalOrigin(origin, trust);
}
