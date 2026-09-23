import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { decode as decodePng } from "@jsquash/png";
import { decode as decodeJpeg } from "@jsquash/jpeg";
import { decode as decodeWebp, encode as encodeWebp } from "@jsquash/webp";
import resize from "@jsquash/resize";

/**
 * Decode-resize-encode for attachment thumbnails (ADR-064 decision 6,
 * ADR-068). Kept apart from attachments.ts so the codec wiring, which is
 * the fiddly and Node-specific part, is not tangled up with the row
 * lifecycle rules that module already owns.
 *
 * Every jSquash codec loads its own .wasm file with a bare `fetch(new
 * URL(...))` relative to its own module (see each package's compiled
 * decode.js/encode.js). That works in a browser or a bundler; Node's
 * `fetch` refuses a `file://` URL outright ("not implemented"), which is
 * exactly why jSquash's own README calls its Node support experimental.
 * `patchFetchForWasm` below is the one shim that gap needs: read the file
 * instead of trying the network for it, and only for `file://` URLs, so
 * every other fetch in the process is untouched. See docs/LESSONS.md,
 * 2026-09-23.
 */

const MAX_EDGE = 320;

let fetchPatched = false;

function patchFetchForWasm(): void {
  if (fetchPatched) return;
  fetchPatched = true;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("file://")) {
      const bytes = await readFile(fileURLToPath(url));
      return new Response(bytes as never, { status: 200, headers: { "content-type": "application/wasm" } });
    }
    return original(input, init);
  }) as typeof fetch;
}

// Applied as soon as this module loads, not lazily inside makeThumbnail:
// every jSquash codec (including the ones a test imports directly to build
// a fixture) needs it the first time it loads its wasm, and the patch is a
// no-op past the first call regardless of who triggers it first.
patchFetchForWasm();

/** A decoded image, shaped like the DOM's `ImageData` without depending on that lib being in scope. */
interface DecodedImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

type Decoder = (bytes: ArrayBuffer) => Promise<DecodedImage>;

/**
 * One decoder per raster type ADR-064 decision 5 accepts, per ADR-068.
 * `image/gif` is deliberately absent: ADR-068 names `@jsquash/gif` as the
 * fourth decoder, but no such package exists on npm under that name
 * (checked against the registry and against jamsinclair/jSquash's own
 * package list on 2026-09-23; only a third-party fork republishes a GIF
 * decoder under a different scope). Rather than silently substitute an
 * unreviewed package for the one the ADR names, GIF thumbnails are left
 * unavailable — `makeThumbnail` throws `ThumbnailUnavailableError` for one,
 * which the caller already treats as "no thumbnail this time" per decision
 * 6. See docs/LESSONS.md, 2026-09-23, and flag this for a developer decision
 * before this is considered done for GIF.
 */
const DECODERS: Record<string, Decoder> = {
  "image/png": decodePng as unknown as Decoder,
  "image/jpeg": decodeJpeg as unknown as Decoder,
  "image/webp": decodeWebp as unknown as Decoder,
};

/** The four raster types decision 6 applies to, whether or not a decoder is actually wired up for one of them yet. */
const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function isRasterType(contentType: string): boolean {
  return RASTER_TYPES.has(contentType);
}

export class ThumbnailUnavailableError extends Error {}

function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  if (width <= maxEdge && height <= maxEdge) return { width, height };
  const scale = maxEdge / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * Decodes `bytes` (already sniffed to `contentType` per ADR-064 decision 5),
 * resizes to fit within roughly 320px on the long edge, and encodes the
 * result as WebP. Throws on anything that goes wrong — a corrupt file, an
 * unsupported type, a codec crash — and never catches its own errors: the
 * caller (`attachments.ts`) is the one place that decides a failure here is
 * not an error condition, per decision 6.
 */
export async function makeThumbnail(bytes: ArrayBuffer, contentType: string): Promise<ArrayBuffer> {
  const decode = DECODERS[contentType];
  if (!decode) throw new ThumbnailUnavailableError(`no thumbnail decoder wired up for ${contentType}`);

  const image = await decode(bytes);
  const target = fitWithin(image.width, image.height, MAX_EDGE);
  const resized =
    target.width === image.width && target.height === image.height ? image : await resize(image as never, target);
  return encodeWebp(resized as never);
}
