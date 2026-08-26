/**
 * Find the focus stops in a plugin's source.
 *
 * Parsing uses the TypeScript compiler API rather than regex. Focus analysis
 * needs JSX element boundaries, nesting, prop names and identifier identity; a
 * regex version produces both false positives and false negatives, and those
 * get blamed on the rules rather than on the parser.
 *
 * The rule that governs this file: when we cannot tell, we say so. A custom
 * component may wrap a Focusable and therefore BE a focus stop, and we cannot
 * know that without resolving imports, which is out of scope. Such components
 * go to `notAnalyzed` -- they are never assumed to be non-focusable. Assuming
 * otherwise makes every later rule quietly wrong, which is the exact class of
 * silent failure this linter exists to remove.
 */
import fs from "fs";
import path from "path";
import ts from "typescript";
import { walkSourceFiles } from "./files.js";

/** Tags that are focus stops purely by being themselves. */
export const FOCUSABLE_TAGS = new Set([
  "Focusable",
  "Button",
  "DialogButton",
  "ButtonItem",
  "ToggleField",
  "SliderField",
  "DropdownItem",
  "Dropdown",
  "TextField",
]);

/** Layout wrappers known NOT to be focus stops. Known, not merely unrecognised. */
export const CONTAINER_TAGS = new Set([
  "PanelSection",
  "PanelSectionRow",
  "DialogBody",
  "Fragment",
  "React.Fragment",
]);

/** The four directional props, in a fixed order for stable output. */
export const MOVE_PROPS = ["onMoveUp", "onMoveDown", "onMoveLeft", "onMoveRight"] as const;

/** Any of these props makes an element a focus stop regardless of its tag. */
const FOCUS_PROPS = new Set<string>([
  ...MOVE_PROPS,
  "onButtonDown",
  "onActivate",
  "onOKButton",
  "onCancelButton",
  "onSecondaryButton",
]);

/** Props that count as "pressing A does something". Used by rule R3. */
export const ACTIVATION_PROPS = new Set([
  "onButtonDown",
  "onActivate",
  "onOKButton",
  "onClick",
  "onChange",
]);

export interface FocusStop {
  /** Stable identity: `${relPath}:${line}:${tagName}`. */
  id: string;
  tagName: string;
  /** Repo-relative, forward slashes. */
  file: string;
  line: number;
  /** Prop names present on the element. */
  props: string[];
  /** A stop that wraps children and owns no action of its own. */
  isContainer: boolean;
}

export interface NotAnalyzed {
  reason: "unknown-component" | "dynamic-children" | "cross-file-ref";
  detail: string;
  file: string;
  line: number;
}

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx") || file.endsWith(".jsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".js")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function parseFile(absPath: string): ts.SourceFile {
  const text = fs.readFileSync(absPath, "utf8");
  return ts.createSourceFile(
    absPath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(absPath),
  );
}

/** Source roots to scan, in the same spirit as the RPC differ: `src/` when present. */
export function sourceFilesFor(pluginRoot: string): string[] {
  const srcDir = path.join(pluginRoot, "src");
  const start = fs.existsSync(srcDir) ? srcDir : pluginRoot;
  const out: string[] = [];
  walkSourceFiles(start, out);
  return out;
}

export function relPath(pluginRoot: string, absPath: string): string {
  return path.relative(pluginRoot, absPath).split(path.sep).join("/");
}

export function propNamesOf(node: Opening): string[] {
  const names: string[] = [];
  for (const prop of node.attributes.properties) {
    if (ts.isJsxAttribute(prop)) names.push(prop.name.getText());
  }
  return names;
}

export function tagNameOf(node: Opening, sf: ts.SourceFile): string {
  return node.tagName.getText(sf);
}

export function lineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Lowercase first letter means an intrinsic HTML element, e.g. div. */
function isIntrinsic(tagName: string): boolean {
  const first = tagName.charAt(0);
  return first !== "" && first === first.toLowerCase() && first !== first.toUpperCase();
}

