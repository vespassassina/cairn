import { VersionConflictError } from "@cairn/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { createApp } from "../src/app.js";
import { closeContext, createContext, OWNER, type AppContext } from "../src/context.js";
import { ApprovalByAgentError, setApproval } from "../src/operations.js";

/**
 * The approval mark (ADR-078 decision 2): only a person sets it, every
 * change is a revision whose note names the new state, and the REST route
 * translates the same way the CLI's `cairn approve` reaches it. Spec
 * criteria 2 and 3 of `docs/specs/knowledge-approval.md`.
 */

const AGENT = { kind: "agent" as const, id: "mcp:dev", label: "Claude Code" };
const TOKEN = "test-token-0123456789abcdef";

describe("setApproval", () => {
  let context: AppContext;

  beforeEach(async () => {
    context = await createContext({ database: ":memory:", workspaceId: "ws_approval" });
  });

  afterEach(async () => {
    await closeContext(context);
  });

  async function page(id = "pg_facts") {
    return context.pages.create(
      context.workspaceId,
      { title: "Facts", body: "The first fact.", tags: [] },
      { actor: AGENT, note: "Written by an agent" },
      id,
    );
  }

  it("lets a person approve a page, records who and when, and names the state in the revision note", async () => {
    const fresh = await page();
    const approved = await setApproval(context, fresh.id, "approved", fresh.version, { actor: OWNER });

    expect(approved.approval).toBe("approved");
    expect(approved.approvalAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The version the person looked at, not the one the mark itself created.
    expect(approved.approvalVersion).toBe(fresh.version);
    expect(approved.approvalPrevious).toBeNull();
    expect(approved.version).not.toBe(fresh.version);
    // Content untouched: the mark is a fact about the page, not an edit of it.
    expect(approved.body).toBe(fresh.body);

    const [latest] = await context.pages.history(context.workspaceId, fresh.id, { limit: 1 });
    expect(latest?.note).toBe("Marked approved");
    expect(latest?.actor.kind).toBe("user");
  });

  it("appends the person's own note after the state, and unmark clears the whole mark", async () => {
    const fresh = await page();
    const disapproved = await setApproval(context, fresh.id, "disapproved", fresh.version, {
      actor: OWNER,
      note: "Dosages are wrong",
    });
    expect(disapproved.approval).toBe("disapproved");
    let [latest] = await context.pages.history(context.workspaceId, fresh.id, { limit: 1 });
    expect(latest?.note).toBe("Marked disapproved: Dosages are wrong");

    const cleared = await setApproval(context, fresh.id, "neutral", disapproved.version, { actor: OWNER });
    expect(cleared.approval).toBe("neutral");
    expect(cleared.approvalAt).toBeNull();
    expect(cleared.approvalVersion).toBeNull();
    expect(cleared.approvalPrevious).toBeNull();
    [latest] = await context.pages.history(context.workspaceId, fresh.id, { limit: 1 });
    expect(latest?.note).toBe("Approval mark removed");
  });

  it("refuses an agent, naming the console and cairn approve, and changes nothing", async () => {
    const fresh = await page();
    const attempt = setApproval(context, fresh.id, "approved", fresh.version, { actor: AGENT });
    await expect(attempt).rejects.toBeInstanceOf(ApprovalByAgentError);
    await expect(attempt).rejects.toThrow(/console/);
    await expect(attempt).rejects.toThrow(/cairn approve/);

    const unchanged = await context.pages.get(context.workspaceId, fresh.id);
    expect(unchanged.approval).toBe("neutral");
    expect(unchanged.version).toBe(fresh.version);
  });

  it("needs the version the person read, like every other write", async () => {
    const fresh = await page();
    await expect(setApproval(context, fresh.id, "approved", "v_stale", { actor: OWNER })).rejects.toBeInstanceOf(
      VersionConflictError,
    );
  });

  it("rejects a state outside the three", async () => {
    const fresh = await page();
    await expect(
      setApproval(context, fresh.id, "verified" as never, fresh.version, { actor: OWNER }),
    ).rejects.toThrow(/approved, neutral, disapproved/);
  });
});

describe("POST /api/v1/pages/:id/approval", () => {
  let context: AppContext;
  let app: Hono;

  beforeEach(async () => {
    context = await createContext({ database: ":memory:", workspaceId: "ws_approval_rest" });
    app = createApp({ context, token: TOKEN });
  });

  afterEach(async () => {
    await closeContext(context);
  });

  async function post(id: string, version: string, body: unknown, headers: Record<string, string> = {}) {
    const response = await app.fetch(
      new Request(`http://localhost/api/v1/pages/${id}/approval`, {
        method: "POST",
        headers: {
          "user-agent": "cairn-cli/0.1.0",
          "content-type": "application/json",
          authorization: `Bearer ${TOKEN}`,
          "if-match": `"${version}"`,
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  it("sets the mark for a caller who declares a person at the keyboard, and returns the four fields", async () => {
    const fresh = await context.pages.create(
      context.workspaceId,
      { title: "Facts", body: "A fact.", tags: [] },
      { actor: OWNER },
      "pg_rest",
    );
    const { status, json } = await post(
      "pg_rest",
      fresh.version,
      { approval: "approved", change_note: "Read it through" },
      { "x-cairn-actor": "person" },
    );
    expect(status).toBe(200);
    expect(json["approval"]).toBe("approved");
    expect(json["approval_version"]).toBe(fresh.version);
    expect(typeof json["approval_at"]).toBe("string");
    expect(json["approval_previous"]).toBeNull();
    expect(json["version"]).not.toBe(fresh.version);

    const [latest] = await context.pages.history(context.workspaceId, "pg_rest", { limit: 1 });
    expect(latest?.note).toBe("Marked approved: Read it through");
    expect(latest?.actor.kind).toBe("user");
  });

  it("refuses a plain API caller with a stable error code, since a token alone means an agent", async () => {
    const fresh = await context.pages.create(
      context.workspaceId,
      { title: "Facts", body: "A fact.", tags: [] },
      { actor: OWNER },
      "pg_rest_agent",
    );
    const { status, json } = await post("pg_rest_agent", fresh.version, { approval: "approved" });
    expect(status).toBe(403);
    expect(json["error"]).toBe("approval_person_only");
    expect(String(json["message"])).toContain("cairn approve");
  });

  it("refuses a stale version with 409 and an unknown state with 400", async () => {
    const fresh = await context.pages.create(
      context.workspaceId,
      { title: "Facts", body: "A fact.", tags: [] },
      { actor: OWNER },
      "pg_rest_stale",
    );
    const stale = await post("pg_rest_stale", "v_old", { approval: "approved" }, { "x-cairn-actor": "person" });
    expect(stale.status).toBe(409);
    expect(stale.json["error"]).toBe("version_conflict");

    const bad = await post("pg_rest_stale", fresh.version, { approval: "yes" }, { "x-cairn-actor": "person" });
    expect(bad.status).toBe(400);
  });
});
