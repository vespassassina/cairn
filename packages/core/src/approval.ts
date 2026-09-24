import { diffLines } from "./history/diff.js";
import type { Approval } from "./types.js";

/**
 * The approval mark across later edits (ADR-078 decision 3).
 *
 * A person approved a body. A later edit that changes little of it, such as
 * a typo fix or one added link, does not undo their judgement; a rewrite
 * does. "Little" is measured in characters against the body they looked
 * at, never against the last write, so small edits cannot add up past the
 * threshold unseen. Both numbers are starting guesses, expected to change
 * once from evidence; every decision is written into the revision note so
 * the changes screen shows when they were wrong.
 */
export const CARRY_OVER = {
  /** Share of the approved body that may change: 5 %. */
  maxShare: 0.05,
  /** And never more than this many characters, whatever the length. */
  maxChars: 200,
} as const;

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let n = 0;
  while (n < max && a.charCodeAt(n) === b.charCodeAt(n)) n += 1;
  return n;
}

function commonSuffix(a: string, b: string, limit: number): number {
  let n = 0;
  while (n < limit && a.charCodeAt(a.length - 1 - n) === b.charCodeAt(b.length - 1 - n)) n += 1;
  return n;
}

/** Characters differing between two lines, once their shared ends are set aside. */
function changedWithin(before: string, after: string): number {
  const prefix = commonPrefix(before, after);
  const suffix = commonSuffix(before, after, Math.min(before.length, after.length) - prefix);
  return before.length - prefix - suffix + (after.length - prefix - suffix);
}

/**
 * Characters added plus removed between two texts. Lines are diffed first,
 * then each removed line is paired with the added line that replaced it and
 * only the part that differs is counted, so a typo fix costs a few
 * characters, not its whole line. A line with no partner counts whole, plus
 * its line break.
 */
export function changedChars(before: string, after: string): number {
  if (before === after) return 0;
  const diff = diffLines(before, after);
  let total = 0;
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    const pairs = Math.min(removed.length, added.length);
    for (let i = 0; i < pairs; i += 1) total += changedWithin(removed[i]!, added[i]!);
    for (const line of removed.slice(pairs)) total += line.length + 1;
    for (const line of added.slice(pairs)) total += line.length + 1;
    removed = [];
    added = [];
  };
  for (const line of diff.lines) {
    if (line.op === "remove") removed.push(line.text);
    else if (line.op === "add") added.push(line.text);
    else flush();
  }
  flush();
  return total;
}

export interface EditMeasure {
  titleChanged: boolean;
  changedChars: number;
  /** Length of the body the person approved. */
  baselineLength: number;
}

/** Whether a marked page keeps its mark after an edit of this size. */
export function approvalAfterEdit(measure: EditMeasure): { keep: boolean } {
  if (measure.titleChanged) return { keep: false };
  const allowed = Math.min(CARRY_OVER.maxChars, Math.floor(measure.baselineLength * CARRY_OVER.maxShare));
  return { keep: measure.changedChars <= allowed };
}

/** The suffix the revision note carries, so the rule's every decision is on record. */
export function carryOverNote(kept: boolean, was: Approval): string {
  return kept ? "(approval kept: small change)" : `(approval reset: was ${was})`;
}
