import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContext, OWNER, type AppContext } from "../src/context.js";
import { citedByOf, linksTo, receiveCitation, safeFetchText, WebmentionError } from "../src/citations.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

const { lookup } = await import("node:dns/promises");
const mockLookup = vi.mocked(lookup);

/**
 * Receiving a citation notice (ADR-040). The SSRF guard is the part worth
 * distrusting most: it is the one place this server fetches an address an
 * anonymous caller chose, not the owner.
 */

describe("safeFetchText: the SSRF guard", () => {
  beforeEach(() => {
    mockLookup.mockReset();
  });

  it("refuses a scheme other than http or https", async () => {
    await expect(safeFetchText("ftp://example.com/page", vi.fn())).rejects.toThrow(WebmentionError);
  });

  it("refuses an address that resolves to a private range", async () => {
    mockLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }] as never);
    await expect(safeFetchText("https://internal.example.com/page", vi.fn())).rejects.toThrow(
      /this server will not fetch/,
    );
  });

  it("refuses loopback and link-local addresses", async () => {
    for (const address of ["127.0.0.1", "169.254.1.1"]) {
      mockLookup.mockResolvedValue([{ address, family: 4 }] as never);
      await expect(safeFetchText("https://x.example.com/page", vi.fn())).rejects.toThrow(WebmentionError);
    }
  });

  it("fetches a page whose address resolves publicly", async () => {
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    const fetchFn = vi.fn(async () => new Response("hello", { status: 200 }));
    await expect(safeFetchText("https://public.example.com/page", fetchFn)).resolves.toBe("hello");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("re-checks a redirect target, refusing one that points inward", async () => {
    mockLookup.mockImplementation(async (hostname: string) =>
      hostname === "public.example.com"
        ? ([{ address: "93.184.216.34", family: 4 }] as never)
        : ([{ address: "127.0.0.1", family: 4 }] as never),
    );
    const fetchFn = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "https://internal.example.com/page" } }),
    );
    await expect(safeFetchText("https://public.example.com/page", fetchFn)).rejects.toThrow(
      /this server will not fetch/,
    );
  });
});

describe("linksTo", () => {
  it("finds an anchor whose href resolves to the target", () => {
    const html = `<p>See <a href="/w/pg_1">this page</a>.</p>`;
    expect(linksTo(html, "https://other.example.com/post", "https://other.example.com/w/pg_1")).toBe(true);
  });

  it("is false when no anchor resolves to the target", () => {
    const html = `<p>See <a href="/w/pg_2">a different page</a>.</p>`;
    expect(linksTo(html, "https://other.example.com/post", "https://other.example.com/w/pg_1")).toBe(false);
  });
});

describe("receiveCitation", () => {
  let context: AppContext;

  beforeEach(async () => {
    context = await createContext({ database: ":memory:", workspaceId: "ws_citations" });
    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function trust(url: string) {
    const table = await context.tables.create(
      context.workspaceId,
      { name: "Trusted cairns", fields: [{ name: "url", type: "url", required: true }] },
      { actor: OWNER },
    );
    await context.tables.upsertRow(context.workspaceId, table.id, { values: { url } }, { actor: OWNER });
  }

  it("accepts a notice whose source links back and whose origin is trusted", async () => {
    await trust("https://friend.example.com");
    const fetchFn = vi.fn(async () =>
      new Response(`<a href="https://this-cairn.example.com/w/pg_1">cited</a>`, { status: 200 }),
    );
    const result = await receiveCitation(
      context,
      { pageId: "pg_1", source: "https://friend.example.com/post", target: "https://this-cairn.example.com/w/pg_1" },
      fetchFn,
    );
    expect(result.status).toBe("accepted");
    expect(await citedByOf(context, "pg_1")).toEqual(["https://friend.example.com/post"]);
  });

  it("stores a notice from an untrusted origin as pending, not shown as cited-by", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(`<a href="https://this-cairn.example.com/w/pg_1">cited</a>`, { status: 200 }),
    );
    const result = await receiveCitation(
      context,
      { pageId: "pg_1", source: "https://stranger.example.com/post", target: "https://this-cairn.example.com/w/pg_1" },
      fetchFn,
    );
    expect(result.status).toBe("pending");
    expect(await citedByOf(context, "pg_1")).toEqual([]);
  });

  it("refuses a notice whose source does not actually link to the target", async () => {
    const fetchFn = vi.fn(async () => new Response(`<a href="/somewhere-else">nope</a>`, { status: 200 }));
    await expect(
      receiveCitation(
        context,
        { pageId: "pg_1", source: "https://stranger.example.com/post", target: "https://this-cairn.example.com/w/pg_1" },
        fetchFn,
      ),
    ).rejects.toThrow(/does not link to/);
  });

  it("upserts rather than duplicates a repeat notice for the same page and source", async () => {
    await trust("https://friend.example.com");
    const fetchFn = vi.fn(async () =>
      new Response(`<a href="https://this-cairn.example.com/w/pg_1">cited</a>`, { status: 200 }),
    );
    const params = { pageId: "pg_1", source: "https://friend.example.com/post", target: "https://this-cairn.example.com/w/pg_1" };
    await receiveCitation(context, params, fetchFn);
    await receiveCitation(context, params, fetchFn);
    expect(await citedByOf(context, "pg_1")).toEqual(["https://friend.example.com/post"]);
  });
});
