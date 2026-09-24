import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { eventually } from "@cairn/core/testing";
import { createApp } from "../src/app.js";
import { closeContext, createContext, OWNER, type AppContext } from "../src/context.js";
import { APPROVED_BOOST, searchPages, setApproval } from "../src/operations.js";

/**
 * Search honours the mark (ADR-078 decision 4, spec criterion 5): an
 * approved page outranks an otherwise identical neutral one, a disapproved
 * page is left out unless asked for, and MCP, REST and the console all show
 * the same order because they all go through `searchPages`. The CLI half of
 * the parity check is in `packages/cli/test/approve-command.test.ts`, since
 * the CLI package depends on this one and not the other way round.
 */

const TOKEN = "test-token-0123456789abcdef";
const ORIGIN = "http://localhost";
const BODY = "Zinc carnosine supports the gut lining after a course of antibiotics.";

describe("search and the approval mark", () => {
  let context: AppContext;
  let app: Hono;
  let ids: { approved: string; neutral: string; disapproved: string };

  beforeEach(async () => {
    context = await createContext({ database: ":memory:", host: "127.0.0.1", port: 0, token: TOKEN, workspaceId: "ws_rank" });
    app = createApp({ context, token: TOKEN });
    // Neutral first, so arrival order alone would put it ahead of the approved one.
    const neutral = await context.pages.create(context.workspaceId, { title: "Gut note B", body: BODY, tags: [] }, { actor: OWNER }, "pg_neutral");
    const approved = await context.pages.create(context.workspaceId, { title: "Gut note A", body: BODY, tags: [] }, { actor: OWNER }, "pg_approved");
    const disapproved = await context.pages.create(context.workspaceId, { title: "Gut note C", body: BODY, tags: [] }, { actor: OWNER }, "pg_disapproved");
    await setApproval(context, approved.id, "approved", approved.version, { actor: OWNER });
    await setApproval(context, disapproved.id, "disapproved", disapproved.version, { actor: OWNER });
    ids = { approved: approved.id, neutral: neutral.id, disapproved: disapproved.id };
  });

  afterEach(async () => {
    await closeContext(context);
  });

  it("ranks approved first, hides disapproved by default, and carries the mark on every hit", async () => {
    await eventually(async () => {
      const result = await searchPages(context, { query: "zinc carnosine gut lining" });
      expect(result.pages.map((p) => p.pageId)).toEqual([ids.approved, ids.neutral]);
      expect(result.pages.map((p) => p.approval)).toEqual(["approved", "neutral"]);
      expect(result.pages[0]!.score).toBeCloseTo(result.pages[1]!.score * APPROVED_BOOST, 6);
    });
    // Asked for, the disapproved page is back, marked, and still behind the
    // approved one. Its order against the neutral one is the index's tie
    // order, not the mark's.
    const all = await searchPages(context, { query: "zinc carnosine gut lining", includeDisapproved: true });
    expect(all.pages[0]!.pageId).toBe(ids.approved);
    expect(all.pages.map((p) => p.pageId).sort()).toEqual([ids.approved, ids.disapproved, ids.neutral]);
    expect(all.pages.find((p) => p.pageId === ids.disapproved)?.approval).toBe("disapproved");
  });

  it("gives the same order through MCP, REST and the console", async () => {
    await eventually(async () => {
      const result = await searchPages(context, { query: "zinc carnosine gut lining" });
      expect(result.pages).toHaveLength(2);
    });
    const expected = [ids.approved, ids.neutral];

    // MCP
    const rpc = await app.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${TOKEN}`,
          "user-agent": "claude-code/2.0.0",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "search", arguments: { query: "zinc carnosine gut lining" } },
        }),
      }),
    );
    const mcpBody = (await rpc.json()) as { result: { content: { text: string }[] } };
    const mcp = JSON.parse(mcpBody.result.content[0]!.text) as { pages: { page_id: string; approval: string }[] };
    expect(mcp.pages.map((p) => p.page_id)).toEqual(expected);
    expect(mcp.pages.map((p) => p.approval)).toEqual(["approved", "neutral"]);

    // REST, plus the opt-in
    const rest = await app.fetch(
      new Request(`${ORIGIN}/api/v1/search?q=zinc+carnosine+gut+lining`, {
        headers: { authorization: `Bearer ${TOKEN}`, "user-agent": "cairn-cli/0.1.0" },
      }),
    );
    const restJson = (await rest.json()) as { pages: { page_id: string; approval: string }[] };
    expect(restJson.pages.map((p) => p.page_id)).toEqual(expected);
    expect(restJson.pages[0]!.approval).toBe("approved");
    const restAll = await app.fetch(
      new Request(`${ORIGIN}/api/v1/search?q=zinc+carnosine+gut+lining&include_disapproved=1`, {
        headers: { authorization: `Bearer ${TOKEN}`, "user-agent": "cairn-cli/0.1.0" },
      }),
    );
    const restAllJson = (await restAll.json()) as { pages: { page_id: string }[] };
    expect(restAllJson.pages[0]!.page_id).toBe(ids.approved);
    expect(restAllJson.pages.map((p) => p.page_id)).toContain(ids.disapproved);

    // Console: the order of page links in the results, and no disapproved page.
    const login = await app.fetch(
      new Request(`${ORIGIN}/login`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: TOKEN, next: "/" }),
      }),
    );
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await app.fetch(new Request(`${ORIGIN}/search?q=zinc+carnosine+gut+lining`, { headers: { cookie } }));
    const html = await page.text();
    const order = [...html.matchAll(/class="cairn-hit">\s*<a href="\/p\/([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(expected);
    expect(html).not.toContain(ids.disapproved);
  });
});
