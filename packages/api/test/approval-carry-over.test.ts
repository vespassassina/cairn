import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeContext, createContext, OWNER, type AppContext } from "../src/context.js";
import { editPage, setApproval } from "../src/operations.js";

/**
 * The approval mark across later edits (ADR-078 decision 3, spec criterion
 * 4): a small edit keeps it and says so in the note, anything larger or a
 * title change resets it to neutral and remembers what it was. Driven
 * through `editPage`, the path MCP and REST edits take.
 */

const AGENT = { kind: "agent" as const, id: "mcp:dev", label: "Claude Code" };

describe("approval carry-over", () => {
  let context: AppContext;

  beforeEach(async () => {
    context = await createContext({ database: ":memory:", workspaceId: "ws_carry" });
  });

  afterEach(async () => {
    await closeContext(context);
  });

  async function approvedPage(body: string, state: "approved" | "disapproved" = "approved") {
    const fresh = await context.pages.create(
      context.workspaceId,
      { title: "Dosing", body, tags: [] },
      { actor: AGENT, note: "First draft" },
      "pg_dose",
    );
    return setApproval(context, fresh.id, state, fresh.version, { actor: OWNER });
  }

  const lines = (n: number, width = 40) =>
    Array.from({ length: n }, (_, i) => `Line ${String(i).padStart(3, "0")} ${"word ".repeat(Math.floor(width / 5))}`.trimEnd()).join("\n");

  const cases: {
    name: string;
    body: () => string;
    edit: (body: string) => { body: string; title?: string };
    keep: boolean;
  }[] = [
    {
      name: "3 characters in a 2,000-character page",
      body: () => lines(50),
      edit: (body) => ({ body: body.replace("Line 010", "Line 10a") }),
      keep: true,
    },
    {
      name: "200 characters in a 1,000-character page",
      body: () => lines(25),
      edit: (body) => ({ body: `${body}\n${"new ".repeat(50).trimEnd()}` }),
      keep: false,
    },
    {
      name: "a title change with the body untouched",
      body: () => lines(50),
      edit: (body) => ({ body, title: "Dosing (revised)" }),
      keep: false,
    },
    {
      name: "one appended line in a long page",
      body: () => lines(200),
      edit: (body) => ({ body: `${body}\nSee also [[pg_other]].` }),
      keep: true,
    },
    {
      name: "a rewritten paragraph",
      body: () => lines(50),
      edit: (body) => ({ body: body.split("\n").slice(0, 40).join("\n") + "\n" + "Rewritten. ".repeat(30) }),
      keep: false,
    },
  ];

  for (const c of cases) {
    it(`${c.keep ? "keeps" : "resets"} the mark after ${c.name}`, async () => {
      const approved = await approvedPage(c.body());
      const change = c.edit(approved.body);
      const edited = await editPage(
        context,
        approved.id,
        approved.version,
        { mode: "replace_body", content: change.body, ...(change.title ? { title: change.title } : {}) },
        { actor: AGENT, note: "Agent edit" },
      );
      const [latest] = await context.pages.history(context.workspaceId, approved.id, { limit: 1 });
      if (c.keep) {
        expect(edited.approval).toBe("approved");
        expect(edited.approvalAt).toBe(approved.approvalAt);
        expect(edited.approvalVersion).toBe(approved.approvalVersion);
        expect(edited.approvalPrevious).toBeNull();
        expect(latest?.note).toBe("Agent edit (approval kept: small change)");
      } else {
        expect(edited.approval).toBe("neutral");
        expect(edited.approvalPrevious).toBe("approved");
        // The baseline stays, so the console can diff against it.
        expect(edited.approvalVersion).toBe(approved.approvalVersion);
        expect(edited.approvalAt).toBe(approved.approvalAt);
        expect(latest?.note).toBe("Agent edit (approval reset: was approved)");
      }
    });
  }

  it("measures against the body at approval, not the last write, so small edits cannot add up past the threshold", async () => {
    const approved = await approvedPage(lines(25));
    let page = approved;
    for (let i = 0; i < 3; i += 1) {
      page = await editPage(
        context,
        page.id,
        page.version,
        { mode: "append", content: "x".repeat(40) },
        { actor: AGENT, note: `Append ${i}` },
      );
    }
    // Three appends of 40 characters each: 120 in total, past 5 % of 1,000.
    expect(page.approval).toBe("neutral");
    expect(page.approvalPrevious).toBe("approved");
  });

  it("resets a disapproved page the same way, remembering disapproved", async () => {
    const marked = await approvedPage(lines(25), "disapproved");
    const edited = await editPage(
      context,
      marked.id,
      marked.version,
      { mode: "replace_body", content: "Completely new text." },
      { actor: OWNER },
    );
    expect(edited.approval).toBe("neutral");
    expect(edited.approvalPrevious).toBe("disapproved");
    const [latest] = await context.pages.history(context.workspaceId, marked.id, { limit: 1 });
    expect(latest?.note).toBe("(approval reset: was disapproved)");
  });

  it("leaves a neutral page alone and adds nothing to its note", async () => {
    const fresh = await context.pages.create(
      context.workspaceId,
      { title: "Plain", body: lines(10), tags: [] },
      { actor: AGENT },
      "pg_plain",
    );
    const edited = await editPage(
      context,
      fresh.id,
      fresh.version,
      { mode: "replace_body", content: "Rewritten." },
      { actor: AGENT, note: "Rewrite" },
    );
    expect(edited.approval).toBe("neutral");
    expect(edited.approvalPrevious).toBeNull();
    const [latest] = await context.pages.history(context.workspaceId, fresh.id, { limit: 1 });
    expect(latest?.note).toBe("Rewrite");
  });

  it("lets a write that names the mark win, so sync and import can set exact values", async () => {
    const approved = await approvedPage(lines(25));
    const synced = await context.pages.update(
      context.workspaceId,
      approved.id,
      {
        title: "Dosing",
        body: "Entirely different body from the other Cairn.",
        tags: [],
        approval: "approved",
        approvalAt: "2026-09-20T08:00:00.000Z",
        approvalVersion: "v_remote",
        approvalPrevious: null,
      },
      approved.version,
      { actor: OWNER, note: "sync" },
    );
    expect(synced.approval).toBe("approved");
    expect(synced.approvalVersion).toBe("v_remote");
    const [latest] = await context.pages.history(context.workspaceId, approved.id, { limit: 1 });
    expect(latest?.note).toBe("sync");
  });
});
