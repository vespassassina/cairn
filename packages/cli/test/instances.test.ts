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
/** What the person answers when cairn asks. Null means nobody is there. */
let answer: string | null;
let asked: string[];

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
    ask: async (question) => {
      asked.push(question);
      return answer;
    },
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
  answer = null;
  asked = [];
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

  // A pair that nothing keeps in sync is not a pair, and `cairn sync install`
  // went unrun for exactly as long as it was only mentioned in the help.
  // Registering the second Cairn is the moment to offer it, and an offer is
  // all it may be: it installs a launchd agent or a systemd timer, which is
  // the person's machine rather than Cairn's.
  it("offers a scheduled sync when a second Cairn is registered, and installs it on yes", async () => {
    answer = "y";
    expect(await cairn("instances", "add", "laptop", LAPTOP)).toBe(0);
    // Not for the first: one Cairn has nothing to sync with.
    expect(asked).toEqual([]);

    expect(await cairn("instances", "add", "cloud", CLOUD)).toBe(0);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("every 4h");
    expect(stdout).toContain("installed: cairn start at login and every 4h");
    // Installed for real, through the same path cairn sync install uses.
    const plist = await readFile(join(config, "Library", "LaunchAgents", "dev.cairn.sync.plist"), "utf8");
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain(`<integer>${4 * 60 * 60}</integer>`);
  });

  it("does not install when the answer is no, or when nobody is there to answer", async () => {
    answer = "";
    expect(await cairn("instances", "add", "laptop", LAPTOP)).toBe(0);
    expect(await cairn("instances", "add", "cloud", CLOUD)).toBe(0);
    // Anything but yes is no, because the cost of guessing wrong is a
    // background job on someone's machine that they did not ask for.
    expect(stdout).toContain("When you want it: cairn sync install --every 4h");
    expect(calls).toEqual([]);

    answer = null;
    expect(await cairn("instances", "add", "spare", SPARE)).toBe(0);
    // A script or an agent gets told how, and is never left waiting.
    expect(stderr).toContain("they do not sync themselves yet");
    expect(stderr).toContain("cairn sync install --every 4h");
    expect(calls).toEqual([]);
  });

  it("does not ask twice once a job is installed", async () => {
    answer = "yes";
    expect(await cairn("instances", "add", "laptop", LAPTOP)).toBe(0);
    expect(await cairn("instances", "add", "cloud", CLOUD)).toBe(0);
    asked = [];
    expect(await cairn("instances", "add", "spare", SPARE)).toBe(0);
    expect(asked).toEqual([]);
    expect(stdout).not.toContain("cairn sync install");
  });

  it("keeps the instance registered when installing the job fails", async () => {
    answer = "y";
    expect(await cairn("instances", "add", "laptop", LAPTOP)).toBe(0);
    platform = "linux";
    // systemctl refusing is the ordinary case on a machine with no user
    // session, and it must not cost the person their registration.
    const failing = { ...io(), exec: async () => ({ code: 1, output: "Failed to connect to bus" }) };
    stdout = "";
    stderr = "";
    expect(await run(["instances", "add", "cloud", CLOUD], failing)).toBe(0);
    expect(stderr).toContain("the instances are registered");
    expect(stderr).toContain("cairn sync install --every 4h");
    expect(await cairn("instances", "--json")).toBe(0);
    expect(JSON.parse(stdout).instances).toHaveLength(2);
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
    expect(plist).toContain("<string>/usr/local/lib/node_modules/@cairn/cli/dist/bin.js</string>\n    <string>start</string>");
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
    expect(service).toContain('ExecStart="/Users/me/a&b/cairn" "start"');
    expect(service).toContain('Environment="XDG_CONFIG_HOME=/home/me/100%% \\"real\\""');
    expect(timer).toContain("OnUnitActiveSec=3600s");
  });

  it("counts in hours or minutes for Task Scheduler, and quotes a path with spaces", () => {
    expect(schtasksArgs(job)).toEqual(["/Create", "/F", "/TN", "Cairn sync", "/SC", "HOURLY", "/MO", "1", "/TR", '"C:\\Program Files\\cairn\\cairn.exe" start']);
    expect(schtasksArgs({ ...job, everyMs: 90_000 }).slice(4, 8)).toEqual(["/SC", "MINUTE", "/MO", "2"]);
  });
});

describe("cairn status", () => {
  it("reports ok on a reachable, single-instance, loopback machine with no job or hook needed", async () => {
    expect(await cairn("instances", "add", "laptop", LAPTOP)).toBe(0);
    expect(await cairn("status", "--instance", "laptop")).toBe(0);
    expect(stdout).toMatch(/^ok {2}laptop \(http:\/\/localhost:4101\) answered, version/);
    expect(stdout).toContain("ok  no sign-in needed");
    expect(stdout).toContain("ok  one instance registered, nothing to sync");
    expect(stdout).toContain("no scheduled job (nothing to sync)");
    expect(stdout).toContain("cairn hook install");
  });

  it("prints not-ok lines and exits non-zero when the server is down and a job is needed but absent", async () => {
    await register();
    down.add(LAPTOP);
    expect(await cairn("status", "--instance", "laptop")).toBe(1);
    expect(stdout).toContain("!!  laptop (http://localhost:4101) is not answering. Start it: cairn start");
    expect(stdout).toContain("no scheduled job. Run: cairn sync install");
  });

  it("--json prints stable field names and never a token", async () => {
    expect(await cairn("instances", "add", "laptop", LAPTOP)).toBe(0);
    expect(await cairn("status", "--instance", "laptop", "--json")).toBe(0);
    const body = JSON.parse(stdout) as { status: Array<{ field: string; ok: boolean; text: string }> };
    expect(body.status.map((line) => line.field)).toEqual(["instance", "sign_in", "sync", "embeddings", "job", "hook"]);
    expect(JSON.stringify(body)).not.toMatch(/[A-Za-z0-9_-]{20,}/);
  });
});

describe("cairn hook", () => {
  it("installs a SessionStart hook and reports it in cairn status", async () => {
    expect(await cairn("hook", "install", "--yes")).toBe(0);
    expect(stdout).toContain("cairn overview --brief");
    const settings = JSON.parse(await readFile(join(config, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart[0].hooks[0]._cairn).toBe("cairn-overview");

    expect(await cairn("instances", "add", "laptop", LAPTOP)).toBe(0);
    expect(await cairn("status", "--instance", "laptop")).toBe(0);
    expect(stdout).toContain("ok  session hook installed");
  });

  it("status says installed or not, without changing anything", async () => {
    expect(await cairn("hook", "status")).toBe(0);
    expect(stdout).toContain("not installed. Add it: cairn hook install");
    await cairn("hook", "install", "--yes");
    expect(await cairn("hook", "status")).toBe(0);
    expect(stdout).toContain("installed in");
    expect(stdout).toContain("cairn overview --brief");
  });

  it("uninstalls cleanly, leaving other settings untouched", async () => {
    await cairn("hook", "install", "--yes");
    expect(await cairn("hook", "uninstall")).toBe(0);
    expect(stdout).toContain("removed the session hook");
    const settings = JSON.parse(await readFile(join(config, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks?.SessionStart).toBeUndefined();
  });
});
