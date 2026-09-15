import { describe, expect, it } from "vitest";
import { discover } from "../src/discover.js";

function cairnResponse(name: string, cites: string[] = []) {
  return () => Response.json({ cairn: "1", name, cites });
}

function fetchWith(handlers: Record<string, () => Response>) {
  return async (request: Request) => {
    const handler = handlers[request.url];
    if (!handler) throw new Error(`unexpected request in test: ${request.url}`);
    return handler();
  };
}

describe("discover", () => {
  it("finds a Cairn cited by a starting point", async () => {
    const result = await discover({
      from: ["https://start.example"],
      fetchFn: fetchWith({
        "https://start.example/.well-known/cairn.json": cairnResponse("Start", ["https://friend.example"]),
        "https://friend.example/.well-known/cairn.json": cairnResponse("Friend"),
      }),
      timeoutMs: 1000,
      depth: 2,
      limit: 200,
      trustedOrigins: new Set(),
    });
    expect(result.found).toEqual([{ url: "https://friend.example", name: "Friend", discoveredVia: "https://start.example", depth: 1 }]);
    expect(result.visitedCount).toBe(2);
  });

  it("does not report a starting point as found", async () => {
    const result = await discover({
      from: ["https://start.example"],
      fetchFn: fetchWith({ "https://start.example/.well-known/cairn.json": cairnResponse("Start") }),
      timeoutMs: 1000,
      depth: 2,
      limit: 200,
      trustedOrigins: new Set(),
    });
    expect(result.found).toEqual([]);
  });

  it("stops following citations past --depth", async () => {
    const result = await discover({
      from: ["https://a.example"],
      fetchFn: fetchWith({
        "https://a.example/.well-known/cairn.json": cairnResponse("A", ["https://b.example"]),
        "https://b.example/.well-known/cairn.json": cairnResponse("B", ["https://c.example"]),
      }),
      timeoutMs: 1000,
      depth: 1,
      limit: 200,
      trustedOrigins: new Set(),
    });
    expect(result.found.map((f) => f.url)).toEqual(["https://b.example"]);
    expect(result.visitedCount).toBe(2);
  });

  it("stops visiting new Cairns past --limit", async () => {
    const result = await discover({
      from: ["https://a.example"],
      fetchFn: fetchWith({
        "https://a.example/.well-known/cairn.json": cairnResponse("A", ["https://b.example", "https://c.example"]),
        "https://b.example/.well-known/cairn.json": cairnResponse("B"),
      }),
      timeoutMs: 1000,
      depth: 2,
      limit: 2,
      trustedOrigins: new Set(),
    });
    expect(result.visitedCount).toBe(2);
    expect(result.found.map((f) => f.url)).toEqual(["https://b.example"]);
  });

  it("does not revisit a Cairn a citation cycle points back to", async () => {
    const result = await discover({
      from: ["https://a.example"],
      fetchFn: fetchWith({
        "https://a.example/.well-known/cairn.json": cairnResponse("A", ["https://b.example"]),
        "https://b.example/.well-known/cairn.json": cairnResponse("B", ["https://a.example"]),
      }),
      timeoutMs: 1000,
      depth: 3,
      limit: 200,
      trustedOrigins: new Set(),
    });
    expect(result.visitedCount).toBe(2);
    expect(result.found.map((f) => f.url)).toEqual(["https://b.example"]);
  });

  it("skips a dead or non-Cairn address and continues the walk", async () => {
    const result = await discover({
      from: ["https://a.example"],
      fetchFn: fetchWith({
        "https://a.example/.well-known/cairn.json": cairnResponse("A", ["https://dead.example", "https://b.example"]),
        "https://dead.example/.well-known/cairn.json": () => new Response(null, { status: 404 }),
        "https://b.example/.well-known/cairn.json": cairnResponse("B"),
      }),
      timeoutMs: 1000,
      depth: 2,
      limit: 200,
      trustedOrigins: new Set(),
    });
    expect(result.found.map((f) => f.url)).toEqual(["https://b.example"]);
    expect(result.unreachable).toEqual([{ url: "https://dead.example", reason: expect.stringContaining("answered 404") }]);
  });
});
