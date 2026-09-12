/**
 * Short-lived and small records the OAuth server keeps (ADR-017): client
 * registrations, pending sign-ins, authorization codes and refresh tokens.
 *
 * Separate from the document store on purpose. None of it is the owner's
 * content, so it never appears in history, search or an export, and a leak of
 * an export never leaks a token. Every backend has a cheap way to do this:
 * a SQLite table, a Cosmos container with TTL, a DynamoDB table with TTL.
 */

/** What a record is. Keys are unique within a kind. */
export type AuthRecordKind =
  | "client"
  | "pending"
  | "code"
  | "refresh"
  | "refresh_used"
  | "family_revoked";

export interface AuthStore {
  init(): Promise<void>;
  close(): Promise<void>;

  /**
   * Write or replace a record. `expiresAt` is an ISO time after which the
   * record reads as absent; null keeps it until deleted.
   */
  putAuth(kind: AuthRecordKind, key: string, value: unknown, expiresAt: string | null): Promise<void>;

  /** The record, or null when it is missing or expired. */
  getAuth<T = unknown>(kind: AuthRecordKind, key: string): Promise<T | null>;

  /**
   * Read and delete in one step. Of any number of concurrent callers, exactly
   * one gets the record and the rest get null. This is what makes an
   * authorization code or a refresh token usable only once.
   */
  takeAuth<T = unknown>(kind: AuthRecordKind, key: string): Promise<T | null>;
}
