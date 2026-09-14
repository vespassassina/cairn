import { describe, expect, it } from "vitest";
import { MAX_MERGE_CELLS, mergePage, mergeRow, mergeSet, mergeText, mergeValue } from "../src/merge.js";

/**
 * The three-way merge sync uses when both sides changed a record (ADR-030):
 * diff3 on lines, as git merges a file, and whole values or sets for the
 * other fields.
 */

const lines = (...items: string[]) => items.join("\n");

describe("merging a body line by line", () => {
  const base = lines("# BPC-157", "", "## Dosing", "250 mcg a day.", "", "## Evidence", "Rodent studies only.", "");

  it("keeps edits both sides made to different parts", () => {
    const a = base.replace("250 mcg a day.", "250 to 500 mcg a day.");
    const b = base.replace("Rodent studies only.", "Rodent studies, and one small human trial.");
    const merged = mergeText(base, a, b, "a")!;
    expect(merged.conflicts).toBe(0);
    expect(merged.value).toBe(
      lines("# BPC-157", "", "## Dosing", "250 to 500 mcg a day.", "", "## Evidence", "Rodent studies, and one small human trial.", ""),
    );
    // The same whichever side is newer.
    expect(mergeText(base, a, b, "b")!.value).toBe(merged.value);
  });

  it("keeps a line added on one side and one removed on the other", () => {
    const a = base.replace("## Evidence", "## Evidence\nSee the review.");
    const b = base.replace("# BPC-157\n\n", "# BPC-157\n");
    expect(mergeText(base, a, b, "a")!).toEqual({
      value: lines("# BPC-157", "## Dosing", "250 mcg a day.", "", "## Evidence", "See the review.", "Rodent studies only.", ""),
      conflicts: 0,
    });
  });

  it("takes the same change made on both sides once", () => {
    const both = base.replace("250 mcg", "300 mcg");
    expect(mergeText(base, both, both, "b")).toEqual({ value: both, conflicts: 0 });
    const a = both.replace("Rodent", "Animal");
    expect(mergeText(base, a, both, "b")).toEqual({ value: a, conflicts: 0 });
  });

  it("takes the newer edit where both changed the same lines, and counts it", () => {
    const a = base.replace("250 mcg a day.", "Older: 200 mcg.").replace("Rodent studies only.", "Animal studies.");
    const b = base.replace("250 mcg a day.", "Newer: 300 mcg.");
    const merged = mergeText(base, a, b, "b")!;
    expect(merged.conflicts).toBe(1);
    expect(merged.value).toBe(lines("# BPC-157", "", "## Dosing", "Newer: 300 mcg.", "", "## Evidence", "Animal studies.", ""));
    expect(mergeText(base, a, b, "a")!.value).toContain("Older: 200 mcg.");
  });

  it("counts lines both sides inserted at the same place as a conflict", () => {
    const a = base.replace("## Evidence", "From A.\n## Evidence");
    const b = base.replace("## Evidence", "From B.\n## Evidence");
    const merged = mergeText(base, a, b, "a")!;
    expect(merged.conflicts).toBe(1);
    expect(merged.value).toContain("From A.");
    expect(merged.value).not.toContain("From B.");
  });

  it("merges from an empty base, and to an empty side", () => {
    expect(mergeText("", "x", "", "b")).toEqual({ value: "x", conflicts: 0 });
    expect(mergeText("x\ny", "", "x\ny\nz", "a")).toEqual({ value: "", conflicts: 1 });
  });

  it("gives up on bodies too large to compare, so the newer edit wins", () => {
    const size = Math.ceil(Math.sqrt(MAX_MERGE_CELLS)) + 2;
    const big = (tag: string) => Array.from({ length: size }, (_, k) => `${tag}${k}`).join("\n");
    expect(mergeText(big("o"), big("a"), big("b"), "a")).toBeNull();
  });
});

describe("merging values and sets", () => {
  it("takes whichever side changed a value, and the preferred one when both did", () => {
    expect(mergeValue("x", "x", "y", "a")).toEqual({ value: "y", conflicts: 0 });
    expect(mergeValue("x", "z", "y", "a")).toEqual({ value: "z", conflicts: 1 });
    expect(mergeValue({ p: 1, q: 2 }, { q: 2, p: 1 }, { p: 3, q: 2 }, "a")).toEqual({ value: { p: 3, q: 2 }, conflicts: 0 });
  });

  it("keeps what either side added to a set and drops what either removed", () => {
    expect(mergeSet(["a", "b", "c"], ["a", "b", "c", "d"], ["a", "c", "e"], "a")).toEqual(["a", "c", "d", "e"]);
  });
});

describe("merging whole records", () => {
  const base = { title: "BPC-157", parent_id: null, tags: ["peptide"], body: "one\ntwo\nthree" };

  it("merges a page field by field", () => {
    const a = { ...base, title: "BPC-157 (body protection compound)", body: "one\ntwo\nthree, edited", sources: ["Smith 2021"] };
    const b = { ...base, tags: ["peptide", "healing"], body: "one, edited\ntwo\nthree", verified_at: "2026-09-01T00:00:00.000Z" };
    expect(mergePage(base, a, b, "b")).toEqual({
      value: {
        title: "BPC-157 (body protection compound)",
        parent_id: null,
        tags: ["peptide", "healing"],
        body: "one, edited\ntwo\nthree, edited",
        sources: ["Smith 2021"],
        verified_at: "2026-09-01T00:00:00.000Z",
      },
      conflicts: 0,
    });
  });

  it("keeps the later verification when both sides verified", () => {
    const a = { ...base, verified_at: "2026-09-02T00:00:00.000Z" };
    const b = { ...base, verified_at: "2026-09-01T00:00:00.000Z" };
    expect(mergePage(base, a, b, "b")!.value["verified_at"]).toBe("2026-09-02T00:00:00.000Z");
  });

  it("merges a row field by field, with a removed field staying removed", () => {
    const rowBase = { values: { name: "BPC-157", grams: 5, note: "old" } };
    const a = { values: { name: "BPC-157", grams: 10, note: "old" } };
    const b = { values: { name: "BPC 157", grams: 5 }, sources: ["Jones 2022"] };
    expect(mergeRow(rowBase, a, b, "a")).toEqual({ value: { values: { grams: 10, name: "BPC 157" }, sources: ["Jones 2022"] }, conflicts: 0 });
    expect(mergeRow(rowBase, a, { values: { ...a.values, grams: 7 } }, "b").conflicts).toBe(1);
  });
});
