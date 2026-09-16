/**
 * A thin HTTP client for the Cairn REST API (ADR-013 rule 5).
 *
 * It never opens the database, so it behaves the same against a local server
 * and a deployed one. The fetch function is injected, which lets the tests
 * drive the real app without a socket.
 */

export type Fetch = (request: Request) => Promise<Response>;

export interface ClientOptions {
  baseUrl: string;
  token?: string | undefined;
  userAgent: string;
  fetch: Fetch;
  /**
   * Why this baseUrl, when it was not named explicitly (--instance or
   * CAIRN_URL), so an unreachable error can say the default was a default
   * rather than leave the person guessing why this address was tried
   * (coding style rule 2, fault 7 of console-and-search-polish).
   */
  chosenBecause?: string | undefined;
}

export interface ApiResponse {
  status: number;
  etag: string | null;
  /** Parsed JSON, or null for an empty or non-JSON body. */
  json: Record<string, unknown> | null;
  text: string;
}

/** A response the server marked as an error, with its code and message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: Record<string, unknown> | null,
  ) {
    super(message);
  }
}

export class CairnClient {
  constructor(private readonly options: ClientOptions) {}

  /** The Cairn this client talks to, for messages that name an address. */
  get baseUrl(): string {
    return this.options.baseUrl.replace(/\/+$/, "");
  }

  async request(
    method: string,
    path: string,
    init: { body?: unknown; ifMatch?: string | null } = {},
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = {
      accept: "application/json, text/markdown",
      "user-agent": this.options.userAgent,
    };
    if (this.options.token) headers["authorization"] = `Bearer ${this.options.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.ifMatch) headers["if-match"] = `"${init.ifMatch}"`;

    const url = `${this.options.baseUrl.replace(/\/+$/, "")}/api/v1${path}`;
    let response: Response;
    try {
      response = await this.options.fetch(
        new Request(url, {
          method,
          headers,
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        }),
      );
    } catch (error) {
      const why = this.options.chosenBecause ? ` (${this.options.chosenBecause})` : "";
      throw new ApiError(
        0,
        "unreachable",
        `cannot reach Cairn at ${this.options.baseUrl}${why}. Is the server running? Start it with pnpm dev, or set CAIRN_URL.`,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }

    const text = await response.text();
    let json: Record<string, unknown> | null = null;
    if (response.headers.get("content-type")?.includes("application/json") && text) {
      json = JSON.parse(text) as Record<string, unknown>;
    }
    const etag = response.headers.get("etag")?.replace(/^W\//, "").replace(/^"(.*)"$/, "$1") ?? null;

    if (!response.ok) {
      // 502, 503 and 504 without one of Cairn's own JSON errors come from
      // whatever sits in front of it, so the request never arrived and the
      // reason is in the server's log, not in this response (ADR-046).
      const fromCairn = typeof json?.["error"] === "string";
      const gateway = response.status === 502 || response.status === 503 || response.status === 504;
      if (!fromCairn && gateway) {
        throw new ApiError(
          response.status,
          "server_unavailable",
          `${this.options.baseUrl} answered ${response.status} before Cairn did, so the request never reached it. The server is asleep, still starting, or failing to start. Try again in a minute; if it keeps happening, read the server's own log, because the reason is there rather than here.`,
          json,
        );
      }
      throw new ApiError(
        response.status,
        fromCairn ? (json?.["error"] as string) : `http_${response.status}`,
        typeof json?.["message"] === "string" ? json["message"] : text.slice(0, 200),
        json,
      );
    }
    return { status: response.status, etag, json, text };
  }
}
