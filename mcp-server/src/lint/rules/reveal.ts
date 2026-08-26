/**
 * Rules R11 and R12 -- regions that rearrange the focus map.
 *
 * R11: a conditional region that reveals or removes focus stops. A toggle or a
 * modal changes where every direction leads, and on close focus can land
 * nowhere, which reads to a user as the D-pad freezing.
 *
 * R12: stops whose count depends on backend data. This is worse than R11
 * because the map changes with no user action at all.
 *
 * Decision 9 is what makes these usable: only warn when the region actually
 * contains at least one focus stop. Decision 11 is what makes them honest:
 * the only way to clear one is to declare the state in
 * .decky/focus-states.json. There is deliberately no mute comment. A mute is a
 * claim; a declaration is checkable, and later phases can render the declared
 * state and verify it.
 */
import fs from "fs";
import path from "path";
import ts from "typescript";
import {
  countFocusStopsIn,
  lineOf,
  parseFile,
  relPath,
  sourceFilesFor,
} from "../focusables.js";
import { Finding } from "../types.js";

/** Declared states, minus the implicit default. */
export function declaredStates(pluginRoot: string): string[] {
  const file = path.join(pluginRoot, ".decky", "focus-states.json");
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      states?: Array<{ name?: string }>;
    };
    return (parsed.states ?? [])
      .map((s) => s.name)
      .filter((n): n is string => typeof n === "string" && n !== "default");
  } catch {
    // A malformed state file must not silently suppress warnings, and must not
    // crash the run either. Treat it as "nothing declared".
    return [];
  }
}

function conditionText(node: ts.Node, sf: ts.SourceFile): string {
  const raw = node.getText(sf).replace(/\s+/g, " ").trim();
  return raw.length > 48 ? `${raw.slice(0, 45)}...` : raw;
}

/** Does this file talk to the plugin backend? Drives the R11/R12 split. */
function callsBackend(text: string): boolean {
  return /\bcall\s*\(|callPluginMethod/.test(text);
}

export function checkReveal(pluginRoot: string): Finding[] {
  const findings: Finding[] = [];
  const declared = declaredStates(pluginRoot);
  if (declared.length > 0) return findings; // week one: any declared state clears these

  for (const abs of sourceFilesFor(pluginRoot)) {
    const rel = relPath(pluginRoot, abs);
    const sf = parseFile(abs);
    const text = sf.getFullText();
    const backend = callsBackend(text);
    const seen = new Set<number>();

    const reveal = (line: number, cond: string, n: number): void => {
      if (seen.has(line)) return;
      seen.add(line);
      findings.push({
        rule: "R11",
        severity: "warn",
        file: rel,
        line,
        headline: `\`${cond}\` reveals ${n} focus ${n === 1 ? "stop" : "stops"}`,
        bullets: [
          "nothing outside this region points into it",
          "on close, focus may land nowhere → D-pad freezes",
          "checked: default only",
        ],
        action: "declare the other state in .decky/focus-states.json",
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isJsxExpression(node) && node.expression) {
        const expr = node.expression;

        // {cond && <JSX/>}
        if (
          ts.isBinaryExpression(expr) &&
          expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        ) {
          const n = countFocusStopsIn(expr.right, sf);
          if (n > 0) reveal(lineOf(node, sf), conditionText(expr.left, sf), n);
        }

        // {cond ? <A/> : <B/>}
        if (ts.isConditionalExpression(expr)) {
          const n = countFocusStopsIn(expr.whenTrue, sf) + countFocusStopsIn(expr.whenFalse, sf);
          if (n > 0) reveal(lineOf(node, sf), conditionText(expr.condition, sf), n);
        }

        // {items.map(...)} producing focus stops
        let mapped: ts.CallExpression | undefined;
        const findMap = (n: ts.Node): void => {
          if (mapped) return;
          if (
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            n.expression.name.text === "map"
          ) {
            mapped = n;
            return;
          }
          ts.forEachChild(n, findMap);
        };
        findMap(expr);

        if (mapped) {
          const n = countFocusStopsIn(mapped, sf);
          const line = lineOf(node, sf);
          if (n > 0 && !seen.has(line)) {
            seen.add(line);
            const source = ts.isPropertyAccessExpression(mapped.expression)
              ? conditionText(mapped.expression.expression, sf)
              : "list";
            findings.push(
              backend
                ? {
                    rule: "R12",
                    severity: "warn",
                    file: rel,
                    line,
                    headline: `\`${source}\` fills after a backend call, no user action`,
                    bullets: [`${n} stops now, unknown after load`, "checked: default only"],
                    action: "declare the loaded state in .decky/focus-states.json",
                  }
                : {
                    rule: "R11",
                    severity: "warn",
                    file: rel,
                    line,
                    headline: `\`${source}\` builds ${n} focus ${n === 1 ? "stop" : "stops"} at runtime`,
                    bullets: [
                      "the number of stops is not fixed in the source",
                      "on change, focus may land nowhere → D-pad freezes",
                      "checked: default only",
                    ],
                    action: "declare the populated state in .decky/focus-states.json",
                  },
            );
          }
        }
      }

      // Conditional style/className on an element that contains focus stops.
      if (ts.isJsxAttribute(node)) {
        const name = node.name.getText();
        if ((name === "style" || name === "className") && node.initializer) {
          let conditional = false;
          const findCond = (n: ts.Node): void => {
            if (conditional) return;
            if (ts.isConditionalExpression(n)) {
              conditional = true;
              return;
            }
            ts.forEachChild(n, findCond);
          };
          findCond(node.initializer);

          const owner = node.parent?.parent;
          if (conditional && owner) {
            const host = ts.isJsxElement(owner.parent!) ? owner.parent : owner;
            const n = countFocusStopsIn(host, sf);
            if (n > 0) reveal(lineOf(node, sf), `conditional ${name}`, n);
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);

    // Early `return null`: the whole component appears and disappears, which
    // removes every stop inside it from the map at once.
    const scanEarlyReturn = (node: ts.Node): void => {
      const isFn =
        ts.isFunctionDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node);

      if (isFn && node.body && ts.isBlock(node.body)) {
        let firstNullReturn: ts.ReturnStatement | undefined;
        let stopsReturned = 0;

        const walk = (n: ts.Node): void => {
          // Do not descend into nested functions -- their returns are not ours.
          if (
            n !== node &&
            (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n))
          ) {
            return;
          }
          if (ts.isReturnStatement(n)) {
            const e = n.expression;
            if (!e || e.kind === ts.SyntaxKind.NullKeyword) {
              firstNullReturn ??= n;
            } else {
              stopsReturned += countFocusStopsIn(e, sf);
            }
          }
          ts.forEachChild(n, walk);
        };
        ts.forEachChild(node.body, walk);

        if (firstNullReturn && stopsReturned > 0) {
          reveal(lineOf(firstNullReturn, sf), "early return null", stopsReturned);
        }
      }

      ts.forEachChild(node, scanEarlyReturn);
    };
    scanEarlyReturn(sf);
  }

  return findings;
}
