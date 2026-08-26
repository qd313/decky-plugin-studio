/**
 * Render findings as text.
 *
 * The summary always ends with a `not analyzed` block, and that block is never
 * omitted -- when it is empty it prints "not analyzed: none". Trimming it as
 * "cleaner output" would undo the point of this build. A linter that silently
 * skips what it could not read is the same failure as a focus trace that echoes
 * its own inputs: a success-shaped result for work that did not happen.
 *
 * Findings are in file order, not severity order. Someone working through them
 * has a file open, not a severity filter.
 */
import { NotAnalyzed } from "./focusables.js";
import { Finding } from "./types.js";

export interface LintResult {
  findings: Finding[];
  notAnalyzed: NotAnalyzed[];
  stopsChecked: number;
  filesChecked: number;
}

function byFileThenLine(a: { file: string; line: number }, b: { file: string; line: number }): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line;
}

function renderFinding(f: Finding): string {
  const marker = f.severity === "warn" ? "⚠" : "ℹ";
  const lines = [`${marker} ${f.file}:${f.line} — ${f.headline}`];
  for (const b of f.bullets) lines.push(`   · ${b}`);
  lines.push(`   → ${f.action}`);
  return lines.join("\n");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function formatResult(result: LintResult): string {
  const { findings, notAnalyzed, stopsChecked, filesChecked } = result;
  const out: string[] = [];

  const ordered = [...findings].sort(byFileThenLine);
  for (const f of ordered) {
    out.push(renderFinding(f));
    out.push("");
  }

  const warnCount = findings.filter((f) => f.severity === "warn").length;
  out.push(
    `${plural(warnCount, "warning")} · ${notAnalyzed.length} not analyzed · ` +
      `${stopsChecked} stops checked across ${plural(filesChecked, "file")}`,
  );

  out.push("");
  if (notAnalyzed.length === 0) {
    out.push("not analyzed: none");
    return out.join("\n");
  }

  out.push("not analyzed:");
  const rows = [...notAnalyzed].sort(byFileThenLine).map((n) => ({
    where: `${n.file}:${n.line}`,
    detail: n.detail,
  }));
  const width = Math.max(...rows.map((r) => r.where.length));
  for (const r of rows) out.push(`  ${r.where.padEnd(width)}  ${r.detail}`);

  return out.join("\n");
}
