import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeContext, createApp, createContext, OWNER, type AppContext } from "@cairn/api";
import { run, type Io } from "../src/main.js";
import { launchdPlist, schtasksArgs, systemdUnits } from "../src/schedule.js";

/**
 * Named instances (ADR-029): three real Cairns, a laptop and two clouds,
 * behind one injected fetch that can take any of them down. Nothing here
 * installs a job or starts a process: those go through Io, which the tests
 * replace.
 */

const LAPTOP = "http://localhost:4101";
const CLOUD = "https://cloud.example";
const SPARE = "https://spare.example";
const BY = { actor: OWNER, note: null };

let contexts: Record<string, AppContext>;
let apps: Map<string, ReturnType<typeof createApp>>;
let down: Set<string>;
let config: string;
let stdout: string;
let stderr: string;
let calls: Array<{ command: string; args: string[] }>;
let launched: Array<{ command: string; log: string }>;
let platform: string;
let seen: string[];

function io(): Io {
  return {
    fetch: async (request) => {
      const origin = new URL(request.url).origin;
      seen.push(`${origin}${new URL(request.url).pathname}`);
      if (down.has(origin)) throw new TypeError("fetch failed");
      return apps.get(origin)!.fetch(request);
    },
    env: { XDG_CONFIG_HOME: config, APPDATA: config },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: async () => null,
    exec: async (command, args) => {
      calls.push({ command, args });
      return { code: 0, output: "" };
    },
    launch: async (command, log) => {
      launched.push({ command, log });
      down.delete(LAPTOP);
    },
    self: async () => ["/usr/local/bin/node", "/usr/local/lib/node_modules/@cairn/cli/dist/bin.js"],
    platform,
    home: config,
    uid: 501,
    sleep: async () => undefined,
  };
}

async function cairn(...argv: string[]): Promise<number> {
  stdout = "";
  stderr = "";
  return run(argv, io());
}

async function register() {
  expect(await cairn("instances", "add", "laptop", LAPTOP, "--start", "pnpm dev")).toBe(0);
  expect(await cairn("instances", "add", "cloud", `${CLOUD}/`)).toBe(0);
  expect(stdout).toContain("cairn login --instance cloud");
}

beforeEach(async () => {
  contexts = {};
  apps = new Map();
  const trust = { enabled: true, hosts: ["localhost", "cloud.example", "spare.example"] };
  for (const url of [LAPTOP, CLOUD, SPARE]) {
    const context = await createContext({ database: ":memory:", workspaceId: `ws_${new URL(url).hostname}` });
    contexts[url] = context;
    apps.set(url, createApp({ context, token: null, trust }));
  }
  down = new Set();
  calls = [];
  launched = [];
  seen = [];
  platform = "darwin";
  config = await mkdtemp(join(tmpdir(), "cairn-instances-test-"));
});

afterEach(async () => {
  for (const context of Object.values(contexts)) await closeContext(context);
  await rm(config, { recursive: true, force: true });
});

describe("registering instances", () => {
  it("adds, lists in order, puts one first, and removes", async () => {
    await register();
    expect(await cairn("instances", "add", "spare", SPARE, "--first")).toBe(0);
    expect(stdout).toContain("number 1 of 3");
    expect(await cairn("instances")).toBe(0);
    expect(stdout).toMatch(/^1\. spare {2}https:\/\/spare\.example\n2\. laptop {2}http:\/\/localhost:4101, not yet synced with spare\n {5}cairn start runs: pnpm dev\n3\. cloud/);
    expect(await cairn("instances", "remove", "spare")).toBe(0);
    expect(await cairn("instances", "--json")).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      instances: [
        { name: "laptop", url: LAPTOP, start: "pnpm dev" },
        { name: "cloud", url: CLOUD },
      ],
    });
  });

  it("refuses a bad name, a bad address and a repeat", async () => {
    await register();
    expect(await cairn("instances", "add", "My Laptop", LAPTOP)).toBe(2);
    expect(stderr).toContain("lowercase letters");
    expect(await cairn("instances", "add", "ftp", "ftp://files.example")).toBe(2);
    expect(await cairn("instances", "add", "again", `${LAPTOP}/`)).toBe(2);
    expect(stderr).toContain("already registered: laptop");
    expect(await cairn("instances", "remove", "nope")).toBe(2);
  });
});