function isFocusStop(tagName: string, props: string[]): boolean {
  if (FOCUSABLE_TAGS.has(tagName)) return true;
  if (props.includes("focusable")) return true;
  return props.some((p) => FOCUS_PROPS.has(p));
}

/**
 * Does this element have JSX children? Used to tell a wrapper Focusable -- a
 * legitimate stop that owns no action -- from a leaf control that forgot its
 * handler. Rule R3 must not warn on the former.
 */
function hasElementChildren(node: ts.Node): boolean {
  if (!ts.isJsxElement(node)) return false;
  return node.children.some(
    (c) =>
      ts.isJsxElement(c) ||
      ts.isJsxSelfClosingElement(c) ||
      ts.isJsxFragment(c) ||
      ts.isJsxExpression(c),
  );
}

/** Does this subtree contain any JSX element at all? */
export function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * How many focus stops are inside this subtree?
 *
 * This is the filter that makes the reveal rules usable. Conditional rendering
 * is everywhere in React -- a typical plugin has dozens -- so a reveal warning
 * only earns its place when the hidden region actually contains something the
 * D-pad can land on (decision 9). Without this count the rule is noise and gets
 * switched off on day one.
 */
export function countFocusStopsIn(node: ts.Node, sf: ts.SourceFile): number {
  let n = 0;
  const visit = (x: ts.Node): void => {
    if (ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x)) {
      const opening: Opening = ts.isJsxElement(x) ? x.openingElement : x;
      if (isFocusStop(tagNameOf(opening, sf), propNamesOf(opening))) n++;
    }
    ts.forEachChild(x, visit);
  };
  visit(node);
  return n;
}

/** A .map() call anywhere in this expression -- children counted at runtime. */
function isDynamicChildren(node: ts.JsxExpression): boolean {
  const expr = node.expression;
  if (!expr) return false;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.getText() === "map"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return found;
}

export function findFocusStopsInFile(
  sf: ts.SourceFile,
  rel: string,
): { stops: FocusStop[]; notAnalyzed: NotAnalyzed[] } {
  const stops: FocusStop[] = [];
  const notAnalyzed: NotAnalyzed[] = [];
  const seenUnknown = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening: Opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tagName = tagNameOf(opening, sf);
      const props = propNamesOf(opening);
      const line = lineOf(opening, sf);

      if (isFocusStop(tagName, props)) {
        const ownsAction = props.some((p) => ACTIVATION_PROPS.has(p));
        stops.push({
          id: `${rel}:${line}:${tagName}`,
          tagName,
          file: rel,
          line,
          props,
          isContainer: hasElementChildren(node) && !ownsAction,
        });
      } else if (!isIntrinsic(tagName) && !CONTAINER_TAGS.has(tagName)) {
        // A component we did not write and cannot resolve. It may wrap a
        // Focusable. We do not guess -- not from the name, not from anything.
        const key = `${tagName}:${line}`;
        if (!seenUnknown.has(key)) {
          seenUnknown.add(key);
          notAnalyzed.push({
            reason: "unknown-component",
            detail: `unknown component <${tagName}>`,
            file: rel,
            line,
          });
        }
      }
    }

    if (ts.isJsxExpression(node) && isDynamicChildren(node) && containsJsx(node)) {
      notAnalyzed.push({
        reason: "dynamic-children",
        detail: "stops built from data at runtime",
        file: rel,
        line: lineOf(node, sf),
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return { stops, notAnalyzed };
}

export function findFocusStops(pluginRoot: string): {
  stops: FocusStop[];
  notAnalyzed: NotAnalyzed[];
  files: string[];
} {
  const stops: FocusStop[] = [];
  const notAnalyzed: NotAnalyzed[] = [];
  const files: string[] = [];

  for (const abs of sourceFilesFor(pluginRoot)) {
    const rel = relPath(pluginRoot, abs);
    const sf = parseFile(abs);
    const res = findFocusStopsInFile(sf, rel);
    if (res.stops.length || res.notAnalyzed.length) files.push(rel);
    stops.push(...res.stops);
    notAnalyzed.push(...res.notAnalyzed);
  }

  return { stops, notAnalyzed, files };
}
