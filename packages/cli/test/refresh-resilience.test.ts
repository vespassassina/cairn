import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type Io } from "../src/main.js";
import { credentialsPath, RefreshFailed, storedToken } from "../src/login.js";

/**
 * A stored sign-in survives a refresh that does not succeed (ADR-054): only
 * a server that actually says `invalid_grant` costs the person their
 * credentials. A timeout, a refused connection, a 500 and an unparseable
 * body all leave the file untouched and say why.
 */

const URL_ = "https://cairn.test";
const CLIENT_ID = "cl_test";
const REFRESH_TOKEN = "the-refresh-token";

let dir: string;
let stdout: string;
let stderr: string;

function metadataResponse(request: Request): Response | null {
  if (new URL(request.url).pathname === "/.well-known/oauth-authorization-server") {
    return Response.json({
      authorization_endpoint: `${URL_}/oauth/authorize`,
      token_endpoint: `${URL_}/oauth/token`,
      registration_endpoint: `${URL_}/oauth/register`,
    });
  }
  return null;
}

function io(fetch: Io["fetch"]): Io {
  return {
    fetch,
    env: { CAIRN_CREDENTIALS: join(dir, "credentials.json"), XDG_CONFIG_HOME: dir, APPDATA: dir },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: async () => null,
    openBrowser: async () => undefined,
  };
}

async function cairn(argv: string[], fetch: Io["fetch"]): Promise<number> {
  stdout = "";
  stderr = "";
  return run(argv, io(fetch));
}

