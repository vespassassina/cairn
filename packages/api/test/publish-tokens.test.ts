import { NotFoundError } from "@cairn/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeContext, createContext, OWNER, type AppContext } from "../src/context.js";
import {
  activeTokenPageIds,
  createPublishToken,
  listPublishTokens,
  revokePublishToken,
  verifyPublishToken,
} from "../src/publish-tokens.js";

/**
 * Publish tokens (ADR-066): issuing, listing, revoking, and the two checks
 * `/w` relies on to decide whether a subtree needs one. `tokenHash` never
 * appearing in a read is asserted directly, since that is the one thing this
 * module has to get right on its own (ADR-066 decision 5).
 */

describe("publish tokens", () => {
  let context: AppContext;

  beforeEach(async () => {
    context = await createContext({ database: ":memory:", workspaceId: "ws_publish_tokens" });
  });

  afterEach(async () => {
    await closeContext(context);
  });

  async function page(id: string, isPublic = true) {
    return context.pages.create(context.workspaceId, { title: id, body: "", public: isPublic }, { actor: OWNER }, id);
  }

  it("shows the raw token once, at creation, and stores only its hash", async () => {
    await page("pg_root");
    const created = await createPublishToken(context, { pageId: "pg_root", name: "accountant", description: null }, { actor: OWNER });
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(created).not.toHaveProperty("tokenHash");

    const listed = await listPublishTokens(context, "pg_root");
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("tokenHash");
    expect(listed[0]?.token).toBeUndefined();
  });

  it("refuses to issue a token for a page that does not exist", async () => {
    await expect(
      createPublishToken(context, { pageId: "gone", name: "x", description: null }, { actor: OWNER }),
    ).rejects.toThrow(NotFoundError);
  });

  it("verifies the exact token issued, and rejects a wrong one", async () => {
    await page("pg_root");
    const created = await createPublishToken(context, { pageId: "pg_root", name: "accountant", description: null }, { actor: OWNER });
    await expect(verifyPublishToken(context, "pg_root", created.token)).resolves.toBe(true);
    await expect(verifyPublishToken(context, "pg_root", "wrong-token")).resolves.toBe(false);
  });

  it("no token issued for a page means it needs none", async () => {
    await page("pg_open");
    expect(await activeTokenPageIds(context)).toEqual(new Set());
    await expect(verifyPublishToken(context, "pg_open", "anything")).resolves.toBe(false);
  });

  it("a revoked token no longer verifies, and drops out of the active set", async () => {
    await page("pg_root");
    const created = await createPublishToken(context, { pageId: "pg_root", name: "accountant", description: null }, { actor: OWNER });
    expect(await activeTokenPageIds(context)).toEqual(new Set(["pg_root"]));

    const revoked = await revokePublishToken(context, created.id, { actor: OWNER });
    expect(revoked.revokedAt).not.toBeNull();
    await expect(verifyPublishToken(context, "pg_root", created.token)).resolves.toBe(false);
    expect(await activeTokenPageIds(context)).toEqual(new Set());
  });

  it("revoking an already-revoked token is a no-op, not an error", async () => {
    await page("pg_root");
    const created = await createPublishToken(context, { pageId: "pg_root", name: "a", description: null }, { actor: OWNER });
    await revokePublishToken(context, created.id, { actor: OWNER });
    const again = await revokePublishToken(context, created.id, { actor: OWNER });
    expect(again.revokedAt).toBe((await listPublishTokens(context, "pg_root"))[0]?.revokedAt);
  });

  it("keeps a subtree open while one of several tokens for it is still unrevoked", async () => {
    await page("pg_root");
    const a = await createPublishToken(context, { pageId: "pg_root", name: "a", description: null }, { actor: OWNER });
    const b = await createPublishToken(context, { pageId: "pg_root", name: "b", description: null }, { actor: OWNER });
    await revokePublishToken(context, a.id, { actor: OWNER });
    expect(await activeTokenPageIds(context)).toEqual(new Set(["pg_root"]));
    await expect(verifyPublishToken(context, "pg_root", a.token)).resolves.toBe(false);
    await expect(verifyPublishToken(context, "pg_root", b.token)).resolves.toBe(true);
  });

  it("lists every token issued for a page, revoked or not", async () => {
    await page("pg_root");
    await createPublishToken(context, { pageId: "pg_root", name: "first", description: "for X" }, { actor: OWNER });
    await createPublishToken(context, { pageId: "pg_root", name: "second", description: null }, { actor: OWNER });
    const listed = await listPublishTokens(context, "pg_root");
    expect(listed.map((t) => t.name).sort()).toEqual(["first", "second"]);
  });

  it("revoking an id from a workspace with no publish-tokens table yet fails clearly", async () => {
    await expect(revokePublishToken(context, "nope", { actor: OWNER })).rejects.toThrow(NotFoundError);
  });
});
