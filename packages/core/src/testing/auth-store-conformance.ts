import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthStore } from "../ports/auth-store.js";

/**
 * Every AuthStore passes this unchanged (CLAUDE.md hard rule 2, ADR-017).
 */
export function runAuthStoreConformance(name: string, factory: { create: () => Promise<AuthStore> }): void {
  describe(`auth store conformance: ${name}`, () => {
    let store: AuthStore;
    const inAMinute = () => new Date(Date.now() + 60_000).toISOString();

    beforeEach(async () => {
      store = await factory.create();
      await store.init();
    });
    afterEach(async () => {
      await store.close();
    });

    it("stores, reads and replaces a record", async () => {
      await store.putAuth("client", "c1", { name: "Claude" }, null);
      expect(await store.getAuth("client", "c1")).toEqual({ name: "Claude" });
      await store.putAuth("client", "c1", { name: "Claude Code" }, null);
      expect(await store.getAuth("client", "c1")).toEqual({ name: "Claude Code" });
      expect(await store.getAuth("client", "missing")).toBeNull();
    });

    it("keeps kinds apart", async () => {
      await store.putAuth("code", "same", { a: 1 }, inAMinute());
      await store.putAuth("refresh", "same", { b: 2 }, inAMinute());
      expect(await store.getAuth("code", "same")).toEqual({ a: 1 });
      expect(await store.getAuth("refresh", "same")).toEqual({ b: 2 });
    });

    it("treats an expired record as absent", async () => {
      await store.putAuth("pending", "old", { x: 1 }, new Date(Date.now() - 1000).toISOString());
      expect(await store.getAuth("pending", "old")).toBeNull();
      expect(await store.takeAuth("pending", "old")).toBeNull();
    });

    it("hands a record to exactly one taker", async () => {
      await store.putAuth("code", "once", { sub: "github:owner" }, inAMinute());
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => store.takeAuth("code", "once")));
      expect(results.filter((r) => r !== null)).toEqual([{ sub: "github:owner" }]);
      expect(await store.getAuth("code", "once")).toBeNull();
    });
  });
}
