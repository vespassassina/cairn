import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Fetch } from "./client.js";

/**
 * Named instances (ADR-029): the Cairns this CLI knows, in the order the
 * owner prefers them. A command goes to the first one that answers, and
 * `cairn sync` with no addresses keeps them all the same, through the first
 * one that answers.
 *
 * The list lives next to the CLI's credentials, in `instances.json`. It holds
 * names, addresses and an optional start command, never a token: sign-ins stay
 * in the credentials file, one per server.
 */

export interface Instance {
  name: string;
  url: string;
  /** A shell command that starts this instance, for `cairn start`. */
  start?: string;
}

interface InstanceFile {
  instances: Instance[];
}

export function instancesPath(credentialsFile: string): string {
  return join(dirname(credentialsFile), "instances.json");
}

export async function loadInstances(path: string): Promise<Instance[]> {
  try {
    const file = JSON.parse(await readFile(path, "utf8")) as InstanceFile;
    return Array.isArray(file.instances) ? file.instances : [];
  } catch {
    return [];
  }
}

export async function saveInstances(path: string, instances: Instance[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ instances }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Checks a new instance, and returns its address without a trailing slash. */
export function checkInstance(name: string, url: string, existing: Instance[]): string {
  if (!NAME.test(name)) {
    throw new Error(`cannot use "${name}" as a name. Use up to 32 lowercase letters, digits and dashes, such as laptop or azure`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`cannot read "${url}" as an address. Use one such as http://localhost:8787`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`"${url}" is not an http or https address`);
  }
  const normalised = url.replace(/\/+$/, "");
  const same = existing.find((instance) => instance.name === name || instance.url === normalised);
  if (same) throw new Error(`already registered: ${same.name} (${same.url}). Remove it first to change it`);
  return normalised;
}

export function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}

/**
 * How long to wait for `/health`. A server on this machine answers at once or
 * not at all; one in the cloud may be starting from zero, which takes about
 * 30 seconds on Azure (ADR-018).
 */
export const probeTimeout = (url: string) => (isLoopback(url) ? 2_000 : 60_000);

export async function reachable(url: string, fetch: Fetch): Promise<boolean> {
  try {
    const response = await fetch(new Request(`${url}/health`, { signal: AbortSignal.timeout(probeTimeout(url)) }));
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The first instance that answers, trying them in order and stopping there,
 * so a cloud copy is not woken while an earlier one is up. Also returns the
 * ones skipped on the way, to say so.
 */
export async function firstReachable(
  instances: Instance[],
  fetch: Fetch,
): Promise<{ instance: Instance | null; skipped: Instance[] }> {
  const skipped: Instance[] = [];
  for (const instance of instances) {
    if (await reachable(instance.url, fetch)) return { instance, skipped };
    skipped.push(instance);
  }
  return { instance: null, skipped };
}
