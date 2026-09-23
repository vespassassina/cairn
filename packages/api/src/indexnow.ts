/**
 * Telling IndexNow about pages that just changed public status (ADR-074).
 *
 * IndexNow (`api.indexnow.org`) is a shared submission API that Bing, Yandex
 * and other participating engines read from, so a search engine can recrawl a
 * changed page without waiting for its own schedule. A site proves ownership
 * with a key served as a plain-text file at its own origin (see
 * `registerPublicWiki`'s `/<key>.txt` route), then POSTs the list of URLs
 * that changed.
 *
 * This is a courtesy notification, not a guarantee: IndexNow's own spec
 * tolerates missed submissions, since search engines still crawl on their own
 * schedule. So a failure here is logged and never thrown further, matching
 * `citations.ts`'s `safeFetchText` for the fetch mechanics (bounded timeout
 * via `AbortController`) but not its behaviour on failure: that module
 * throws so its caller can report the failure to whoever asked for the
 * fetch, while this one never has a caller waiting on it.
 */

const INDEXNOW_URL = "https://api.indexnow.org/indexnow";
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Submits `urls` to IndexNow under `key`, proven by the key file at
 * `<origin>/<key>.txt`. Never throws: a non-2xx response, a network error or
 * a timeout is logged with `console.error` and swallowed, so a slow or
 * unreachable IndexNow can never delay or fail the publish it followed.
 */
export async function notifyIndexNow(
  key: string,
  origin: string,
  urls: string[],
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  if (urls.length === 0) return;

  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    console.error(`indexnow: origin "${origin}" is not a valid URL, skipping submission of ${urls.length} url(s)`);
    return;
  }
  const keyLocation = `${origin}/${key}.txt`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchFn(INDEXNOW_URL, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key, keyLocation, urlList: urls }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(`indexnow: submission of ${urls.length} url(s) for ${host} was rejected (${response.status})`);
    }
  } catch (error) {
    const why =
      error instanceof Error && error.name === "AbortError"
        ? `timed out after ${FETCH_TIMEOUT_MS}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`indexnow: submission of ${urls.length} url(s) for ${host} failed (${why})`);
  } finally {
    clearTimeout(timer);
  }
}
