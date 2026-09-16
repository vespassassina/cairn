import { describe, expect, it } from "vitest";
import { statusLines, type StatusInput } from "../src/status.js";

/**
 * `cairn status` (ADR-053, presence.md acceptance criteria 8-11): a pure
 * function over a snapshot of local and remote state, so a healthy machine
 * and a broken one are just two inputs, no server required.
 */

const BASE: StatusInput = {
  instanceName: null,
  baseUrl: "http://localhost:8787",
  reachable: true,
  version: "0.1.5",
  signedIn: true,
  expiresAt: null,
  needsSignIn: false,
  lastSync: null,
  pairCount: 0,
  embeddingsPending: 0,
  jobInstalled: false,
  jobStale: false,
  hookInstalled: true,
  now: Date.now(),
};

describe("statusLines", () => {
  it("reports every line ok on a healthy, single-instance machine", () => {
    const lines = statusLines(BASE);
    expect(lines.every((line) => line.ok)).toBe(true);
    expect(lines.map((line) => line.field)).toEqual(["instance", "sign_in", "sync", "embeddings", "job", "hook"]);
  });

  it("prints three not-ok lines, each with a runnable command, when the server is down, sign-in is missing and no job is installed", () => {
    const lines = statusLines({
      ...BASE,
      reachable: false,
      version: null,
      needsSignIn: true,
      signedIn: false,
      pairCount: 1,
      lastSync: { at: new Date().toISOString(), withName: "cloud" },
      embeddingsPending: null,
      jobInstalled: false,
      hookInstalled: false,
    });
    const bad = lines.filter((line) => !line.ok);
    expect(bad).toHaveLength(3);
    expect(bad.map((line) => line.field)).toEqual(["instance", "sign_in", "job"]);
    for (const line of bad) expect(line.text).toMatch(/cairn \S+/);
  });

  it("never prints a token or secret", () => {
    const lines = statusLines({ ...BASE, signedIn: true, expiresAt: Date.now() + 3_600_000, needsSignIn: true });
    const text = lines.map((line) => line.text).join(" ");
    expect(text).not.toMatch(/[A-Za-z0-9_-]{20,}/);
  });

  it("flags an expired token as not ok, naming the login command", () => {
    const lines = statusLines({ ...BASE, needsSignIn: true, signedIn: true, expiresAt: Date.now() - 1000, instanceName: "cloud" });
    const signIn = lines.find((line) => line.field === "sign_in")!;
    expect(signIn.ok).toBe(false);
    expect(signIn.text).toContain("cairn login --instance cloud");
  });

  it("flags a job that still runs the old cairn sync as not ok", () => {
    const lines = statusLines({ ...BASE, pairCount: 1, jobInstalled: true, jobStale: true });
    const job = lines.find((line) => line.field === "job")!;
    expect(job.ok).toBe(false);
    expect(job.text).toContain("cairn sync install");
  });

  it("does not require a job when there is only one instance", () => {
    const lines = statusLines({ ...BASE, pairCount: 0, jobInstalled: false });
    const job = lines.find((line) => line.field === "job")!;
    expect(job.ok).toBe(true);
  });
});
