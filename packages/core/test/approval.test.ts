import { describe, expect, it } from "vitest";
import { approvalAfterEdit, changedChars, CARRY_OVER } from "../src/approval.js";

/**
 * The carry-over rule (ADR-078 decision 3), on its own. The api test drives
 * it through a real write; this one pins the measure and the thresholds.
 */

describe("changedChars", () => {
  it("counts a typo fix as the characters it touched, wherever it sits", () => {
    const before = "Line one.\nLine two has a tpyo in it.\nLine three.";
    const after = "Line one.\nLine two has a typo in it.\nLine three.";
    expect(changedChars(before, after)).toBe(4);
  });

  it("counts two fixes on different lines separately, not the span between them", () => {
    const before = "Frist line.\n" + "middle\n".repeat(50) + "Last lnie.";
    const after = "First line.\n" + "middle\n".repeat(50) + "Last line.";
    expect(changedChars(before, after)).toBeLessThanOrEqual(8);
  });

  it("counts an added paragraph as its whole length", () => {
    const before = "One.\n\nTwo.";
    const after = "One.\n\nAnd a half.\n\nTwo.";
    expect(changedChars(before, after)).toBe("And a half.\n\n".length);
  });

  it("counts a full rewrite as everything removed plus everything added", () => {
    expect(changedChars("abc", "xyzw")).toBe(7);
    expect(changedChars("", "")).toBe(0);
  });
});

describe("approvalAfterEdit", () => {
  const baseline = "x".repeat(2000);

  it("keeps the mark under both thresholds, and resets past either or on a title change", () => {
    const cases: { title: boolean; changed: number; length: number; keep: boolean }[] = [
      { title: false, changed: 3, length: 2000, keep: true },
      { title: false, changed: 100, length: 2000, keep: true },
      { title: false, changed: 101, length: 2000, keep: false },
      { title: false, changed: 200, length: 10_000, keep: true },
      { title: false, changed: 201, length: 10_000, keep: false },
      { title: false, changed: 200, length: 1000, keep: false },
      { title: true, changed: 0, length: 2000, keep: false },
    ];
    for (const c of cases) {
      const verdict = approvalAfterEdit({ titleChanged: c.title, changedChars: c.changed, baselineLength: c.length });
      expect(verdict.keep, JSON.stringify(c)).toBe(c.keep);
    }
    expect(CARRY_OVER).toEqual({ maxShare: 0.05, maxChars: 200 });
    expect(baseline.length).toBe(2000);
  });
});