describe("choosing an instance", () => {
  it("sends a command to the first that answers, and never wakes the cloud while the laptop is up", async () => {
    await register();
    await contexts[LAPTOP]!.pages.create(contexts[LAPTOP]!.workspaceId, { title: "On the laptop", body: "x" }, BY);
    await contexts[CLOUD]!.pages.create(contexts[CLOUD]!.workspaceId, { title: "In the cloud", body: "x" }, BY);

    expect(await cairn("overview")).toBe(0);
    expect(stdout).toContain("On the laptop");
    expect(stderr).toBe("");
    expect(seen.some((url) => url.startsWith(CLOUD))).toBe(false);

    down.add(LAPTOP);
    expect(await cairn("overview")).toBe(0);
    expect(stdout).toContain("In the cloud");
    expect(stderr).toContain(`using cloud (${CLOUD}): laptop did not answer`);
  });

  it("lets --instance and CAIRN_URL choose, and says when none answers", async () => {
    await register();
    await contexts[CLOUD]!.pages.create(contexts[CLOUD]!.workspaceId, { title: "In the cloud", body: "x" }, BY);
    expect(await cairn("overview", "--instance", "cloud")).toBe(0);
    expect(stdout).toContain("In the cloud");
    expect(await cairn("overview", "--instance", "nope")).toBe(2);
    expect(stderr).toContain("Registered: laptop, cloud");

    down.add(LAPTOP);
    down.add(CLOUD);
    expect(await cairn("overview")).toBe(1);
    expect(stderr).toContain("none of your instances answered");
    expect(await cairn("login")).toBe(2);
    expect(stderr).toContain("cairn login --instance <name>");
  });

  it("takes -i as the short form of --instance", async () => {
    await register();
    await contexts[CLOUD]!.pages.create(contexts[CLOUD]!.workspaceId, { title: "In the cloud", body: "x" }, BY);
    // The owner asked for this because --instance is typed on almost every
    // command against a named Cairn, sign-in most of all.
    expect(await cairn("overview", "-i", "cloud")).toBe(0);
    expect(stdout).toContain("In the cloud");
    // And it must be the same flag, not a second one: a wrong name fails the
    // same way and lists the same names.
    expect(await cairn("overview", "-i", "nope")).toBe(2);
    expect(stderr).toContain("Registered: laptop, cloud");
  });
});

describe("syncing every instance through a hub", () => {
  it("brings a change made on one cloud to the other in a single run", async () => {
    await register();
    expect(await cairn("instances", "add", "spare", SPARE)).toBe(0);
    const spare = contexts[SPARE]!;
    await spare.pages.create(spare.workspaceId, { title: "Written on the spare", body: "x" }, BY, "pg_spare");

    expect(await cairn("sync")).toBe(0);
    // laptop and cloud first (nothing), then laptop and spare (the page),
    // then laptop and cloud again, since the laptop took something.
    for (const url of [LAPTOP, CLOUD]) {
      expect((await contexts[url]!.pages.get(contexts[url]!.workspaceId, "pg_spare")).title).toBe("Written on the spare");
    }
    expect(await cairn("sync")).toBe(0);
    expect(stdout).not.toContain("written");
  });

  it("uses the first that answers as the hub, and says which were skipped", async () => {
    await register();
    expect(await cairn("instances", "add", "spare", SPARE)).toBe(0);
    await contexts[CLOUD]!.pages.create(contexts[CLOUD]!.workspaceId, { title: "Cloud page", body: "x" }, BY, "pg_cloud");
    down.add(LAPTOP);
    expect(await cairn("sync")).toBe(0);
    expect(stderr).toContain(`skipped laptop (${LAPTOP}): not answering`);
    expect((await contexts[SPARE]!.pages.get(contexts[SPARE]!.workspaceId, "pg_cloud")).title).toBe("Cloud page");
  });

  it("still takes two addresses, or two names", async () => {
    await register();
    await contexts[CLOUD]!.pages.create(contexts[CLOUD]!.workspaceId, { title: "Cloud page", body: "x" }, BY, "pg_cloud");
    expect(await cairn("sync", "laptop", "cloud")).toBe(0);
    expect(stdout).toContain(`synced ${LAPTOP} and ${CLOUD}`);
    expect(await cairn("instances")).toBe(0);
    expect(stdout).toContain("last synced with laptop at 20");
  });
});

