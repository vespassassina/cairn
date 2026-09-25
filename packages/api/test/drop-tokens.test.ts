import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeContext, createContext, OWNER, type AppContext } from "../src/context.js";
import {
  createDropToken,
  DROP_TOKEN_PREFIX,
  DROP_TOKENS_TABLE_NAME,
  listDropTokens,
  revokeDropToken,
  touchDropToken,
  verifyDropToken,
} from "../src/drop-tokens.js";

/**
 * Drop tokens (ADR-079 decision 3): named, revocable, one endpoint. Shown
 * once, hashed at rest (hard rule 18), `last_used_at` moving on every use so
 * a leaked token shows. The scope refusal lives in the app's auth check and
 * is tested in rest.test.ts.
 */

describe("drop tokens", () => {
  let context: AppContext;

  beforeEach(async () => {
    context = await createContext({ database: ":memory:", workspaceId: "ws_drop_tokens" });
  });

  afterEach(async () => {
    await closeContext(context);
  });

  it("shows the raw token once, with its prefix, and stores only the hash", async () => {
    const created = await createDropToken(context, { name: "phone", description: "iPhone share sheet", kind: "person" }, { actor: OWNER });
    expect(created.token.startsWith(DROP_TOKEN_PREFIX)).toBe(true);
    expect(created.token.length).toBeGreaterThan(DROP_TOKEN_PREFIX.length + 40);
    expect(created.kind).toBe("person");
    expect(created.lastUsedAt).toBeNull();
    expect(created.revokedAt).toBeNull();

    const listed = await listDropTokens(context);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect(listed[0]).not.toHaveProperty("tokenHash");
    expect(listed[0]).not.toHaveProperty("token");

    // Nor does the row itself hold it: only the hash.
    const table = (await context.tables.list(context.workspaceId)).find((t) => t.name === DROP_TOKENS_TABLE_NAME);
    const rows = await context.tables.queryRows(context.workspaceId, table!.id, { limit: 10 });
    expect(JSON.stringify(rows.items)).not.toContain(created.token);
  });

  it("verifies the token issued, tells a revoked one from an unknown one, and moves last_used_at on use", async () => {
    const created = await createDropToken(context, { name: "script", description: null, kind: "agent" }, { actor: OWNER });
    const found = await verifyDropToken(context, created.token);
    expect(found).toMatchObject({ status: "valid", id: created.id, name: "script", kind: "agent" });
    expect(await verifyDropToken(context, `${DROP_TOKEN_PREFIX}nope`)).toEqual({ status: "unknown" });

    await touchDropToken(context, created.id);
    const [after] = await listDropTokens(context);
    expect(after?.lastUsedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const revoked = await revokeDropToken(context, created.id, { actor: OWNER });
    expect(revoked.revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await verifyDropToken(context, created.token)).toMatchObject({ status: "revoked", name: "script" });
    // Idempotent.
    const again = await revokeDropToken(context, created.id, { actor: OWNER });
    expect(again.revokedAt).toBe(revoked.revokedAt);
  });

  it("refuses a blank name and a kind that is neither person nor agent", async () => {
    await expect(createDropToken(context, { name: "  ", description: null, kind: "person" }, { actor: OWNER })).rejects.toThrow(/name/);
    await expect(
      createDropToken(context, { name: "x", description: null, kind: "robot" as unknown as "agent" }, { actor: OWNER }),
    ).rejects.toThrow(/person or agent/);
  });
});
