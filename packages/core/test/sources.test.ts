import { describe, expect, it } from "vitest";
import { isUrlSource, sourceHref } from "../src/sources.js";

/**
 * Recognising a source as a link (ADR-027, roadmap "Citations kept correct").
 * `packages/cli/test/sources.test.ts` runs the same cases against the CLI's
 * duplicate, so the two stay in step.
 */

describe("isUrlSource", () => {
  it("is true for a web address", () => {
    expect(isUrlSource("https://example.com/paper")).toBe(true);
    expect(isUrlSource("http://example.com")).toBe(true);
  });

  it("is false for a DOI, a PubMed id, or a plain citation", () => {
    expect(isUrlSource("10.1038/s41586-021-03819-2")).toBe(false);
    expect(isUrlSource("PMID: 12345678")).toBe(false);
    expect(isUrlSource("Smith 2021, J Pept Sci")).toBe(false);
  });
});

describe("sourceHref", () => {
  it("uses a web address as is", () => {
    expect(sourceHref("https://example.com/paper")).toBe("https://example.com/paper");
  });

  it("resolves a bare DOI to doi.org", () => {
    expect(sourceHref("10.1038/s41586-021-03819-2")).toBe("https://doi.org/10.1038/s41586-021-03819-2");
  });

  it("resolves a doi:-prefixed DOI, case and spacing insensitive", () => {
    expect(sourceHref("DOI:10.1038/s41586-021-03819-2")).toBe("https://doi.org/10.1038/s41586-021-03819-2");
    expect(sourceHref("doi: 10.1038/s41586-021-03819-2")).toBe("https://doi.org/10.1038/s41586-021-03819-2");
  });

  it("resolves a PubMed id, with or without a colon", () => {
    expect(sourceHref("PMID: 12345678")).toBe("https://pubmed.ncbi.nlm.nih.gov/12345678/");
    expect(sourceHref("pmid12345678")).toBe("https://pubmed.ncbi.nlm.nih.gov/12345678/");
  });

  it("returns null for a plain citation with no address", () => {
    expect(sourceHref("Smith 2021, J Pept Sci")).toBeNull();
    expect(sourceHref("the owner, in conversation")).toBeNull();
  });
});
