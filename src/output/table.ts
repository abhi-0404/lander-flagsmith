// Plain text table rendering. No dependencies. Cells may carry ANSI colors; widths ignore them.

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export const visibleLength = (s: string): number => s.replace(ANSI, "").length;

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleLength(s)));
}

/** Render rows under a header with two spaces between columns and a rule under the header. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i] ?? ""))));
  const line = (cells: string[]): string => cells.map((c, i) => pad(c, widths[i] ?? 0)).join("  ").trimEnd();
  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(headers), rule, ...rows.map((r) => line(headers.map((_, i) => r[i] ?? "")))].join("\n");
}
