/**
 * Three-way merge for `cairn sync` (ADR-030), the way git merges a file.
 *
 * When both servers changed a record since the last sync, the version they
 * last agreed on (the base) says who changed what. A part only one side
 * changed takes that side's change, so two edits to different parts of a
 * page both survive. A part both sides changed differently is a conflict,
 * and takes the newer edit; the older one stays in the record's history on
 * its server (ADR-008), and the change note says so.
 *
 * A body merges line by line with diff3, git's algorithm. Titles, parents
 * and row values merge as whole values; tags and sources as sets, keeping
 * what either side added and dropping what either side removed.
 *
 * Pure functions, no I/O.
 */

type Json = Record<string, unknown>;

export type Prefer = "a" | "b";

export interface Merged<T> {
  value: T;
  /** Parts both sides changed differently, which took the preferred side. */
  conflicts: number;
}

/** Past this many line pairs, a body is not merged and the newer edit wins. */
export const MAX_MERGE_CELLS = 4_000_000;

const same = (x: unknown, y: unknown) => canonical(x) === canonical(y);

/** JSON with sorted keys, so equal values compare equal whatever their key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Json).sort(([x], [y]) => x.localeCompare(y)))
      : inner,
  );
}

/** One value: take whichever side changed it; if both did differently, the preferred one. */
export function mergeValue<T>(base: T, a: T, b: T, prefer: Prefer): Merged<T> {
  if (same(a, b)) return { value: a, conflicts: 0 };
  if (same(a, base)) return { value: b, conflicts: 0 };
  if (same(b, base)) return { value: a, conflicts: 0 };
  return { value: prefer === "a" ? a : b, conflicts: 1 };
}

/**
 * A set kept as a list: what either side added is kept, what either side
 * removed is dropped. Never a conflict. Order follows the preferred side,
 * then the other side's additions.
 */
