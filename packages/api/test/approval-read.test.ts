import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/app.js";
import { closeContext, createContext, OWNER, type AppContext } from "../src/context.js";
import { approvalNotice, editPage, setApproval } from "../src/operations.js";

/**
 * Reading a marked page (ADR-078 decision 5, spec criterion 7): every
 * surface returns the mark, and a disapproved page or one changed since
 * approval comes with one notice line an agent cannot miss. The body itself
 * is never altered, so a read-edit-write round trip cannot copy the notice
 * into the page. The CLI's `cairn read` is covered in
 * `packages/cli/test/approve-command.test.ts`.
 */

const TOKEN = "test-token-0123456789abcdef";
const ORIGIN = "http://localhost";
const AGENT = { kind: "agent" as const, id: "mcp:dev", label: "claude-code/2.0.0" };

describe("reading the approval mark", () => {
  let context: AppContext;
  let app: Hono;

  beforeEach(async () => {
    context = await createContext({ database: ":memory:", host: "127.0.0.1", port: 0, token: TOKEN, workspaceId: "ws_read" });
    app = createApp({ context, token: TOKEN });
  });

  afterEach(async () => {
    await closeContext(context);
  });

  async function getPage(id: string) {
    const response = await app.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${TOKEN}`,
          "user-agent": "claude-code/2.0.0",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_page", arguments: { page_id: id } } }),
      }),
    );
    const body = (await response.json()) as { result: { content: { text: string }[] } };
    return JSON.parse(body.result.content[0]!.text) as Record<string, unknown>;
  }

  async function rest(path: string) {
    const response = await app.fetch(
      new Request(`${ORIGIN}/api/v1${path}`, { headers: { authorization: `Bearer ${TOKEN}`, "user-agent": "cairn-cli/0.1.0" } }),
    );
    return { json: response.headers.get("content-type")?.includes("json") ? ((await response.json()) as Record<string, unknown>) : null, text: response.headers.get("content-type")?.includes("json") ? "" : await response.text() };
  }

  it("says nothing extra about a neutral page, beyond the mark itself", async () => {
    await context.pages.create(context.workspaceId, { title: "Plain", body: "Plain text.", tags: [] }, { actor: AGENT }, "pg_plain");
    const read = await getPage("pg_plain");
    expect(read["approval"]).toBe("neutral");
    expect(read).not.toHaveProperty("approval_at");
    expect(read).not.toHaveProperty("approval_previous");
    expect(read).not.toHaveProperty("approval_notice");
    expect(approvalNotice(await context.pages.get(context.workspaceId, "pg_plain"))).toBeNull();
  });

  it("puts one notice line on a disapproved page, on MCP, REST JSON and REST Markdown, and leaves the body whole", async () => {
    const fresh = await context.pages.create(context.workspaceId, { title: "Doses", body: "Take 10 mg.", tags: [] }, { actor: AGENT }, "pg_bad");
    await setApproval(context, fresh.id, "disapproved", fresh.version, { actor: OWNER });
    const today = new Date().toISOString().slice(0, 10);

    const mcp = await getPage("pg_bad");
    expect(mcp["approval"]).toBe("disapproved");
    expect(mcp["approval_notice"]).toBe(`Disapproved by the owner on ${today}. Do not build on this page; say so if asked about it.`);
    expect(mcp["body"]).toBe("Take 10 mg.");
    expect(Object.keys(mcp).indexOf("approval_notice")).toBeLessThan(Object.keys(mcp).indexOf("body"));

    const json = await rest("/pages/pg_bad");
    expect(json.json?.["approval"]).toBe("disapproved");
    expect(json.json?.["approval_notice"]).toContain("Do not build on this page");
    expect(typeof json.json?.["approval_at"]).toBe("string");

    const markdown = await rest("/pages/pg_bad?format=markdown");
    expect(markdown.text).toContain("approval: disapproved");
    const notice = markdown.text.indexOf("Disapproved by the owner");
    expect(notice).toBeGreaterThan(markdown.text.indexOf("---\n", 4));
    expect(notice).toBeLessThan(markdown.text.indexOf("Take 10 mg."));
  });

  it("says a page was approved and has changed since, naming who changed it", async () => {
    const fresh = await context.pages.create(context.workspaceId, { title: "Doses", body: "Take 10 mg.", tags: [] }, { actor: AGENT }, "pg_was");
    const approved = await setApproval(context, fresh.id, "approved", fresh.version, { actor: OWNER });
    const before = await getPage("pg_was");
    expect(before["approval"]).toBe("approved");
    expect(before["approval_version"]).toBe(fresh.version);
    expect(before).not.toHaveProperty("approval_notice");

    await editPage(context, fresh.id, approved.version, { mode: "replace_body", content: "Take 100 mg, twice a day, with food, for six weeks." }, { actor: AGENT, note: "Rewrote the dose" });
    const today = new Date().toISOString().slice(0, 10);
    const after = await getPage("pg_was");
    expect(after["approval"]).toBe("neutral");
    expect(after["approval_previous"]).toBe("approved");
    expect(after["approval_notice"]).toBe(`Was approved; changed since by claude-code/2.0.0 on ${today}, not yet re-reviewed.`);
  });
});
