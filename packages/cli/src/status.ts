/**
 * `cairn status` (ADR-053): one screen for whether Cairn is actually reachable,
 * not five separate things to check by hand. Every line that is not ok carries
 * the command that fixes it, per the coding style rule that every error names
 * the next step.
 *
 * Database size and last-backup age (ADR-053 decision 4, presence.md line 7)
 * are left out of this first cut: `/health` does not report them yet, and
 * wiring the backup engine's state through app.ts is its own piece of work.
 * `docs/specs/presence.md` says so, so the doc and the code agree.
 */

export interface StatusLine {
  /** Stable field name for --json, per coding style rule 4. */
  field: string;
  ok: boolean;
  text: string;
}

export interface StatusInput {
  instanceName: string | null;
  baseUrl: string;
  reachable: boolean;
  version: string | null;
  signedIn: boolean;
  /** Epoch milliseconds, from the credentials file. Null: no sign-in on record. */
  expiresAt: number | null;
  /** Whether this server needs a sign-in at all (loopback and local trust do not). */
  needsSignIn: boolean;
  /** Null when there is only one instance, so nothing syncs. */
  lastSync: { at: string; withName: string } | null;
  pairCount: number;
  /** Null when /health could not be read. */
  embeddingsPending: number | null;
  jobInstalled: boolean;
  /** The job exists but still runs the old `cairn sync`, from before ADR-053. */
  jobStale: boolean;
  hookInstalled: boolean;
  now: number;
}

const HOUR_MS = 60 * 60 * 1000;

function age(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 48 * HOUR_MS) return `${Math.round(ms / HOUR_MS)}h`;
  return `${Math.round(ms / (24 * HOUR_MS))}d`;
}

export function statusLines(input: StatusInput): StatusLine[] {
  const lines: StatusLine[] = [];
  const who = input.instanceName ? `${input.instanceName} (${input.baseUrl})` : input.baseUrl;

  lines.push(
    input.reachable
      ? { field: "instance", ok: true, text: `${who} answered${input.version ? `, version ${input.version}` : ""}` }
      : { field: "instance", ok: false, text: `${who} is not answering. Start it: cairn start` },
  );

  if (input.needsSignIn) {
    if (!input.signedIn) {
      lines.push({ field: "sign_in", ok: false, text: `not signed in. Run: cairn login${input.instanceName ? ` --instance ${input.instanceName}` : ""}` });
    } else if (input.expiresAt !== null && input.expiresAt <= input.now) {
      lines.push({ field: "sign_in", ok: false, text: `signed in, but the token expired. Run: cairn login${input.instanceName ? ` --instance ${input.instanceName}` : ""}` });
    } else {
      const left = input.expiresAt !== null ? `, token good for another ${age(input.expiresAt - input.now)}` : "";
      lines.push({ field: "sign_in", ok: true, text: `signed in${left}` });
    }
  } else {
    lines.push({ field: "sign_in", ok: true, text: "no sign-in needed (loopback or local trust)" });
  }

  if (input.pairCount === 0) {
    lines.push({ field: "sync", ok: true, text: "one instance registered, nothing to sync" });
  } else if (!input.lastSync) {
    lines.push({ field: "sync", ok: false, text: "never synced with the other registered instances. Run: cairn sync" });
  } else {
    const at = new Date(input.lastSync.at).getTime();
    const stale = Number.isFinite(at) && input.now - at > 2 * (input.jobInstalled ? 4 * HOUR_MS : HOUR_MS);
    lines.push(
      stale
        ? { field: "sync", ok: false, text: `last synced with ${input.lastSync.withName} at ${input.lastSync.at}, which is a while ago. Run: cairn sync` }
        : { field: "sync", ok: true, text: `last synced with ${input.lastSync.withName} at ${input.lastSync.at}` },
    );
  }

  lines.push(
    input.embeddingsPending === null
      ? { field: "embeddings", ok: true, text: "pending count unavailable" }
      : { field: "embeddings", ok: true, text: `${input.embeddingsPending} pending` },
  );

  if (!input.jobInstalled) {
    lines.push({ field: "job", ok: input.pairCount === 0, text: input.pairCount === 0 ? "no scheduled job (nothing to sync)" : "no scheduled job. Run: cairn sync install" });
  } else if (input.jobStale) {
    lines.push({ field: "job", ok: false, text: "the scheduled job still runs the old cairn sync. Run: cairn sync install again" });
  } else {
    lines.push({ field: "job", ok: true, text: "scheduled job installed" });
  }

  lines.push(
    input.hookInstalled
      ? { field: "hook", ok: true, text: "session hook installed" }
      : { field: "hook", ok: true, text: "no session hook. Add one: cairn hook install" },
  );

  return lines;
}
