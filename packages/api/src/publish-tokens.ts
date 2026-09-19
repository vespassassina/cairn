import { NotFoundError } from "@cairn/core";
import type { WriteContext } from "@cairn/core";
import type { AppContext } from "./context.js";
import { ownerVia } from "./context.js";
import { randomToken, sha256 } from "./oauth/crypto.js";

/**
 * Token-gated publishing (ADR-066): a published subtree can carry one or
 * more named, revocable tokens. No token issued for a subtree means the
 * ADR-032 behaviour is unchanged, no auth. A token is attached to the page
 * it is issued on and gates everything published beneath it.
 *
 * Same shape as `citations.ts`: an ordinary table, created on first use,
 * read and written through the generic table service. The one thing this
 * module guards on its own is `tokenHash`: it is never returned by any
 * function here, only checked against.
 */

/** The table this feature reads and writes, created on first use. */
export const PUBLISH_TOKENS_TABLE_NAME = "Publish tokens";

async function findOrCreateTable(context: AppContext) {
  const existing = (await context.tables.list(context.workspaceId)).find((t) => t.name === PUBLISH_TOKENS_TABLE_NAME);
  if (existing) return existing;
  return context.tables.create(
    context.workspaceId,
    {
      name: PUBLISH_TOKENS_TABLE_NAME,
      fields: [
        { name: "page", type: "relation", target: "pages", required: true },
        { name: "name", type: "text", required: true },
        { name: "description", type: "text" },
        { name: "token_hash", type: "text", required: true },
        { name: "revoked_at", type: "text" },
      ],
    },
    { actor: ownerVia("publish-token") },
  );
}

export interface PublishTokenSummary {
  id: string;
  page: string;
  name: string;
  description: string | null;
  createdAt: string;
  revokedAt: string | null;
}

function summarize(row: { id: string; values: Record<string, unknown>; createdAt: string }): PublishTokenSummary {
  return {
    id: row.id,
    page: String(row.values["page"] ?? ""),
    name: String(row.values["name"] ?? ""),
    description: typeof row.values["description"] === "string" ? (row.values["description"] as string) : null,
    createdAt: row.createdAt,
    revokedAt: typeof row.values["revoked_at"] === "string" ? (row.values["revoked_at"] as string) : null,
  };
}

/**
 * Issues a token for `pageId`'s subtree. The raw value is returned once,
 * here, and never again: only its hash is stored (ADR-066 decision 2).
 */
export async function createPublishToken(
  context: AppContext,
  params: { pageId: string; name: string; description: string | null | undefined },
  by: WriteContext,
): Promise<PublishTokenSummary & { token: string }> {
  const page = await context.store.getPage(context.workspaceId, params.pageId);
  if (!page) throw new NotFoundError("page", params.pageId);

  const table = await findOrCreateTable(context);
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const row = await context.tables.upsertRow(
    context.workspaceId,
    table.id,
    {
      values: {
        page: params.pageId,
        name: params.name,
        description: params.description ?? null,
        token_hash: tokenHash,
        revoked_at: null,
      },
    },
    by,
  );
  return { ...summarize(row), token };
}

/** Every token issued for `pageId`, revoked or not. Never carries a token value. */
export async function listPublishTokens(context: AppContext, pageId: string): Promise<PublishTokenSummary[]> {
  const table = (await context.tables.list(context.workspaceId)).find((t) => t.name === PUBLISH_TOKENS_TABLE_NAME);
  if (!table) return [];
  const summaries: PublishTokenSummary[] = [];
  let cursor: string | null = null;
  do {
    const batch = await context.tables.queryRows(context.workspaceId, table.id, {
      where: [{ field: "page", op: "eq", value: pageId }],
      limit: 500,
      cursor,
    });
    for (const row of batch.items) summaries.push(summarize(row));
    cursor = batch.cursor;
  } while (cursor !== null);
  return summaries;
}

/** Revokes a token. Idempotent: revoking an already-revoked token changes nothing. */
export async function revokePublishToken(context: AppContext, id: string, by: WriteContext): Promise<PublishTokenSummary> {
  const table = (await context.tables.list(context.workspaceId)).find((t) => t.name === PUBLISH_TOKENS_TABLE_NAME);
  if (!table) throw new NotFoundError("publish_token", id);
  const row = await context.tables.getRow(context.workspaceId, table.id, id);
  if (row.values["revoked_at"]) return summarize(row);
  const updated = await context.tables.upsertRow(
    context.workspaceId,
    table.id,
    { values: { ...row.values, revoked_at: new Date().toISOString() } },
    by,
    { id: row.id, expectedVersion: row.version },
  );
  return summarize(updated);
}

/** Every page id that currently has at least one unrevoked token (ADR-066 decision 4). */
export async function activeTokenPageIds(context: AppContext): Promise<Set<string>> {
  const table = (await context.tables.list(context.workspaceId)).find((t) => t.name === PUBLISH_TOKENS_TABLE_NAME);
  if (!table) return new Set();
  const pages = new Set<string>();
  let cursor: string | null = null;
  do {
    const batch = await context.tables.queryRows(context.workspaceId, table.id, { limit: 500, cursor });
    for (const row of batch.items) {
      if (!row.values["revoked_at"] && typeof row.values["page"] === "string") pages.add(row.values["page"]);
    }
    cursor = batch.cursor;
  } while (cursor !== null);
  return pages;
}

/** Whether `presented` is a currently valid, unrevoked token for `gateRootId`. */
export async function verifyPublishToken(context: AppContext, gateRootId: string, presented: string): Promise<boolean> {
  const table = (await context.tables.list(context.workspaceId)).find((t) => t.name === PUBLISH_TOKENS_TABLE_NAME);
  if (!table) return false;
  const presentedHash = await sha256(presented);
  let cursor: string | null = null;
  do {
    const batch = await context.tables.queryRows(context.workspaceId, table.id, {
      where: [{ field: "page", op: "eq", value: gateRootId }],
      limit: 500,
      cursor,
    });
    for (const row of batch.items) {
      if (!row.values["revoked_at"] && row.values["token_hash"] === presentedHash) return true;
    }
    cursor = batch.cursor;
  } while (cursor !== null);
  return false;
}
