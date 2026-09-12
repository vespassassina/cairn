/**
 * The small amount of cryptography the OAuth server needs (ADR-017): random
 * tokens, hashes, and HS256 JSON Web Tokens. Web Crypto only, so it runs on
 * Node, Lambda and Azure Functions unchanged (ADR-006).
 */

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** A random, URL-safe token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** SHA-256 as base64url. Tokens are stored by this hash, never as themselves. */
export async function sha256(text: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/** PKCE S256: does this verifier produce this challenge? */
export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return constantTimeEqual(await sha256(verifier), challenge);
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

async function hmacKey(secret: string): Promise<HmacKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export type JwtClaims = Record<string, unknown> & { exp: number; iat: number };

/** Sign claims as a compact HS256 JWT. */
export async function signJwt(claims: JwtClaims, secret: string, typ: string): Promise<string> {
  const header = base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ })));
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

/**
 * Verify an HS256 JWT against any of the secrets (the current one first, then
 * the previous one during a rotation), its type and its expiry. Returns the
 * claims, or null for anything wrong: a caller learns nothing from why.
 */
export async function verifyJwt(
  token: string,
  secrets: string[],
  typ: string,
  now: number = Date.now(),
): Promise<JwtClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  let parsedHeader: { alg?: unknown; typ?: unknown };
  let claims: JwtClaims;
  let signatureBytes: Uint8Array;
  try {
    parsedHeader = JSON.parse(new TextDecoder().decode(fromBase64url(header)));
    claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
    signatureBytes = fromBase64url(signature);
  } catch {
    return null;
  }
  // Only ever HS256: a token cannot choose a weaker algorithm, or "none".
  if (parsedHeader.alg !== "HS256" || parsedHeader.typ !== typ) return null;

  let valid = false;
  for (const secret of secrets) {
    if (
      await crypto.subtle.verify("HMAC", await hmacKey(secret), signatureBytes, encoder.encode(`${header}.${payload}`))
    ) {
      valid = true;
      break;
    }
  }
  if (!valid) return null;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return null;
  return claims;
}
