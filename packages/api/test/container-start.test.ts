import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { copyFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The container's start script decides whether Cairn may open a database at
// all (ADR-046). The rules worth holding: a damaged replica stops the
// container at once rather than being retried, and a database that fails its
// integrity check is never replicated, because streaming it back would
// overwrite the replica's own history. Litestream and sleep are stubbed, so
// this reads as a decision test and needs no container.

const startScript = fileURLToPath(new URL("../../../docker/start.sh", import.meta.url));

/** The stub stands in for litestream; STUB_RESTORE picks what restore does. */
const stubLitestream = `#!/bin/sh
cmd="$1"; shift
case "$cmd" in
  version) echo "0.5.17-stub" ;;
  ltx) echo "stub-ltx: listed $*" ;;
  restore)
    out=""
    while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done
    case "\${STUB_RESTORE:-ok}" in
      decode) echo 'error="decode database: decode page 1460: EOF"' >&2; exit 1 ;;
      network)
        n=$(cat "$STUB_COUNT" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" >"$STUB_COUNT"
        if [ "$n" -lt 3 ]; then echo "dial tcp: i/o timeout" >&2; exit 1; fi
        cp "$STUB_DB" "$out" ;;
      damaged) cp "$STUB_DB" "$out" ;;
      empty) : ;;
      ok) cp "$STUB_DB" "$out" ;;
    esac ;;
  replicate) echo "REACHED-REPLICATE" ;;
esac
`;

describe.skipIf(process.platform === "win32")("the container start script", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cairn-start-"));
    const bin = join(dir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "litestream"), stubLitestream);
    await writeFile(join(bin, "sleep"), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, "litestream"), 0o755);
    await chmod(join(bin, "sleep"), 0o755);

    const sound = join(dir, "sound.sqlite");
    const db = new DatabaseSync(sound);
    db.exec("pragma journal_mode=delete; create table t(a, b);");
    const insert = db.prepare("insert into t values (?, ?)");
    for (let i = 0; i < 4000; i += 1) insert.run(i, "x".repeat(200));
    db.exec("create index ix on t(b);");
    db.close();

    const damaged = join(dir, "damaged.sqlite");
    copyFileSync(sound, damaged);
    await truncate(damaged, statSync(sound).size - 4096 * 3 - 137);

    env = {
      PATH: [bin, dirname(process.execPath), process.env["PATH"] ?? ""].join(delimiter),
      CAIRN_DB: join(dir, "data", "cairn.sqlite"),
      CAIRN_REPLICA_URL: "abs://account@container/cairn.sqlite",
      STUB_COUNT: join(dir, "count"),
      STUB_DB: sound,
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

  it("stops at a damaged replica instead of retrying what cannot succeed", async () => {
    const { code, output } = await start({ STUB_RESTORE: "decode" });
    expect(code).toBe(1);
    expect(output).toContain("cannot be read back");
    expect(output).not.toContain("retrying in 10 seconds");
    expect(output).not.toContain("REACHED-REPLICATE");
  });

  it("lists what the replica holds, so the reason is in the log", async () => {
    const { output } = await start({ STUB_RESTORE: "decode" });
    expect(output).toContain("stub-ltx: listed");
    expect(output).toContain("litestream restore -timestamp");
  });

  it("retries an error that could pass on the next try", async () => {
    const { code, output } = await start({ STUB_RESTORE: "network" });
    expect(code).toBe(0);
    expect(output).toContain("retrying in 10 seconds");
    expect(output).toContain("REACHED-REPLICATE");
  });

  it("never replicates a database that failed its integrity check", async () => {
    const { code, output } = await start({
      STUB_RESTORE: "damaged",
      STUB_DB: join(dir, "damaged.sqlite"),
    });
    expect(code).toBe(1);
    expect(output).toContain("did not pass its integrity check");
    expect(output).not.toContain("REACHED-REPLICATE");
  });

  it("starts as the first copy when the replica holds nothing yet", async () => {
    const { code, output } = await start({ STUB_RESTORE: "empty" });
    expect(code).toBe(0);
    expect(output).toContain("becomes its first copy");
    expect(output).toContain("REACHED-REPLICATE");
  });
});
