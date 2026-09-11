import type { Id, Version } from "./types.js";

export class CairnError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends CairnError {
  constructor(
    readonly kind: string,
    readonly id: Id,
  ) {
    super(`${kind} ${id} not found`, "not_found");
  }
}

/**
 * Optimistic concurrency failure. Carries the current record so the caller can
 * merge and retry without a second read (PRD section 5, edge case 3).
 */
export class VersionConflictError<T = unknown> extends CairnError {
  constructor(
    readonly kind: string,
    readonly id: Id,
    readonly expected: Version | null,
    readonly current: T | null,
  ) {
    super(
      `${kind} ${id} changed since version ${expected ?? "(create)"}`,
      "version_conflict",
    );
  }
}

export interface FieldError {
  field: string;
  message: string;
}

/**
 * Field-level validation failure. The message names every offending field so
 * Claude can fix the call without asking the user (PRD P0.4).
 */
export class ValidationError extends CairnError {
  constructor(readonly errors: FieldError[]) {
    super(
      `invalid fields: ${errors.map((e) => `${e.field} (${e.message})`).join(", ")}`,
      "validation_failed",
    );
  }
}

/** An operation an adapter does not claim to support. */
export class UnsupportedError extends CairnError {
  constructor(capability: string) {
    super(`adapter does not support ${capability}`, "unsupported");
  }
}
