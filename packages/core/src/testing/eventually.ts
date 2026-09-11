import { EVENTUAL_CONSISTENCY_BOUND_MS } from "../ports/document-store.js";

/**
 * Poll until an assertion about derived data holds, or the consistency bound
 * expires (ADR-005 rule 4).
 *
 * Conformance tests must use this for anything derived. Reading once straight
 * after a write passes on SQLite and fails on a backend whose secondary index
 * is eventually consistent, which is exactly the bug the suite exists to
 * catch.
 */
export async function eventually<T>(
  check: () => Promise<T>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? EVENTUAL_CONSISTENCY_BOUND_MS;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  for (;;) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  if (lastError instanceof Error) {
    lastError.message = `not consistent within ${timeoutMs}ms: ${lastError.message}`;
  }
  throw lastError;
}
