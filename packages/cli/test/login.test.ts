import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, createContext, OAuthServer, type AppContext, type IdentityProvider } from "@cairn/api";
import { run, type Io } from "../src/main.js";

/**
 * cairn login against an OAuth server (ADR-017), with a fake provider. The
 * test plays the browser: it follows the redirects, approves the consent
 * page, and lands on the CLI's real loopback listener.
 */

const ISSUER = "https://cairn.test";

let context: AppContext;
let app: ReturnType<typeof createApp>;
let dir: string;
let stdout: string;
let stderr: string;

const provider: IdentityProvider = {
  name: "Fake",
  async authorizeUrl(state, redirectUri) {
    return `${redirectUri}?code=owner&state=${state}`;
  },
  async identify() {
    return { id: "github:owner", label: "owner", verifiedEmail: null };
  },
};

/** Requests for the server go to the app; the loopback callback goes over real HTTP. */
const route = (request: Request) =>
  request.url.startsWith(ISSUER) ? app.fetch(request) : fetch(request);

/** What a person does in the browser: follow, approve, get sent back. */
async function browser(url: string): Promise<void> {
  const authorize = await app.fetch(new Request(url));
  const callback = await app.fetch(new Request(authorize.headers.get("location")!));
  const html = await callback.text();
  const key = /name="request" value="([^"]+)"/.exec(html)![1]!;
  const approved = await app.fetch(
    new Request(`${ISSUER}/oauth/consent`, {
      method: "POST",
      headers: { origin: ISSUER, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request: key, decision: "allow" }),
    }),
  );
  await fetch(approved.headers.get("location")!);
}

function io(env: Record<string, string> = {}): Io {
  return {
    fetch: route,
    env: { CAIRN_URL: ISSUER, CAIRN_CREDENTIALS: join(dir, "credentials.json"), ...env },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: async () => null,
    openBrowser: browser,
  };
}

async function cairn(argv: string[], env: Record<string, string> = {}): Promise<number> {
  stdout = "";
  stderr = "";
  return run(argv, io(env));
}

beforeEach(async () => {
  context = await createContext({ database: ":memory:", workspaceId: "ws_login" });
  const oauth = new OAuthServer({
    publicUrl: ISSUER,
    secrets: ["k".repeat(32)],
    provider,
    allowedUsers: ["github:owner"],
    store: context.auth,
  });
  app = createApp({ context, token: null, trust: { enabled: false, hosts: [] }, oauth, publicOrigin: ISSUER });
  dir = await mkdtemp(join(tmpdir(), "cairn-login-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("cairn login", () => {
  it("says to sign in when a server needs it", async () => {
    expect(await cairn(["overview"])).toBe(1);
    expect(stderr).toContain("cairn login");
  });

  it("signs in through the browser, keeps the tokens private, and uses them", async () => {
    expect(await cairn(["login"])).toBe(0);
    expect(stderr).toContain("/oauth/authorize?");
    expect(stdout).toContain("signed in to https://cairn.test");

    const file = join(dir, "credentials.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.servers[ISSUER].refresh_token).toBeTruthy();
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

    expect(await cairn(["whoami"])).toBe(0);
    expect(stdout).toContain("github:owner, writing as agent: cairn CLI for owner (signed in)");

    expect(await cairn(["create", "--title", "From the CLI", "--text", "hi"])).toBe(0);
    const id = /^ok (\S+)/.exec(stdout)![1]!;
    expect((await context.pages.get(context.workspaceId, id)).updatedBy.label).toBe("cairn CLI for owner");
  });

  it("refreshes an expired access token by itself", async () => {
    await cairn(["login"]);
    const file = join(dir, "credentials.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    saved.servers[ISSUER].expires_at = Date.now() - 1000;
    await (await import("node:fs/promises")).writeFile(file, JSON.stringify(saved));

    expect(await cairn(["whoami"])).toBe(0);
    const renewed = JSON.parse(await readFile(file, "utf8"));
    expect(renewed.servers[ISSUER].refresh_token).not.toBe(saved.servers[ISSUER].refresh_token);
  });

  it("signs out, revoking the refresh token on the server", async () => {
    await cairn(["login"]);
    const saved = JSON.parse(await readFile(join(dir, "credentials.json"), "utf8")).servers[ISSUER];
    expect(await cairn(["logout"])).toBe(0);
    expect(stdout).toContain("signed out");
    const reuse = await app.fetch(
      new Request(`${ISSUER}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: saved.refresh_token, client_id: saved.client_id }),
      }),
    );
    expect(reuse.status).toBe(400);
    expect(await cairn(["overview"])).toBe(1);
  });

  it("explains that localhost needs no sign-in", async () => {
    const local = createApp({ context, token: null, trust: { enabled: true, hosts: ["localhost"] } });
    stdout = "";
    stderr = "";
    const code = await run(["login"], {
      ...io({ CAIRN_URL: "http://localhost:8787" }),
      fetch: (request) => local.fetch(request),
    });
    expect(code).toBe(1);
    expect(stderr).toContain("does not use OAuth");
  });
});
