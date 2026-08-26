/**
 * Rule R3 -- activation.
 *
 * A stop the D-pad can reach but that does nothing when A is pressed. Reachable
 * but not pressable.
 *
 * A Focusable used purely as a wrapper is exempt. A scroll container is a
 * legitimate focus stop that owns no action of its own, and warning on it would
 * make the rule wrong on ordinary, correct code.
 */
import { ACTIVATION_PROPS, FocusStop } from "../focusables.js";
import { Finding } from "../types.js";

export function checkActivation(stops: FocusStop[]): Finding[] {
  const findings: Finding[] = [];

  for (const stop of stops) {
    if (stop.isContainer) continue;
    if (stop.props.some((p) => ACTIVATION_PROPS.has(p))) continue;

    findings.push({
      rule: "R3",
      severity: "warn",
      file: stop.file,
      line: stop.line,
      headline: `<${stop.tagName}> has no A-button action`,
      bullets: [
        "the D-pad can reach it but pressing A does nothing",
      ],
      action: "add onButtonDown or onActivate",
    });
  }

  return findings;
}