export function mergeSet(base: readonly string[], a: readonly string[], b: readonly string[], prefer: Prefer): string[] {
  const inA = new Set(a);
  const inB = new Set(b);
  const removed = new Set(base.filter((item) => !inA.has(item) || !inB.has(item)));
  const [first, second] = prefer === "a" ? [a, b] : [b, a];
  const out: string[] = [];
  for (const item of [...first, ...second]) {
    if (!removed.has(item) && !out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * For each line of `base`, the index of the line it matches in `other`, or
 * -1, from a longest common subsequence. Null when the texts are too large to
 * compare in memory.
 */
function matches(base: string[], other: string[]): number[] | null {
  const map = new Array<number>(base.length).fill(-1);
  // Lines shared at the start and the end need no table, and are most of a
  // typical edit.
  let start = 0;
  while (start < base.length && start < other.length && base[start] === other[start]) {
    map[start] = start;
    start += 1;
  }
  let endBase = base.length;
  let endOther = other.length;
  while (endBase > start && endOther > start && base[endBase - 1] === other[endOther - 1]) {
    endBase -= 1;
    endOther -= 1;
    map[endBase] = endOther;
  }
  const n = endBase - start;
  const m = endOther - start;
  if (n === 0 || m === 0) return map;
  if (n * m > MAX_MERGE_CELLS) return null;

  // lengths[i][j]: the LCS of base[start+i..] and other[start+j..], row by row.
  const width = m + 1;
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        base[start + i] === other[start + j]
          ? lengths[(i + 1) * width + j + 1]! + 1
          : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (base[start + i] === other[start + j]) {
      map[start + i] = start + j;
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return map;
}

const equalLines = (x: string[], y: string[]) => x.length === y.length && x.every((line, k) => line === y[k]);

/**
 * diff3 on lines. A base line kept by both sides is stable; between stable
 * lines, a chunk changed on one side takes that change, and a chunk changed
 * on both takes the preferred side, counted as a conflict. Null when the
 * texts are too large to merge.
 */
export function mergeText(base: string, a: string, b: string, prefer: Prefer): Merged<string> | null {
  if (a === b) return { value: a, conflicts: 0 };
  if (a === base) return { value: b, conflicts: 0 };
  if (b === base) return { value: a, conflicts: 0 };

  const o = base.split("\n");
  const x = a.split("\n");
  const y = b.split("\n");
  const toA = matches(o, x);
  const toB = matches(o, y);
  if (toA === null || toB === null) return null;

  const out: string[] = [];
  let conflicts = 0;
  let i = 0;
  let ia = 0;
  let ib = 0;
  while (i < o.length || ia < x.length || ib < y.length) {
    if (i < o.length && toA[i] === ia && toB[i] === ib) {
      out.push(o[i]!);
      i += 1;
      ia += 1;
      ib += 1;
      continue;
    }
    // The next base line both sides kept ends this unstable chunk.
    let next = i;
    while (next < o.length && !(toA[next]! >= ia && toB[next]! >= ib)) next += 1;
    const endA = next < o.length ? toA[next]! : x.length;
    const endB = next < o.length ? toB[next]! : y.length;
    const chunkO = o.slice(i, next);
    const chunkA = x.slice(ia, endA);
    const chunkB = y.slice(ib, endB);
    if (equalLines(chunkA, chunkO)) out.push(...chunkB);
    else if (equalLines(chunkB, chunkO) || equalLines(chunkA, chunkB)) out.push(...chunkA);
    else {
      out.push(...(prefer === "a" ? chunkA : chunkB));
      conflicts += 1;
    }
    i = next;
    ia = endA;
    ib = endB;
  }
  return { value: out.join("\n"), conflicts };
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

/** The later of two verification times; a side that changed it wins over one that did not. */
function mergeVerified(base: unknown, a: unknown, b: unknown): unknown {
  const picked = mergeValue(base ?? null, a ?? null, b ?? null, "a");
  if (picked.conflicts === 0) return picked.value;
  const time = (value: unknown) => (typeof value === "string" ? Date.parse(value) : Number.NEGATIVE_INFINITY);
  return time(a) >= time(b) ? a : b;
}

/**
 * A page's content in the shape sync hashes: title, parent_id, tags, body,
 * and sources and verified_at when set. Null when the body is too large to
 * merge.
 */
export function mergePage(base: Json, a: Json, b: Json, prefer: Prefer): Merged<Json> | null {
  const body = mergeText(String(base["body"] ?? ""), String(a["body"] ?? ""), String(b["body"] ?? ""), prefer);
  if (body === null) return null;
  const title = mergeValue(base["title"], a["title"], b["title"], prefer);
  const parent = mergeValue(base["parent_id"] ?? null, a["parent_id"] ?? null, b["parent_id"] ?? null, prefer);
  const tags = mergeSet(strings(base["tags"]), strings(a["tags"]), strings(b["tags"]), prefer);
  const sources = mergeSet(strings(base["sources"]), strings(a["sources"]), strings(b["sources"]), prefer);
  const verified = mergeVerified(base["verified_at"], a["verified_at"], b["verified_at"]);
  return {
    value: {
      title: title.value,
      parent_id: parent.value,
      tags,
      body: body.value,
      ...(sources.length > 0 ? { sources } : {}),
      ...(typeof verified === "string" && verified !== "" ? { verified_at: verified } : {}),
    },
    conflicts: body.conflicts + title.conflicts + parent.conflicts,
  };
}

/** A row's content: each field on its own, and sources as a set. */
export function mergeRow(base: Json, a: Json, b: Json, prefer: Prefer): Merged<Json> {
  const values = (content: Json) => (content["values"] ?? {}) as Json;
  const [vo, va, vb] = [values(base), values(a), values(b)];
  const merged: Json = {};
  let conflicts = 0;
  for (const field of [...new Set([...Object.keys(va), ...Object.keys(vb), ...Object.keys(vo)])].sort()) {
    const picked = mergeValue(vo[field], va[field], vb[field], prefer);
    conflicts += picked.conflicts;
    if (picked.value !== undefined) merged[field] = picked.value;
  }
  const sources = mergeSet(strings(base["sources"]), strings(a["sources"]), strings(b["sources"]), prefer);
  return { value: { values: merged, ...(sources.length > 0 ? { sources } : {}) }, conflicts };
}
