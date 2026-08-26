/**
 * The focus linter entry point.
 *
 * Source-only. It does not render, does not start the preview, does not open a
 * network connection and does not touch a Deck. That means it cannot check
 * visual ordering (rules R6-R8) -- those need a render and are a later phase.
 *
 * It never fails a build. Decision 7: warn, never block. The output has three
 * states, not two -- pass, warn, and "not analyzed" -- and the third is always
 * reported.
 */
import { getWorkspaceRoot } from "../config.js";
import { formatResult } from "./format.js";
import { findFocusStops, NotAnalyzed } from "./focusables.js";
import { buildGraph } from "./graph.js";
import { checkActivation } from "./rules/activation.js";
import { checkBanned } from "./rules/banned.js";
import { checkReachable } from "./rules/reachable.js";
import { checkReveal } from "./rules/reveal.js";
import { checkReversibility } from "./rules/reversibility.js";
import { Finding } from "./types.js";

export interface FocusLintResult {
  warnings: Finding[];
  notAnalyzed: NotAnalyzed[];
  stopsChecked: number;
  filesChecked: number;
  text: string;
}

export function lintFocus(pluginRoot?: string): FocusLintResult {
  const root = pluginRoot ?? getWorkspaceRoot();

  const { stops, notAnalyzed: stopGaps, files } = findFocusStops(root);
  const { moves, notAnalyzed: graphGaps } = buildGraph(stops, root);

  const allGaps: NotAnalyzed[] = [...stopGaps, ...graphGaps];

  const reachability = checkReachable(stops, moves, allGaps);

  const findings: Finding[] = [
    ...checkReversibility(stops, moves),
    ...reachability.findings,
    ...checkActivation(stops),
    ...checkBanned(root, stops),
    ...checkReveal(root),
  ];

  const notAnalyzed = [...allGaps, ...reachability.notAnalyzed];

  const text = formatResult({
    findings,
    notAnalyzed,
    stopsChecked: stops.length,
    filesChecked: files.length,
  });

  return {
    warnings: findings.filter((f) => f.severity === "warn"),
    notAnalyzed,
    stopsChecked: stops.length,
    filesChecked: files.length,
    text,
  };
}
