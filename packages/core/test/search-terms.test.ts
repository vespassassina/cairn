import { describe, expect, it } from "vitest";
import { foldTerm, queryTerms, requiredMatches, tokenize } from "../src/index.js";

describe("search terms (ADR-021)", () => {
  it("splits on the same boundaries as FTS5 unicode61", () => {
    expect(tokenize("GLP-1 agonists, BLHeli_32!")).toEqual(["glp", "1", "agonists", "blheli", "32"]);
  });

  it("folds case and diacritics", () => {
    expect(foldTerm("Perché")).toBe("perche");
    expect(foldTerm("CAFÉ")).toBe("cafe");
  });

  it("drops function words in English, Italian and Dutch", () => {
    expect(queryTerms("which ESC firmware did I flash on the build")).toEqual([
      "esc",
      "firmware",
      "flash",
      "build",
    ]);
    expect(queryTerms("un peptide per il sonno")).toEqual(["peptide", "sonno"]);
    expect(queryTerms("wat is de dosis van semaglutide")).toEqual(["dosis", "semaglutide"]);
  });

  it("keeps function words when they are all there is", () => {
    expect(queryTerms("the")).toEqual(["the"]);
  });

  it("removes repeated terms", () => {
    expect(queryTerms("tendon Tendon healing")).toEqual(["tendon", "healing"]);
  });

  it("returns no terms for text with no letters or digits", () => {
    expect(queryTerms("?! --")).toEqual([]);
  });

  it("requires every term of a short query and a majority of a longer one", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(requiredMatches)).toEqual([1, 2, 2, 3, 3, 4, 4]);
  });
});
