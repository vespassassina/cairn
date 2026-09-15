import { describe, expect, it } from "vitest";
import { sourceHref } from "../src/sources.js";

/**
 * The CLI's duplicate of `packages/core/src/sources.ts`'s `sourceHref`
 * (hard rule 16 keeps `@cairn/core` out of the CLI's runtime). Same cases as
 * `packages/core/test/sources.test.ts`, so the two stay in step.
 */

describe("sourceHref", () => {
  it("uses a web address as is", () => {
    expect(sourceHref("https://example.com/paper")).toBe("https://example.com/paper");
  });

  it("resolves a bare or doi:-prefixed DOI to doi.org", () => {
    expect(sourceHref("10.1038/s41586-021-03819-2")).toBe("https://doi.org/10.1038/s41586-021-03819-2");
    expect(sourceHref("doi: 10.1038/s41586-021-03819-2")).toBe("https://doi.org/10.1038/s41586-021-03819-2");
  });

  it("resolves a PubMed id", () => {
    expect(sourceHref("PMID: 12345678")).toBe("https://pubmed.ncbi.nlm.nih.gov/12345678/");
  });

  it("returns null for a plain citation with no address", () => {
    expect(sourceHref("Smith 2021, J Pept Sci")).toBeNull();
  });
});
