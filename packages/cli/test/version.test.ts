import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { closeContext, createApp, createContext } from "@cairn/api";
import { VERSION } from "../src/main.js";

/**
 * One version for a release: the root package.json. `pnpm set-version` writes
 * it everywhere; this fails when a place was edited by hand and missed.
 */

const json = async (path: string) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")) as { version?: string };

describe("the version", () => {
  it("is the same in the root package.json, the CLI and the server", async () => {
    const release = (await json("../../../package.json")).version;
    expect(release).toMatch(/^\d+\.\d+\.\d+$/);
    expect((await json("../package.json")).version).toBe(release);
    expect(VERSION).toBe(release);

    const context = await createContext({ database: ":memory:", workspaceId: "ws_version" });
    try {
      const response = await createApp({ context, token: null }).fetch(new Request("http://localhost/health"));
      expect(((await response.json()) as { server: { version: string } }).server.version).toBe(release);
    } finally {
      await closeContext(context);
    }
  });
});
