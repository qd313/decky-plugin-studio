/**
 * Rule R2 -- unreachable stops.
 *
 * A control the D-pad can never land on is visible, looks interactive, and is
 * dead. It is the button nothing can reach.
 *
 * The suppression here is the important part. If a file has any unresolved
 * reference or any runtime-built children, this rule does not run for that file
 * at all -- it emits one "not analyzed" line instead. An unresolved ref can be
 * exactly the move that makes a stop reachable, and warning anyway produces
 * confident false accusations. That is the fastest way to get a linter turned
 * off, and a linter nobody runs catches nothing.
 */
import { FocusStop, NotAnalyzed } from "../focusables.js";
import { Move } from "../graph.js";
import { Finding } from "../types.js";

const BLOCKING_REASONS = new Set<NotAnalyzed["reason"]>(["cross-file-ref", "dynamic-children"]);

export function checkReachable(
  stops: FocusStop[],
  moves: Move[],
  notAnalyzed: NotAnalyzed[],
): { findings: Finding[]; notAnalyzed: NotAnalyzed[] } {
  const findings: Finding[] = [];
  const extraNotAnalyzed: NotAnalyzed[] = [];

  // Which files cannot be judged, and why.
  const blocked = new Map<string, NotAnalyzed>();
  for (const n of notAnalyzed) {
    if (BLOCKING_REASONS.has(n.reason) && !blocked.has(n.file)) blocked.set(n.file, n);
  }

  const targeted = new Set<string>();
  for (const m of moves) if (m.to) targeted.add(m.to);

  // The first stop in a file is an entry point, not an orphan.
  const firstInFile = new Map<string, string>();
  for (const s of stops) if (!firstInFile.has(s.file)) firstInFile.set(s.file, s.id);

  const filesWithStops = new Set(stops.map((s) => s.file));

  for (const file of filesWithStops) {
    const blocker = blocked.get(file);
    if (blocker) {
      extraNotAnalyzed.push({
        reason: blocker.reason,
        detail: "reachability not checked: this file has references we could not resolve",
        file,
        line: blocker.line,
      });
      continue;
    }

    for (const stop of stops.filter((s) => s.file === file)) {
      if (targeted.has(stop.id)) continue;
      if (firstInFile.get(file) === stop.id) continue;

      findings.push({
        rule: "R2",
        severity: "warn",
        file: stop.file,
        line: stop.line,
        headline: `<${stop.tagName}> cannot be reached`,
        bullets: [
          "nothing points to it with any direction",
          "it is visible but the D-pad can never land on it",
        ],
        action: "point a neighbour's onMove* at it",
      });
    }
  }

  return { findings, notAnalyzed: extraNotAnalyzed };
}
