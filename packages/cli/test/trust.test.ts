import { describe, expect, it } from "vitest";
import { fetchPeerDescription } from "../src/trust.js";

const DESCRIPTION = { cairn: "1", name: "Peptide Lab", description: "peptide research notes" };

function fetchWith(handlers: Record<string, () => Response>) {
  return async (request: Request) => {
    const handler = handlers[request.url];
    if (!handler) throw new Error(`unexpected request in test: ${request.url}`);
    return handler();
  };
}

describe("fetchPeerDescription", () => {
  it("reads name and description from a Cairn self-description", async () => {
    const peer = await fetchPeerDescription(
      "https://friend.example",
      fetchWith({ "https://friend.example/.well-known/cairn.json": () => Response.json(DESCRIPTION) }),
      1000,
    );
    expect(peer).toEqual({ name: "Peptide Lab", description: "peptide research notes", cites: [] });
  });

  it("reads cites, dropping anything that isn't a string", async () => {
    const peer = await fetchPeerDescription(
      "https://friend.example",
      fetchWith({
        "https://friend.example/.well-known/cairn.json": () =>
          Response.json({ ...DESCRIPTION, cites: ["https://other.example", 42, "https://third.example"] }),
      }),
      1000,
    );
    expect(peer.cites).toEqual(["https://other.example", "https://third.example"]);
  });

  it("strips a trailing slash before asking for .well-known/cairn.json", async () => {
    const peer = await fetchPeerDescription(
      "https://friend.example/",
      fetchWith({ "https://friend.example/.well-known/cairn.json": () => Response.json(DESCRIPTION) }),
      1000,
    );
    expect(peer.name).toBe("Peptide Lab");
  });

  it("rejects an address that does not answer with a cairn field", async () => {
    await expect(
      fetchPeerDescription(
        "https://not-a-cairn.example",
        fetchWith({ "https://not-a-cairn.example/.well-known/cairn.json": () => Response.json({ hello: "world" }) }),
        1000,
      ),
    ).rejects.toThrow(/no "cairn" field/);
  });

  it("rejects a 404", async () => {
    await expect(
      fetchPeerDescription(
        "https://gone.example",
        fetchWith({ "https://gone.example/.well-known/cairn.json": () => new Response(null, { status: 404 }) }),
        1000,
      ),
    ).rejects.toThrow(/answered 404/);
  });

  it("rejects a non-JSON body", async () => {
    await expect(
      fetchPeerDescription(
        "https://text.example",
        fetchWith({ "https://text.example/.well-known/cairn.json": () => new Response("not json") }),
        1000,
      ),
    ).rejects.toThrow(/did not answer with JSON/);
  });
});
