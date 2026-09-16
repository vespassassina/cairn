import { describe, expect, it } from "vitest";
import { ApiError, CairnClient } from "../src/client.js";

// A gateway answering for a Cairn that never woke up used to reach the person
// as "http_504: stream timeout", which says nothing about what to do (ADR-046).

const clientAnswering = (response: Response) =>
  new CairnClient({
    baseUrl: "https://cairn.example.com",
    userAgent: "cairn-test",
    fetch: async () => response,
  });

describe("what the client makes of a failure", () => {
  it("says why an unnamed address was tried, on an unreachable Cairn (fault 7, console-and-search-polish)", async () => {
    const client = new CairnClient({
      baseUrl: "http://localhost:8787",
      userAgent: "cairn-test",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      chosenBecause: "the default, since no --instance, CAIRN_URL or registered instance was given",
    });
    const error = await client.request("GET", "/pages").catch((caught: unknown) => caught);
    const api = error as ApiError;
    expect(api.code).toBe("unreachable");
    expect(api.message).toContain("http://localhost:8787");
    expect(api.message).toContain("the default, since no --instance, CAIRN_URL or registered instance was given");
  });

  it("names only the address when it was given explicitly", async () => {
    const explicit = new CairnClient({
      baseUrl: "https://cairn.example.com",
      userAgent: "cairn-test",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const error = await explicit.request("GET", "/pages").catch((caught: unknown) => caught);
    const api = error as ApiError;
    expect(api.message).toBe(
      "cannot reach Cairn at https://cairn.example.com. Is the server running? Start it with pnpm dev, or set CAIRN_URL.",
    );
  });

  it("explains a gateway timeout, which never reached Cairn at all", async () => {
    const client = clientAnswering(new Response("stream timeout", { status: 504 }));
    const error = await client.request("GET", "/pages").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    const api = error as ApiError;
    expect(api.code).toBe("server_unavailable");
    expect(api.message).toContain("never reached it");
    expect(api.message).toContain("read the server's own log");
    expect(api.message).toContain("https://cairn.example.com");
  });

  it("keeps Cairn's own error when Cairn is the one refusing", async () => {
    const client = clientAnswering(
      new Response(JSON.stringify({ error: "version_conflict", message: "someone edited it first" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    const error = await client.request("PATCH", "/pages/x").catch((caught: unknown) => caught);
    const api = error as ApiError;
    expect(api.code).toBe("version_conflict");
    expect(api.message).toBe("someone edited it first");
  });

  it("does not mistake a 503 that Cairn itself sent for a gateway failure", async () => {
    const client = clientAnswering(
      new Response(JSON.stringify({ error: "indexing", message: "still building the index" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    const error = await client.request("GET", "/search").catch((caught: unknown) => caught);
    const api = error as ApiError;
    expect(api.code).toBe("indexing");
  });
});
