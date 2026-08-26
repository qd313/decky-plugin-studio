/**
 * Rule R1 -- reversibility.
 *
 * If Down from A goes to B, then Up from B should go back to A. One-way trips
 * are the most common real D-pad bug: a user moves into a control and cannot
 * get back out the way they came.
 *
 * Two things this rule deliberately does not do. It skips any pair where either
 * end is unresolved, because an unresolved target may well be the move that
 * makes the pair reversible. And it does not warn when the reverse move exists
 * but lands on a different stop that is itself reachable -- entering a section
 * and leaving via its header is a legitimate shape, so that goes to `info`.
 */
import { FocusStop } from "../focusables.js";
import { Move, OPPOSITE } from "../graph.js";
import { ARROW, Finding, label, movePropFor } from "../types.js";

export function checkReversibility(stops: FocusStop[], moves: Move[]): Finding[] {
  const findings: Finding[] = [];
  const byId = new Map(stops.map((s) => [s.id, s]));

  // Every stop that some resolved move points at. Used to decide whether a
  // reverse move landing somewhere else is legitimate or is a dead end.
  const reachable = new Set<string>();
  for (const m of moves) if (m.to) reachable.add(m.to);

  for (const move of moves) {
    if (!move.to) continue; // unresolved: unknown, not wrong
    const from = byId.get(move.from);
    const to = byId.get(move.to);
    if (!from || !to) continue;

    const back = OPPOSITE[move.direction];
    const reverse = moves.find((m) => m.from === move.to && m.direction === back);

    if (reverse && reverse.to === move.from) continue; // correct

    const forward = `${label(from)} ${ARROW[move.direction]} ${label(to)}`;

    if (!reverse || !reverse.to) {
      findings.push({
        rule: "R1",
        severity: "warn",
        file: from.file,
        line: from.line,
        headline: "one-way move",
        bullets: [
          `${forward}, but ${label(to)} ${ARROW[back]} goes to nothing`,
          `a user who moves ${move.direction} here cannot get back the same way`,
        ],
        action: `add ${movePropFor(back)} on ${label(to)} pointing at ${label(from)}`,
      });
      continue;
    }

    const other = byId.get(reverse.to);
    const landsSomewhereReachable = reverse.to !== null && reachable.has(reverse.to);

    if (landsSomewhereReachable) {
      findings.push({
        rule: "R1",
        severity: "info",
        file: from.file,
        line: from.line,
        headline: "move returns to a different stop",
        bullets: [
          `${forward}, but ${label(to)} ${ARROW[back]} goes to ${label(other)}`,
          "that stop is reachable, so this is a legitimate section shape",
        ],
        action: "no change needed unless the return point is a surprise",
      });
      continue;
    }

    findings.push({
      rule: "R1",
      severity: "warn",
      file: from.file,
      line: from.line,
      headline: "one-way move",
      bullets: [
        `${forward}, but ${label(to)} ${ARROW[back]} goes to ${label(other)}`,
        `${label(other)} is not reachable from anywhere else`,
      ],
      action: `point ${movePropFor(back)} on ${label(to)} at ${label(from)}`,
    });
  }

  return findings;
}
