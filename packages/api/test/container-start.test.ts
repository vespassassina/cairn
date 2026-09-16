import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { copyFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The container's start script decides whether Cairn may open a database at
// all (ADR-046). Since ADR-051 the deciding is done by recover.mjs, because it
// needs the replica, the archive and SQLite, so what is left here is the shape
// of the script itself: the local-only path, and that a recovery which could
// not vouch for a database stops the container instead of replicating it. The
// rungs themselves are tested in recovery-ladder.test.ts.

const startScript = fileURLToPath(new URL("../../../docker/start.sh", import.meta.url));

/** The stub stands in for litestream; nothing here reaches its restore. */
const stubLitestream = `#!/bin/sh
cmd="$1"; shift
case "$cmd" in
  version) echo "0.5.17-stub" ;;
  replicate) echo "REACHED-REPLICATE" ;;
esac
`;

/** Stands in for the bundled recover.mjs; STUB_RECOVER picks its exit code. */
const stubRecover = `process.stdout.write("cairn: stub recovery ran\\n");
process.exit(Number(process.env.STUB_RECOVER ?? 0));
`;

describe.skipIf(process.platform === "win32")("the container start script", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  let sound: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cairn-start-"));
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "litestream"), stubLitestream);
    await chmod(join(bin, "litestream"), 0o755);

    const app = join(dir, "app");
    await mkdir(app);
    await writeFile(join(app, "recover.mjs"), stubRecover);
    // Reaching the server is the one thing the script does that these tests
    // must not actually do, so it is a stub too.
    await writeFile(join(app, "server.mjs"), 'process.stdout.write("REACHED-SERVER\\n");\n');

    sound = join(dir, "sound.sqlite");
    const db = new DatabaseSync(sound);
    db.exec("pragma journal_mode=delete; create table t(a, b);");
    const insert = db.prepare("insert into t values (?, ?)");
    for (let i = 0; i < 4000; i += 1) insert.run(i, "x".repeat(200));
    db.exec("create index ix on t(b);");
    db.close();

    env = {
      PATH: [bin, dirname(process.execPath), process.env["PATH"] ?? ""].join(delimiter),
      CAIRN_DB: join(dir, "data", "cairn.sqlite"),
      CAIRN_APP_DIR: app,
      CAIRN_REPLICA_URL: "abs://account@container/cairn.sqlite",
    };
    await mkdir(join(dir, "data"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const start = (overrides: NodeJS.ProcessEnv) =>
    new Promise<{ code: number; output: string }>((resolve) => {
      execFile(
        "sh",
        [startScript],
        { env: { ...env, ...overrides } },
        (error, stdout, stderr) => {
          const code = error && typeof error.code === "number" ? error.code : 0;
          resolve({ code, output: `${stdout}${stderr}` });
        },
      );
    });

  it("hands the decision to recovery before it replicates anything", async () => {
    const { code, output } = await start({});
    expect(code).toBe(0);
    expect(output).toContain("stub recovery ran");
    expect(output).toContain("REACHED-REPLICATE");
  });

  it("never replicates a database recovery could not vouch for", async () => {
    // Replicating it would stream that state back over the only good copy,
    // which is the whole reason recovery runs first (ADR-046).
    const { code, output } = await start({ STUB_RECOVER: "1" });
    expect(code).toBe(1);
    expect(output).not.toContain("REACHED-REPLICATE");
  });

  it("with no replica, serves a database that is there and sound", async () => {
    copyFileSync(sound, join(dir, "data", "cairn.sqlite"));
    const { code, output } = await start({ CAIRN_REPLICA_URL: "" });
    expect(code).toBe(0);
    expect(output).toContain("is sound");
    expect(output).toContain("REACHED-SERVER");
  });

  it("with no replica, stops on a database that failed its integrity check", async () => {
    const db = join(dir, "data", "cairn.sqlite");
    copyFileSync(sound, db);
    await truncate(db, statSync(sound).size - 4096 * 3 - 137);

    const { code, output } = await start({ CAIRN_REPLICA_URL: "" });
    expect(code).toBe(1);
    expect(output).toContain("did not pass its integrity check");
    // The error has to say what to do next, not only what went wrong.
    expect(output).toContain("cairn import");
    expect(output).not.toContain("REACHED-SERVER");
  });

  it("stops when the folder it was given cannot be written to", async () => {
    const readonly = join(dir, "readonly");
    await mkdir(readonly);
    await chmod(readonly, 0o500);
    const { code, output } = await start({ CAIRN_DB: join(readonly, "cairn.sqlite") });
    await chmod(readonly, 0o700);
    expect(code).toBe(1);
    expect(output).toContain("chown");
  });
});
