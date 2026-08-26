/**
 * Rules R4 and R5 -- banned focus patterns.
 *
 * R4, document.activeElement: Steam's gamepad focus and the browser's
 * activeElement disagree on Deck. bonsAI shipped three no-op focus fixes that
 * all "passed" because the check read activeElement and believed it.
 *
 * R5, page searching: querySelector and friends find elements before they
 * exist, find stale copies, or find things Steam will not focus. The fix is
 * always the same shape -- register the element when it is created and keep the
 * handle.
 *
 * Scope matters as much as detection. A querySelector in unrelated code is not
 * this rule's business, so only files that actually wire focus are scanned.
 * Flagging every DOM call in a codebase would bury the two that matter.
 */
import ts from "typescript";
import {
  FocusStop,
  MOVE_PROPS,
  parseFile,
  relPath,
  sourceFilesFor,
  lineOf,
} from "../focusables.js";
import { Finding } from "../types.js";

const SEARCH_CALLS = new Set([
  "querySelector",
  "querySelectorAll",
  "getElementById",
  "getElementsByClassName",
  "getElementsByTagName",
  "closest",
  "matches",
]);

const SELECTOR_STRING = /aria-label|\[data-/;

function isFocusContext(text: string, fileStops: FocusStop[]): boolean {
  if (fileStops.some((s) => s.props.some((p) => (MOVE_PROPS as readonly string[]).includes(p)))) {
    return true;
  }
  return text.includes("onMove");
}

export function checkBanned(pluginRoot: string, stops: FocusStop[]): Finding[] {
  const findings: Finding[] = [];
  const stopsByFile = new Map<string, FocusStop[]>();
  for (const s of stops) {
    if (!stopsByFile.has(s.file)) stopsByFile.set(s.file, []);
    stopsByFile.get(s.file)!.push(s);
  }

  for (const abs of sourceFilesFor(pluginRoot)) {
    const rel = relPath(pluginRoot, abs);
    const sf = parseFile(abs);
    if (!isFocusContext(sf.getFullText(), stopsByFile.get(rel) ?? [])) continue;

    // One finding per line per rule; a chained expression should not shout twice.
    const seen = new Set<string>();
    const push = (rule: "R4" | "R5", line: number): void => {
      const key = `${rule}:${line}`;
      if (seen.has(key)) return;
      seen.add(key);

      findings.push(
        rule === "R4"
          ? {
              rule,
              severity: "warn",
              file: rel,
              line,
              headline: "activeElement is not a focus oracle on Deck",
              bullets: [
                "Steam's gamepad focus and the browser's activeElement disagree",
                "a check written this way reports moves that never happened",
              ],
              action: "use a registered focus owner instead",
            }
          : {
              rule,
              severity: "warn",
              file: rel,
              line,
              headline: "searching the page for a focus target",
              bullets: [
                "finds elements before they exist, or stale copies, or ones Steam will not focus",
              ],
              action: "register the element when it is created and use that handle",
            },
      );
    };

    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "activeElement"
      ) {
        push("R4", lineOf(node, sf));
      }

      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        SEARCH_CALLS.has(node.expression.name.text)
      ) {
        push("R5", lineOf(node, sf));
      }

      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        SELECTOR_STRING.test(node.text)
      ) {
        push("R5", lineOf(node, sf));
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);
  }

  return findings;
}
