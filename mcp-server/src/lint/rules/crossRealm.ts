/**
 * Rule R14 -- instanceof across a document boundary.
 *
 * `instanceof Element` and `instanceof Node` compare against the `Element` /
 * `Node` constructor of *this* window. The Steam QAM can host more than one
 * document, and a real Element built by another document's constructor fails
 * that check -- it is still a genuine element, just not one this realm's
 * `Element` recognises as its own. This is what made a hidden-tab trap false
 * for every node it was ever handed. jsdom does not reproduce it: a test
 * environment with one global `window` shares a realm with itself by
 * construction, so the check that fails on device passes under test.
 *
 * The rule does not flag every `instanceof Element`/`Node` -- most are fine.
 * It flags the ones applied to a value that plausibly crossed a document
 * boundary to get here: an event's `target`/`relatedTarget` (the event may
 * have been observed on a node from any document), `document.activeElement`
 * (the same oracle rule R4 distrusts, for the same reason), or anything
 * reached through `contentDocument`/`contentWindow`/`elementFromPoint`. A
 * check against a value this code built or was handed directly -- a ref it
 * registered itself, a node from its own `document.createElement` -- is not
 * this rule's business.
 */
import ts from "typescript";
import { lineOf, parseFile, relPath, sourceFilesFor } from "../focusables.js";
import { Finding } from "../types.js";

const CHECKED_TYPES = new Set(["Element", "Node"]);

const CROSS_REALM_MARKERS = new Set([
  "target",
  "relatedTarget",
  "activeElement",
  "contentDocument",
  "contentWindow",
  "elementFromPoint",
]);

/** Does this expression's chain touch a property/method known to cross documents? */
function touchesCrossRealmSource(expr: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(n) && CROSS_REALM_MARKERS.has(n.name.text)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return found;
}

export function checkCrossRealmInstanceof(pluginRoot: string): Finding[] {
  const findings: Finding[] = [];

  for (const abs of sourceFilesFor(pluginRoot)) {
    const rel = relPath(pluginRoot, abs);
    const sf = parseFile(abs);
    const seen = new Set<number>();

    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
        ts.isIdentifier(node.right) &&
        CHECKED_TYPES.has(node.right.text) &&
        touchesCrossRealmSource(node.left)
      ) {
        const line = lineOf(node, sf);
        if (!seen.has(line)) {
          seen.add(line);
          findings.push({
            rule: "R14",
            severity: "warn",
            file: rel,
            line,
            headline: `instanceof ${node.right.text} checked on a node that may cross documents`,
            bullets: [
              "the QAM can host more than one document, each with its own Element/Node",
              "a real element from another document fails this instanceof and reads as \"not an element\"",
            ],
            action: "compare by ownership (a registered ref or .contains()) instead of instanceof",
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);
  }

  return findings;
}
