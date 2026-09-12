/**
 * Review console sign-in, dev mode (ADR-009 rule 5).
 *
 * The owner enters the dev token once. The cookie holds an HMAC of the token,
 * never the token itself, so a leaked cookie does not leak the MCP bearer
 * token. Web Crypto only, so this runs on every target (ADR-006).
 */

export const SESSION_COOKIE = "cairn_session";

const encoder = new TextEncoder();

export async function sessionValue(token: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode("cairn-console-session-v1"),
  );
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * A form post must come from the console itself. SameSite=Strict already stops
 * other sites sending the cookie; checking Origin as well means one mistake in
 * cookie handling is not enough to let another site post a form here.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return origin === new URL(request.url).origin;
}
