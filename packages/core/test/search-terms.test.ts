import { describe, expect, it } from "vitest";
import { foldTerm, isNegatedEverywhere, queryTerms, requiredMatches, sameWords, tokenize } from "../src/index.js";

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

  it("treats a query as a title's own words, ignoring case, accents and punctuation (ADR-025)", () => {
    expect(sameWords("bpc 157", "BPC-157")).toBe(true);
    expect(sameWords("Fat loss", "Fat loss")).toBe(true);
    expect(sameWords("Crème", "creme")).toBe(true);
    expect(sameWords("BPC-157 dosage", "BPC-157")).toBe(false);
    expect(sameWords("", "BPC-157")).toBe(false);
  });
});

describe("negated matches (ADR-042)", () => {
  it("is negated when the only occurrence sits after a decrease word", () => {
    expect(
      isNegatedEverywhere("more than simply feeling less hungry, plus better sleep", "hungry"),
    ).toBe(true);
  });

  it("is not negated when the term also appears plainly", () => {
    expect(
      isNegatedEverywhere(
        "distinctive strong appetite stimulation. popular for the intense hunger effect, not less hungry",
        "hunger",
      ),
    ).toBe(false);
  });

  it("is not negated when the term never appears", () => {
    expect(isNegatedEverywhere("strong appetite stimulation", "hungry")).toBe(false);
  });

  it("only looks a few words back, not the whole text", () => {
    expect(
      isNegatedEverywhere("less about dosing than about staying hungry", "hungry", 2),
    ).toBe(false);
  });

  it("is case insensitive, like the rest of term matching", () => {
    expect(isNegatedEverywhere("without HUNGER at all", "hunger")).toBe(true);
    expect(isNegatedEverywhere("Reduced Appetite reported by some", "appetite")).toBe(true);
  });
});
