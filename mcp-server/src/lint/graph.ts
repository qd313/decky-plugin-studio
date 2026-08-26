/**
 * Build the move graph: for each focus stop, where each direction leads.
 *
 * Resolution is deliberately in-file only. A move handler that reaches a ref
 * declared in another module is Tier 3, and the honest answer there is "I do
 * not know" -- `to: null` plus a `notAnalyzed` entry. An unresolved target is
 * unknown, not wrong, so it never becomes a warning on its own. Warning on
 * unknowns is how a linter teaches people to ignore it.
 *
 * Nothing here infers a move from JSX source order. Source order is not the
 * focus order, and pretending otherwise is exactly the confident-but-wrong
 * behaviour this tool exists to avoid. Ordering needs a render (rules R6-R8),
 * which is a later phase.
 */
import ts from "typescript";
import {
  FocusStop,
  MOVE_PROPS,
  NotAnalyzed,
  lineOf,
  parseFile,
  propNamesOf,
  relPath,
  sourceFilesFor,
  tagNameOf,
} from "./focusables.js";

export type Direction = "up" | "down" | "left" | "right";

export interface Move {
  /** FocusStop.id of the origin. */
  from: string;
  direction: Direction;
  /** FocusStop.id of the target, or null when it could not be resolved in-file. */
  to: string | null;
  unresolvedReason?: string;
}

const PROP_TO_DIRECTION: Record<string, Direction> = {
  onMoveUp: "up",
  onMoveDown: "down",
  onMoveLeft: "left",
  onMoveRight: "right",
};

export const OPPOSITE: Record<Direction, Direction> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function attributeNamed(node: Opening, name: string): ts.JsxAttribute | undefined {
  for (const prop of node.attributes.properties) {
    if (ts.isJsxAttribute(prop) && prop.name.getText() === name) return prop;
  }
  return undefined;
}

/** Every identifier mentioned anywhere inside a node. */
function identifiersIn(node: ts.Node): string[] {
  const names: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) names.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return names;
}

/**
 * Locally declared functions, so a handler like `onMoveDown={goToSave}` can be
 * followed one level to the ref it focuses. One level only -- deeper chains are
 * indistinguishable from arbitrary program logic and belong in notAnalyzed.
 */
function collectLocalFunctions(sf: ts.SourceFile): Map<string, ts.Node> {
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

export function buildGraph(
  stops: FocusStop[],
  pluginRoot: string,
): { moves: Move[]; notAnalyzed: NotAnalyzed[] } {
  const moves: Move[] = [];
  const notAnalyzed: NotAnalyzed[] = [];

  const stopIds = new Set(stops.map((s) => s.id));
  const stopsByFile = new Map<string, Set<string>>();
  for (const s of stops) {
    if (!stopsByFile.has(s.file)) stopsByFile.set(s.file, new Set());
    stopsByFile.get(s.file)!.add(s.id);
  }

  for (const abs of sourceFilesFor(pluginRoot)) {
    const rel = relPath(pluginRoot, abs);
    if (!stopsByFile.has(rel)) continue;

    const sf = parseFile(abs);
    const localFns = collectLocalFunctions(sf);

    // Pass 1: map each ref identifier to the stop that carries it.
    const refToStop = new Map<string, string>();
    const openings: Array<{ node: Opening; id: string }> = [];

    const collect = (node: ts.Node): void => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening: Opening = ts.isJsxElement(node) ? node.openingElement : node;
        const id = `${rel}:${lineOf(opening, sf)}:${tagNameOf(opening, sf)}`;
        if (stopIds.has(id)) {
          openings.push({ node: opening, id });
          const refAttr = attributeNamed(opening, "ref");
          const init = refAttr?.initializer;
          if (init && ts.isJsxExpression(init) && init.expression) {
            if (ts.isIdentifier(init.expression)) {
              refToStop.set(init.expression.text, id);
            }
          }
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(sf);

    // Pass 2: resolve each directional handler to a target stop.
    for (const { node, id } of openings) {
      const props = propNamesOf(node);
      for (const moveProp of MOVE_PROPS) {
        if (!props.includes(moveProp)) continue;
        const direction = PROP_TO_DIRECTION[moveProp];
        const attr = attributeNamed(node, moveProp);
        const init = attr?.initializer;

        let target: string | null = null;
        if (init && ts.isJsxExpression(init) && init.expression) {
          target = resolveTarget(init.expression, refToStop, localFns);
        }

        if (target) {
          moves.push({ from: id, direction, to: target });
        } else {
          moves.push({
            from: id,
            direction,
            to: null,
            unresolvedReason: "target not declared in this file",
          });
          notAnalyzed.push({
            reason: "cross-file-ref",
            detail: `${moveProp} target could not be resolved in this file`,
            file: rel,
            line: lineOf(node, sf),
          });
        }
      }
    }
  }

  return { moves, notAnalyzed };
}

function resolveTarget(
  expr: ts.Node,
  refToStop: Map<string, string>,
  localFns: Map<string, ts.Node>,
  depth = 0,
): string | null {
  const names = identifiersIn(expr);

  for (const name of names) {
    const hit = refToStop.get(name);
    if (hit) return hit;
  }

  if (depth >= 1) return null;

  for (const name of names) {
    const body = localFns.get(name);
    if (body) {
      const hit = resolveTarget(body, refToStop, localFns, depth + 1);
      if (hit) return hit;
    }
  }

  return null;
}
