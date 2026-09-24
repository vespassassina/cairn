import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { SynonymsStore } from "../ports/synonyms.js";
import type { WorkspaceId } from "../types.js";

/**
 * The shared conformance suite for {@link SynonymsStore} (ADR-077).
 */

export interface SynonymsHarness {
  create(): Promise<SynonymsStore>;
}

const WS: WorkspaceId = "ws_synonyms_conformance";
const OWNER = { kind: "user" as const, id: "owner", label: "Owner" };

export function runSynonymsConformance(name: string, harness: SynonymsHarness): void {
  describe(`SynonymsStore conformance: ${name}`, () => {
    let store: SynonymsStore;

    beforeAll(async () => {
      store = await harness.create();
      await store.init();
    });

    afterAll(async () => {
      await store?.close();
    });

    it("adds a pair and lists it back, folded", async () => {
      const pair = await store.add(WS, "pg_peptides", "GHRP", "growth hormone releasing peptide", {
        actor: OWNER,
      });
      expect(pair.term).toBe("ghrp");
      expect(pair.synonym).toBe("growth hormone releasing peptide");
      expect(pair.collectionId).toBe("pg_peptides");

      const listed = await store.list(WS, "pg_peptides");
      expect(listed.map((p) => p.id)).toContain(pair.id);
    });

    it("scopes list() to one collection", async () => {
      await store.add(WS, "pg_projects", "ci", "continuous integration", { actor: OWNER });
      const peptides = await store.list(WS, "pg_peptides");
      const projects = await store.list(WS, "pg_projects");
      expect(peptides.some((p) => p.term === "ci")).toBe(false);
      expect(projects.some((p) => p.term === "ci")).toBe(true);
    });

    it("listAll() spans every collection in the workspace", async () => {
      const all = await store.listAll(WS);
      expect(all.some((p) => p.collectionId === "pg_peptides")).toBe(true);
      expect(all.some((p) => p.collectionId === "pg_projects")).toBe(true);
    });

    it("adding the same pair twice returns the existing one, not a duplicate", async () => {
      const first = await store.add(WS, "pg_peptides", "bpc", "bpc-157", { actor: OWNER });
      const second = await store.add(WS, "pg_peptides", "bpc", "bpc-157", { actor: OWNER });
      expect(second.id).toBe(first.id);
      const listed = await store.list(WS, "pg_peptides");
      expect(listed.filter((p) => p.term === "bpc" && p.synonym === "bpc-157")).toHaveLength(1);
    });

    it("removes a pair", async () => {
      await store.add(WS, "pg_peptides", "tb500", "thymosin beta 4", { actor: OWNER });
      await store.remove(WS, "pg_peptides", "tb500", "thymosin beta 4");
      const listed = await store.list(WS, "pg_peptides");
      expect(listed.some((p) => p.term === "tb500")).toBe(false);
    });

    it("removing a pair that is not there does nothing", async () => {
      await expect(store.remove(WS, "pg_peptides", "nope", "nothing")).resolves.toBeUndefined();
    });

    it("a workspace's pairs never leak into another workspace", async () => {
      await store.add(WS, "pg_peptides", "only-here", "not-elsewhere", { actor: OWNER });
      const other = await store.listAll("ws_synonyms_other");
      expect(other.some((p) => p.term === "only-here")).toBe(false);
    });
  });
}