async function seedExpiredCredentials(): Promise<string> {
  const path = credentialsPath({ CAIRN_CREDENTIALS: join(dir, "credentials.json") });
  const file = {
    servers: {
      [URL_]: {
        client_id: CLIENT_ID,
        access_token: "stale-access-token",
        refresh_token: REFRESH_TOKEN,
        expires_at: Date.now() - 1000,
      },
    },
  };
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  return path;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-refresh-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a refresh that fails without invalid_grant (ADR-054)", () => {
  it("keeps credentials on a connection refusal, and says so", async () => {
    const path = await seedExpiredCredentials();
    const before = await readFile(path, "utf8");
    const refused: Io["fetch"] = async (request) => {
      const meta = metadataResponse(request);
      if (meta) return meta;
      throw new TypeError("fetch failed");
    };

    await cairn(["instances", "add", "test", URL_], refused);
    const code = await cairn(["whoami", "--instance", "test"], refused);

    expect(code).toBe(1);
    expect(stderr).toContain(`could not reach ${URL_} to refresh the sign-in`);
    expect(stderr).toContain("The stored sign-in was kept");
    expect(stderr).toContain("try again, or run cairn status");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("keeps credentials on an HTTP 500, names the status and message, and says the sign-in was kept", async () => {
    const path = await seedExpiredCredentials();
    const before = await readFile(path, "utf8");
    const serverError: Io["fetch"] = async (request) => {
      const meta = metadataResponse(request);
      if (meta) return meta;
      return Response.json({ error: "server_error", error_description: "the database is busy" }, { status: 500 });
    };

    await cairn(["instances", "add", "test", URL_], serverError);
    const code = await cairn(["whoami", "--instance", "test"], serverError);

    expect(code).toBe(1);
    expect(stderr).toContain(`${URL_} refused to refresh the sign-in (HTTP 500): the database is busy`);
    expect(stderr).toContain("The stored sign-in was kept");
    expect(stderr).toContain("cairn login --instance test");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("keeps credentials on a body that is not JSON (a proxy's HTML page), and says so", async () => {
    const path = await seedExpiredCredentials();
    const before = await readFile(path, "utf8");
    const htmlProxy: Io["fetch"] = async (request) => {
      const meta = metadataResponse(request);
      if (meta) return meta;
      return new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "content-type": "text/html" } });
    };

    await cairn(["instances", "add", "test", URL_], htmlProxy);
    const code = await cairn(["whoami", "--instance", "test"], htmlProxy);

    expect(code).toBe(1);
    expect(stderr).toContain(`could not reach ${URL_} to refresh the sign-in`);
    expect(stderr).toContain("was not JSON");
    expect(stderr).toContain("The stored sign-in was kept");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("keeps credentials on a timeout (simulated as a connection-level failure on both attempts), and names the wait used", async () => {
    // AbortSignal.timeout really waits 30s; the test stands in for that by
    // failing both the first attempt and the one retry the same way a
    // timed-out fetch would, so the assertion is on the classification and
    // message rather than on waiting the real 30 seconds.
    const path = await seedExpiredCredentials();
    const before = await readFile(path, "utf8");
    const timesOut: Io["fetch"] = async (request) => {
      const meta = metadataResponse(request);
      if (meta) return meta;
      throw new DOMException("The operation timed out.", "TimeoutError");
    };

    await cairn(["instances", "add", "test", URL_], timesOut);
    const code = await cairn(["whoami", "--instance", "test"], timesOut);

    expect(code).toBe(1);
    expect(stderr).toContain(`could not reach ${URL_} to refresh the sign-in (waited 30s)`);
    expect(stderr).toContain("The stored sign-in was kept");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("deletes credentials only on invalid_grant, and names the login command with the instance", async () => {
    const path = await seedExpiredCredentials();
    const invalidGrant: Io["fetch"] = async (request) => {
      const meta = metadataResponse(request);
      if (meta) return meta;
      return Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 });
    };

    await cairn(["instances", "add", "test", URL_], invalidGrant);
    const code = await cairn(["whoami", "--instance", "test"], invalidGrant);

    expect(code).toBe(1);
    expect(stderr).toContain(`the sign-in to ${URL_} is no longer valid`);
    expect(stderr).toContain("Sign in again: cairn login --instance test");
    const after = JSON.parse(await readFile(path, "utf8")) as { servers: Record<string, unknown> };
    expect(after.servers[URL_]).toBeUndefined();
  });
});

describe("writing one server's credentials never erases another's (ADR-054)", () => {
  it("survives two refreshes for different servers finishing out of order", async () => {
    const A = "https://a.test";
    const B = "https://b.test";
    const path = credentialsPath({ CAIRN_CREDENTIALS: join(dir, "credentials.json") });
    await writeFile(
      path,
      `${JSON.stringify(
        {
          servers: {
            [A]: { client_id: "cl_a", access_token: "old-a", refresh_token: "refresh-a", expires_at: Date.now() - 1000 },
            [B]: { client_id: "cl_b", access_token: "old-b", refresh_token: "refresh-b", expires_at: Date.now() - 1000 },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const env = { CAIRN_CREDENTIALS: path };

    // A's request is slow, so its write lands after B's, which is fast: a
    // stale in-memory read of the file taken before B wrote must not carry
    // A's write back over B's entry.
    const fetchFor = (origin: string, delayMs: number): Io["fetch"] =>
      async (request) => {
        if (new URL(request.url).pathname === "/.well-known/oauth-authorization-server") {
          return Response.json({
            authorization_endpoint: `${origin}/oauth/authorize`,
            token_endpoint: `${origin}/oauth/token`,
            registration_endpoint: `${origin}/oauth/register`,
          });
        }
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return Response.json({ access_token: `new-${origin}`, refresh_token: `new-refresh-${origin}`, expires_in: 3600 });
      };

    const [tokenA, tokenB] = await Promise.all([
      storedToken(A, { fetch: fetchFor(A, 150), env }),
      storedToken(B, { fetch: fetchFor(B, 0), env }),
    ]);
    expect(tokenA).toBe(`new-${A}`);
    expect(tokenB).toBe(`new-${B}`);

    const after = JSON.parse(await readFile(path, "utf8")) as { servers: Record<string, { access_token: string }> };
    expect(after.servers[A]?.access_token).toBe(`new-${A}`);
    expect(after.servers[B]?.access_token).toBe(`new-${B}`);
  });
});

describe("RefreshFailed", () => {
  it("classifies invalid_grant, http and network distinctly", () => {
    const grant = new RefreshFailed(URL_, { kind: "invalid_grant" });
    const http = new RefreshFailed(URL_, { kind: "http", status: 503, message: "starting up" });
    const network = new RefreshFailed(URL_, { kind: "network", message: "fetch failed" });
    expect(grant.reason.kind).toBe("invalid_grant");
    expect(http.message).toContain("HTTP 503");
    expect(network.message).toContain("fetch failed");
  });
});
