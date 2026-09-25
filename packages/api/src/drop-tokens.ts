import { NotFoundError, ValidationError } from "@cairn/core";
import type { WriteContext } from "@cairn/core";
import type { AppContext } from "./context.js";
import { ownerVia } from "./context.js";
import { randomToken, sha256 } from "./oauth/crypto.js";

/**
 * Drop tokens (ADR-079 decision 3): a named, revocable token that opens one
 * door, `POST /api/v1/drops`, so a phone's share sheet or a script can drop
 * without OAuth and without a full-scope token to leak. The shape of
 * `publish-tokens.ts`: an ordinary table created on first use, the raw
 * value returned once at creation, only its hash stored (hard rule 18).
 *
 * `kind` says who is behind the token, chosen when it is made: a person's
 * phone or an agent's script. A drop made with it is written as that kind,
 * labelled with the token's name, so the changes feed and the review queue
 * (ADR-078) tell the two apart (decision 4).
 */

export const DROP_TOKENS_TABLE_NAME = "Drop tokens";

/** Every drop token starts with this, so the auth check can route it without a lookup. */
export const DROP_TOKEN_PREFIX = "cairn_drop_";

export type DropTokenKind = "person" | "agent";

async function findTable(context: AppContext) {
  return (await context.tables.list(context.workspaceId)).find((t) => t.name === DROP_TOKENS_TABLE_NAME) ?? null;
}

async function findOrCreateTable(context: AppContext) {
  const existing = await findTable(context);
  if (existing) return existing;
  return context.tables.create(
    context.workspaceId,
    {
      name: DROP_TOKENS_TABLE_NAME,
      fields: [
        { name: "name", type: "text", required: true },
        { name: "description", type: "text" },
        { name: "kind", type: "select", options: ["person", "agent"], required: true },
        { name: "token_hash", type: "text", required: true },
        { name: "last_used_at", type: "text" },
        { name: "revoked_at", type: "text" },
      ],
    },
    { actor: ownerVia("drop-token") },
  );
}

export interface DropTokenSummary {
  id: string;
  name: string;
  description: string | null;
  kind: DropTokenKind;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function text(values: Record<string, unknown>, name: string): string | null {
  return typeof values[name] === "string" ? (values[name] as string) : null;
}

function summarize(row: { id: string; values: Record<string, unknown>; createdAt: string }): DropTokenSummary {
  return {
    id: row.id,
    name: String(row.values["name"] ?? ""),
    description: text(row.values, "description"),
    kind: row.values["kind"] === "person" ? "person" : "agent",
    createdAt: row.createdAt,
    lastUsedAt: text(row.values, "last_used_at"),
    revokedAt: text(row.values, "revoked_at"),
  };
}

/** Issues a token. The raw value is returned here and never again. */
export async function createDropToken(
  context: AppContext,
  params: { name: string; description: string | null | undefined; kind: DropTokenKind },
  by: WriteContext,
): Promise<DropTokenSummary & { token: string }> {
  const name = params.name.trim();
  const errors: Array<{ field: string; message: string }> = [];
  if (!name) errors.push({ field: "name", message: "required: a name that says where the token lives, such as phone or cron" });
  if (params.kind !== "person" && params.kind !== "agent") {
    errors.push({ field: "kind", message: `must be person or agent, got ${String(params.kind)}: who is behind the token` });
  }
  if (errors.length > 0) throw new ValidationError(errors);

  const table = await findOrCreateTable(context);
  const token = `${DROP_TOKEN_PREFIX}${randomToken(32)}`;
  const row = await context.tables.upsertRow(
    context.workspaceId,
    table.id,
    {
      values: {
        name,
        description: params.description?.trim() || null,
        kind: params.kind,
        token_hash: await sha256(token),
        last_used_at: null,
        revoked_at: null,
      },
    },
    by,
  );
  return { ...summarize(row), token };
}

/** Every token issued, revoked or not, newest first. Never carries a token value or hash. */
export async function listDropTokens(context: AppContext): Promise<DropTokenSummary[]> {
  const table = await findTable(context);
  if (!table) return [];
  const summaries: DropTokenSummary[] = [];
  let cursor: string | null = null;
  do {
    const batch = await context.tables.queryRows(context.workspaceId, table.id, { limit: 500, cursor });
    for (const row of batch.items) summaries.push(summarize(row));
    cursor = batch.cursor;
  } while (cursor !== null);
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Revokes a token. Idempotent: a token already revoked keeps its first revocation time. */
export async function revokeDropToken(context: AppContext, id: string, by: WriteContext): Promise<DropTokenSummary> {
  const table = await findTable(context);
  if (!table) throw new NotFoundError("drop_token", id);
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

export type DropTokenCheck =
  | { status: "valid"; id: string; name: string; kind: DropTokenKind }
  | { status: "revoked"; id: string; name: string; revokedAt: string }
  | { status: "unknown" };

/**
 * What a presented token is: valid, revoked (so the refusal can say so, and
 * when), or nothing this Cairn issued. Compared by hash, never by value.
 */
export async function verifyDropToken(context: AppContext, presented: string): Promise<DropTokenCheck> {
  const table = await findTable(context);
  if (!table) return { status: "unknown" };
  const presentedHash = await sha256(presented);
  let cursor: string | null = null;
  do {
    const batch = await context.tables.queryRows(context.workspaceId, table.id, {
      where: [{ field: "token_hash", op: "eq", value: presentedHash }],
      limit: 10,
      cursor,
    });
    for (const row of batch.items) {
      const summary = summarize(row);
      if (summary.revokedAt) return { status: "revoked", id: summary.id, name: summary.name, revokedAt: summary.revokedAt };
      return { status: "valid", id: summary.id, name: summary.name, kind: summary.kind };
    }
    cursor = batch.cursor;
  } while (cursor !== null);
  return { status: "unknown" };
}

/**
 * Records a use. Best effort and never thrown: a lost timestamp must not
 * fail the drop it belongs to. Written as the system, not as the caller,
 * since the caller only presented a token.
 */
export async function touchDropToken(context: AppContext, id: string): Promise<void> {
  try {
    const table = await findTable(context);
    if (!table) return;
    const row = await context.tables.getRow(context.workspaceId, table.id, id);
    await context.tables.upsertRow(
      context.workspaceId,
      table.id,
      { values: { ...row.values, last_used_at: new Date().toISOString() } },
      { actor: ownerVia("drop-token") },
      { id: row.id, expectedVersion: row.version },
    );
  } catch {
    // A version race with a revoke, or a missing row: the drop still stands.
  }
}
