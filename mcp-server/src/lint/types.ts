/**
 * Shared shapes for the focus linter's findings.
 *
 * The warning shape is fixed by decision 10: one headline, at most three
 * bullets, one action line. It is not a style preference. A developer who is
 * not thinking about D-pad needs to read a finding in about five seconds, and
 * every extra line spent is one they will not spend on the fix.
 */
import { FocusStop } from "./focusables.js";
import { Direction } from "./graph.js";

export type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R11" | "R12";

export interface Finding {
  rule: RuleId;
  /** "warn" is a problem; "info" is a legitimate pattern worth naming. */
  severity: "warn" | "info";
  file: string;
  line: number;
  /** Text after "file:line — ". No trailing punctuation. */
  headline: string;
  /** At most three. */
  bullets: string[];
  /** The single "→" line. */
  action: string;
}

export const ARROW: Record<Direction, string> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};

/** How a stop is named inside a finding. Short enough to sit in a bullet. */
export function label(stop: FocusStop | undefined): string {
  if (!stop) return "nothing";
  return `<${stop.tagName}> line ${stop.line}`;
}

/** The prop a developer would add to create a move in this direction. */
export function movePropFor(direction: Direction): string {
  return `onMove${direction.charAt(0).toUpperCase()}${direction.slice(1)}`;
}
