import { describe, expect, it } from "vitest";
import { checkHref, checkSources, collectSources, waybackCopy, type Fetch } from "../src/check-sources.js";
import type { ExportPage } from "../src/export-format.js";

function page(id: string, title: string, sources: string[]): ExportPage {
  return { id, title, parent_id: null, tags: [], body: "", sources };
}

function fakeFetch(handler: (request: Request) => Response): Fetch {
  return async (request) => handler(request);
}

describe("collectSources", () => {
  it("finds sources on pages and rows, tagging where each came from", () => {
    const pages = [page("p1", "Page one", ["https://example.com/a", "Smith 2021"])];
    const tables = [{ id: "t1", rows: [{ id: "r1", sources: ["10.1038/x"] }, { id: "r2", sources: [] }] }];
    const found = collectSources(pages, tables);
    expect(found).toEqual([
      { source: "https://example.com/a", href: "https://example.com/a", on: { kind: "page", id: "p1", title: "Page one" } },
      { source: "Smith 2021", href: null, on: { kind: "page", id: "p1", title: "Page one" } },
      { source: "10.1038/x", href: "https://doi.org/10.1038/x", on: { kind: "row", table: "t1", id: "r1" } },
    ]);
  });
});

describe("checkHref", () => {
  it("is ok for a 2xx response to HEAD", async () => {
    const fetchFn = fakeFetch(() => new Response(null, { status: 200 }));
    expect(await checkHref("https://example.com", fetchFn, 1000)).toEqual({ ok: true, status: 200 });
  });

  it("is dead for a 4xx or 5xx response", async () => {
    const fetchFn = fakeFetch(() => new Response(null, { status: 404 }));
    expect(await checkHref("https://example.com/gone", fetchFn, 1000)).toEqual({ ok: false, status: 404 });
  });

  it("falls back to GET when HEAD is not allowed", async () => {
    let method = "";
    const fetchFn = fakeFetch((request) => {
      method = method === "" ? request.method : `${method},${request.method}`;
      return request.method === "HEAD" ? new Response(null, { status: 405 }) : new Response("ok", { status: 200 });
    });
    expect(await checkHref("https://example.com", fetchFn, 1000)).toEqual({ ok: true, status: 200 });
    expect(method).toBe("HEAD,GET");
  });

  it("reports a network failure as dead, with the reason", async () => {
    const fetchFn: Fetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND example.invalid");
    };
    const result = await checkHref("https://example.invalid", fetchFn, 1000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOTFOUND");
  });
});

describe("waybackCopy", () => {
  it("returns the closest archived snapshot when one is available", async () => {
    const fetchFn = fakeFetch(() =>
      Response.json({ archived_snapshots: { closest: { available: true, url: "https://web.archive.org/web/2021/https://example.com" } } }),
    );
    expect(await waybackCopy("https://example.com", fetchFn, 1000)).toBe("https://web.archive.org/web/2021/https://example.com");
  });

  it("returns null when nothing is archived", async () => {
    const fetchFn = fakeFetch(() => Response.json({ archived_snapshots: {} }));
    expect(await waybackCopy("https://example.com", fetchFn, 1000)).toBeNull();
  });

  it("returns null, not a throw, when the lookup itself fails", async () => {
    const fetchFn: Fetch = async () => {
      throw new Error("network down");
    };
    expect(await waybackCopy("https://example.com", fetchFn, 1000)).toBeNull();
  });
});

describe("checkSources", () => {
  it("checks each linkable address once, looks up an archived copy only for dead ones, and skips plain citations", async () => {
    const requested: string[] = [];
    const fetchFn = fakeFetch((request) => {
      requested.push(request.url);
      if (request.url.includes("archive.org")) {
        return Response.json({ archived_snapshots: { closest: { available: true, url: "https://web.archive.org/web/x" } } });
      }
      return new Response(null, { status: request.url.includes("dead") ? 404 : 200 });
    });
    const found = collectSources(
      [page("p1", "Page one", ["https://example.com/ok", "https://example.com/dead", "https://example.com/ok", "Smith 2021"])],
      [],
    );
    const checks = await checkSources(found, fetchFn, 1000);
    expect(checks.size).toBe(2); // one entry per distinct address, not per mention
    expect(checks.get("https://example.com/ok")).toEqual({ href: "https://example.com/ok", ok: true, status: 200 });
    expect(checks.get("https://example.com/dead")).toEqual({
      href: "https://example.com/dead",
      ok: false,
      status: 404,
      archived: "https://web.archive.org/web/x",
    });
    // The repeated ok address was requested once, not twice.
    expect(requested.filter((url) => url === "https://example.com/ok")).toHaveLength(1);
  });
});
