import { describe, expect, it } from "vitest";
import { diffLines } from "../src/index.js";

describe("diffLines", () => {
  it("reports no change for identical text", () => {
    const diff = diffLines("a\nb\nc", "a\nb\nc");
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.lines.every((line) => line.op === "equal")).toBe(true);
  });

  it("finds a changed line in the middle", () => {
    const diff = diffLines("a\nold\nc", "a\nnew\nc");
    expect(diff.lines).toEqual([
      { op: "equal", text: "a" },
      { op: "remove", text: "old" },
      { op: "add", text: "new" },
      { op: "equal", text: "c" },
    ]);
  });

  it("handles additions at the end and removals at the start", () => {
    expect(diffLines("x\na", "a\nb").lines).toEqual([
      { op: "remove", text: "x" },
      { op: "equal", text: "a" },
      { op: "add", text: "b" },
    ]);
  });

  it("treats empty text as no lines", () => {
    expect(diffLines("", "a").lines).toEqual([{ op: "add", text: "a" }]);
    expect(diffLines("a", "").lines).toEqual([{ op: "remove", text: "a" }]);
    expect(diffLines("", "").lines).toEqual([]);
  });

  it("falls back to a coarse diff rather than stalling on huge input", () => {
    const big = Array.from({ length: 3_000 }, (_, i) => `line ${i}`).join("\n");
    const diff = diffLines(big, `${big}\nmore`);
    expect(diff.coarse).toBe(true);
    expect(diff.added).toBe(3_001);
  });
});
