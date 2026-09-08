/**
 * Rule R13 -- D-pad routing via DOM key events.
 *
 * Steam never dispatches DOM keyboard events into a plugin. D-pad direction
 * and the A/B buttons run through Decky `Focusable` callbacks (`onMoveUp`,
 * `onMoveDown`, `onMoveLeft`, `onMoveRight`, `onOKButton`, `onCancelButton`).
 * A handler wired to `keydown` (or `keyup`/`keypress`) that switches on arrow
 * keys or Enter/Escape reads as working in a browser -- including the preview,
 * before this feature's other half -- and is dead code on hardware. This is
 * the exact shape that shipped once as "dead code on hardware and alive under
 * vitest, which is the recurrence engine."
 *
 * The rule only trips when a key-event handler actually inspects `.key`,
 * `.code`, `.keyCode` or `.which` against one of the names/codes Focusable
 * already owns. A keydown handler that checks something else entirely --
 * "Tab" for a text field, a letter for a shortcut -- is not this rule's
 * business, and flagging it would bury the warnings that matter.
 */
import ts from "typescript";
import { lineOf, parseFile, relPath, sourceFilesFor } from "../focusables.js";
import { Finding } from "../types.js";

const KEY_EVENT_NAMES = new Set(["keydown", "keyup", "keypress"]);
const KEY_JSX_PROPS = new Set(["onKeyDown", "onKeyUp", "onKeyPress"]);
const KEY_READ_PROPS = new Set(["key", "code", "keyCode", "which"]);

const MOVE_KEY_NAMES = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Up",
  "Down",
  "Left",
  "Right",
]);
const MOVE_KEY_CODES = new Set(["37", "38", "39", "40"]);
const ACTION_KEY_NAMES = new Set(["Enter", " ", "Spacebar", "Escape", "Esc"]);
const ACTION_KEY_CODES = new Set(["13", "32", "27"]);

type Kind = "move" | "action";

function bannedLiteral(node: ts.Node): Kind | null {
  if (ts.isStringLiteral(node)) {
    if (MOVE_KEY_NAMES.has(node.text)) return "move";
    if (ACTION_KEY_NAMES.has(node.text)) return "action";
    return null;
  }
  if (ts.isNumericLiteral(node)) {
    if (MOVE_KEY_CODES.has(node.text)) return "move";
    if (ACTION_KEY_CODES.has(node.text)) return "action";
  }
  return null;
}

function isKeyReadProp(node: ts.Node): boolean {
  return ts.isPropertyAccessExpression(node) && KEY_READ_PROPS.has(node.name.text);
}

const EQUALITY_OPS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** Does this handler body compare a key-event property against a banned key? */
function findKeyCheck(node: ts.Node): Kind | null {
  let found: Kind | null = null;

  const visit = (n: ts.Node): void => {
    if (found) return;

    if (ts.isBinaryExpression(n) && EQUALITY_OPS.has(n.operatorToken.kind)) {
      if (isKeyReadProp(n.left)) found = bannedLiteral(n.right);
      else if (isKeyReadProp(n.right)) found = bannedLiteral(n.left);
      if (found) return;
    }

    if (ts.isSwitchStatement(n) && isKeyReadProp(n.expression)) {
      for (const clause of n.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) {
          const hit = bannedLiteral(clause.expression);
          if (hit) {
            found = hit;
            return;
          }
        }
      }
    }

    ts.forEachChild(n, visit);
  };

  visit(node);
  return found;
}

/** Local, same-file function bodies, so a named handler can be followed one hop. */
function localFunctionBodies(sf: ts.SourceFile): Map<string, ts.Node> {
  const fns = new Map<string, ts.Node>();
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) {
      fns.set(n.name.text, n.body);
    } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      if (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) {
        fns.set(n.name.text, n.initializer.body);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return fns;
}

function handlerBody(expr: ts.Expression, localFns: Map<string, ts.Node>): ts.Node | null {
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return expr.body;
  if (ts.isIdentifier(expr)) return localFns.get(expr.text) ?? null;
  return null;
}

function actionFor(kind: Kind): string {
  return kind === "move"
    ? "onMoveUp / onMoveDown / onMoveLeft / onMoveRight"
    : "onOKButton / onCancelButton";
}

export function checkKeydownRouting(pluginRoot: string): Finding[] {
  const findings: Finding[] = [];

  for (const abs of sourceFilesFor(pluginRoot)) {
    const rel = relPath(pluginRoot, abs);
    const sf = parseFile(abs);
    const localFns = localFunctionBodies(sf);
    const seen = new Set<number>();

    const report = (line: number, kind: Kind, source: string): void => {
      if (seen.has(line)) return;
      seen.add(line);
      findings.push({
        rule: "R13",
        severity: "warn",
        file: rel,
        line,
        headline: `${source} routes ${kind === "move" ? "D-pad direction" : "A/B activation"} via a DOM key event`,
        bullets: [
          "Steam never dispatches DOM keyboard events into a plugin",
          "this handler can look alive in a browser and is dead code on device",
        ],
        action: `use ${actionFor(kind)} on the Focusable instead`,
      });
    };

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "addEventListener" &&
        node.arguments.length >= 2
      ) {
        const evtArg = node.arguments[0];
        if (ts.isStringLiteral(evtArg) && KEY_EVENT_NAMES.has(evtArg.text)) {
          const body = handlerBody(node.arguments[1], localFns);
          const hit = body ? findKeyCheck(body) : null;
          if (hit) report(lineOf(node, sf), hit, `"${evtArg.text}" listener`);
        }
      }

      if (ts.isJsxAttribute(node) && node.initializer) {
        const name = node.name.getText();
        if (KEY_JSX_PROPS.has(name)) {
          const init = node.initializer;
          if (ts.isJsxExpression(init) && init.expression) {
            const body = handlerBody(init.expression, localFns);
            const hit = body ? findKeyCheck(body) : null;
            if (hit) report(lineOf(node, sf), hit, name);
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);
  }

  return findings;
}
