/** A tiny line diff (LCS) for showing code edits in the plan. No dependency. Pure. */

export type DiffOp = { t: " " | "-" | "+"; line: string };

/** Above this many table cells the LCS is skipped and the result is a plain remove-all, add-all. */
const MAX_CELLS = 4_000_000;

export function diffLines(a: string[], b: string[]): DiffOp[] {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let ea = a.length;
  let eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const out: DiffOp[] = a.slice(0, lo).map((line) => ({ t: " ", line }));
  const x = a.slice(lo, ea);
  const y = b.slice(lo, eb);
  const n = x.length;
  const m = y.length;
  if (n * m > MAX_CELLS) {
    for (const line of x) out.push({ t: "-", line });
    for (const line of y) out.push({ t: "+", line });
  } else {
    // lcs[i][j] = length of the LCS of x[i..] and y[j..]
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = x[i] === y[j] ? (lcs[(i + 1) * w + j + 1] as number) + 1 : Math.max(lcs[(i + 1) * w + j] as number, lcs[i * w + j + 1] as number);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        out.push({ t: " ", line: x[i] as string });
        i++;
        j++;
      } else if ((lcs[(i + 1) * w + j] as number) >= (lcs[i * w + j + 1] as number)) {
        out.push({ t: "-", line: x[i++] as string });
      } else {
        out.push({ t: "+", line: y[j++] as string });
      }
    }
    while (i < n) out.push({ t: "-", line: x[i++] as string });
    while (j < m) out.push({ t: "+", line: y[j++] as string });
  }
  for (const line of a.slice(ea)) out.push({ t: " ", line });
  return out;
}

const toLines = (s: string): string[] => {
  if (s === "") return [];
  const l = s.split("\n");
  if (l[l.length - 1] === "") l.pop();
  return l;
};

export interface DiffStat {
  added: number;
  removed: number;
}

export const diffStat = (ops: DiffOp[]): DiffStat => ({
  added: ops.filter((o) => o.t === "+").length,
  removed: ops.filter((o) => o.t === "-").length,
});

/** Unified-style hunks (`@@ -a,b +c,d @@`) with `context` lines around each change. */
export function unifiedDiff(oldText: string, newText: string, context = 2, numbers = true): string[] {
  const ops = diffLines(toLines(oldText), toLines(newText));
  const keep = ops.map(() => false);
  ops.forEach((o, i) => {
    if (o.t === " ") return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const out: string[] = [];
  let oldNo = 1;
  let newNo = 1;
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) {
      const o = ops[i] as DiffOp;
      if (o.t !== "+") oldNo++;
      if (o.t !== "-") newNo++;
      i++;
      continue;
    }
    const start = i;
    const oldStart = oldNo;
    const newStart = newNo;
    const body: string[] = [];
    while (i < ops.length && keep[i]) {
      const o = ops[i] as DiffOp;
      body.push(`${o.t}${o.line}`);
      if (o.t !== "+") oldNo++;
      if (o.t !== "-") newNo++;
      i++;
    }
    const slice = ops.slice(start, i);
    out.push(numbers ? `@@ -${oldStart},${slice.filter((o) => o.t !== "+").length} +${newStart},${slice.filter((o) => o.t !== "-").length} @@` : "@@");
    out.push(...body);
  }
  return out;
}
