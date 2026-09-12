/**
 * Line diff between two versions of a text. Revisions store full snapshots
 * (ADR-008 rule 2), so diffs are computed here, when someone looks at them.
 *
 * Longest common subsequence over lines. Quadratic, which is fine for pages of
 * a few thousand lines. Past {@link MAX_CELLS} it gives up and reports the
 * whole text as replaced, rather than stalling a request.
 */

export type DiffOp = "equal" | "add" | "remove";

export interface DiffLine {
  op: DiffOp;
  text: string;
}

export interface Diff {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** True when the texts were too large to diff line by line. */
  coarse: boolean;
}

const MAX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

export function diffLines(before: string, after: string): Diff {
  const a = splitLines(before);
  const b = splitLines(after);

  if (a.length * b.length > MAX_CELLS) {
    return {
      lines: [
        ...a.map((text) => ({ op: "remove" as const, text })),
        ...b.map((text) => ({ op: "add" as const, text })),
      ],
      added: b.length,
      removed: a.length,
      coarse: true,
    };
  }

  // lcs[i][j] is the LCS length of a[i..] and b[j..], stored flat.
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ op: "equal", text: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      lines.push({ op: "remove", text: a[i]! });
      removed += 1;
      i += 1;
    } else {
      lines.push({ op: "add", text: b[j]! });
      added += 1;
      j += 1;
    }
  }
  for (; i < a.length; i += 1) {
    lines.push({ op: "remove", text: a[i]! });
    removed += 1;
  }
  for (; j < b.length; j += 1) {
    lines.push({ op: "add", text: b[j]! });
    added += 1;
  }

  return { lines, added, removed, coarse: false };
}