describe("cairn start", () => {
  it("starts the first instance when it is down, then pulls in what changed in the cloud", async () => {
    await register();
    await contexts[CLOUD]!.pages.create(contexts[CLOUD]!.workspaceId, { title: "Edited away from the laptop", body: "x" }, BY, "pg_away");
    down.add(LAPTOP);

    expect(await cairn("start")).toBe(0);
    expect(launched).toEqual([{ command: "pnpm dev", log: join(config, "cairn", "logs", "laptop.log") }]);
    expect(stderr).toContain("laptop is up");
    expect((await contexts[LAPTOP]!.pages.get(contexts[LAPTOP]!.workspaceId, "pg_away")).title).toBe("Edited away from the laptop");
    expect(stderr).toContain("cairn sync install");
  });

  it("syncs without starting anything when the first is already up, and says when it cannot start one", async () => {
    await register();
    expect(await cairn("start")).toBe(0);
    expect(launched).toEqual([]);
    expect(stderr).toContain("laptop is running");

    expect(await cairn("instances", "add", "nostart", "http://localhost:4199", "--first")).toBe(0);
    apps.set("http://localhost:4199", apps.get(LAPTOP)!);
    down.add("http://localhost:4199");
    expect(await cairn("start")).toBe(0);
    expect(stderr).toContain("cairn has no command to start it");
  });
});

describe("cairn sync install", () => {
  it("writes a launchd agent on macOS and loads it, then removes it", async () => {
    await register();
    expect(await cairn("sync", "install", "--every", "2h")).toBe(0);
    const plist = await readFile(join(config, "Library", "LaunchAgents", "dev.cairn.sync.plist"), "utf8");
    expect(plist).toContain("<string>/usr/local/lib/node_modules/@cairn/cli/dist/bin.js</string>\n    <string>sync</string>");
    expect(plist).toContain("<integer>7200</integer>");
    expect(plist).toContain(`<key>XDG_CONFIG_HOME</key>\n    <string>${config}</string>`);
    expect(calls.map((call) => call.args[0])).toEqual(["bootout", "bootstrap"]);
    expect(calls[1]!.args).toEqual(["bootstrap", "gui/501", join(config, "Library", "LaunchAgents", "dev.cairn.sync.plist")]);

    // Installed, so cairn start stops suggesting it.
    expect(await cairn("start")).toBe(0);
    expect(stderr).not.toContain("cairn sync install");

    expect(await cairn("sync", "uninstall")).toBe(0);
    await expect(readFile(join(config, "Library", "LaunchAgents", "dev.cairn.sync.plist"))).rejects.toThrow();
  });

  it("prints the files on a dry run for each OS, writing nothing and never carrying a token", async () => {
    await register();
    for (const os of ["darwin", "linux", "win32"]) {
      platform = os;
      calls = [];
      expect(await run(["sync", "install", "--dry-run"], { ...io(), env: { ...io().env, CAIRN_TOKEN: "secret-token-value" } })).toBe(0);
      expect(calls).toEqual([]);
    }
    expect(stdout).not.toContain("secret-token-value");
    await expect(readFile(join(config, "Library", "LaunchAgents", "dev.cairn.sync.plist"))).rejects.toThrow();
  });

  it("needs two instances, and a CLI that can run again outside the source tree", async () => {
    expect(await cairn("sync", "install")).toBe(2);
    expect(stderr).toContain("register two or more instances");
    await register();
    expect(
      await run(["sync", "install"], {
        ...io(),
        self: async () => {
          throw new Error("this is cairn running from source");
        },
      }),
    ).toBe(2);
  });
});

describe("the job files", () => {
  const job = { program: ["C:\\Program Files\\cairn\\cairn.exe"], everyMs: 3_600_000, env: {}, log: "/tmp/sync.log" };

  it("escapes what launchd and systemd would misread", () => {
    const odd = { ...job, program: ["/Users/me/a&b/cairn"], env: { XDG_CONFIG_HOME: '/home/me/100% "real"' } };
    expect(launchdPlist(odd)).toContain("<string>/Users/me/a&amp;b/cairn</string>");
    const { service, timer } = systemdUnits(odd);
    expect(service).toContain('ExecStart="/Users/me/a&b/cairn" "sync"');
    expect(service).toContain('Environment="XDG_CONFIG_HOME=/home/me/100%% \\"real\\""');
    expect(timer).toContain("OnUnitActiveSec=3600s");
  });

  it("counts in hours or minutes for Task Scheduler, and quotes a path with spaces", () => {
    expect(schtasksArgs(job)).toEqual(["/Create", "/F", "/TN", "Cairn sync", "/SC", "HOURLY", "/MO", "1", "/TR", '"C:\\Program Files\\cairn\\cairn.exe" sync']);
    expect(schtasksArgs({ ...job, everyMs: 90_000 }).slice(4, 8)).toEqual(["/SC", "MINUTE", "/MO", "2"]);
  });
});
