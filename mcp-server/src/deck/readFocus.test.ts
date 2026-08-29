/**
 * Tests for the JavaScript readFocus injects into the Steam client.
 *
 * WHY THIS FILE EXISTS. That code is a template literal, so the compiler never
 * looked at it and the suite could never run it -- the only way to exercise it
 * was to plug in a Deck. P1-10 lived there: an icon-only tab with no text of its
 * own borrowed the text of the entire Quick Access Menu, and `deck_walkTo`
 * substring-matched "bonsAI" against that dump and reported `found` after ZERO
 * presses, with the ring nowhere near bonsAI. Every host-side test passed
 * throughout, because they build FocusElement objects by hand and never execute
 * the page code that produces them.
 *
 * So the expression is evaluated here against a fake DOM small enough to write
 * out but real enough to reproduce the shapes that actually broke: an icon-only
 * control inside a huge container, a label on a child node rather than the focus
 * target, and Decky's ToggleField with its label four parents up.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";

import { pageExpression } from "./readFocus.js";

// ---------------------------------------------------------------------------
// A DOM just real enough. Only the handful of APIs the expression touches.
// ---------------------------------------------------------------------------

interface ElSpec {
  tag?: string;
  id?: string;
  className?: string;
  attrs?: Record<string, string>;
  /** This element's OWN text node, not its descendants'. */
  text?: string;
  rect?: { x: number; y: number; width: number; height: number };
  children?: ElSpec[];
}

class FakeEl {
  tagName: string;
  nodeType = 1;
  id: string;
  className: string;
  attrs: Record<string, string>;
  ownText: string;
  rect: { x: number; y: number; width: number; height: number };
  children: FakeEl[] = [];
  parentElement: FakeEl | null = null;

  constructor(spec: ElSpec) {
    this.tagName = (spec.tag ?? "div").toUpperCase();
    this.id = spec.id ?? "";
    this.className = spec.className ?? "";
    this.attrs = spec.attrs ?? {};
    this.ownText = spec.text ?? "";
    this.rect = spec.rect ?? { x: 0, y: 0, width: 0, height: 0 };
    for (const child of spec.children ?? []) {
      const el = new FakeEl(child);
      el.parentElement = this;
      this.children.push(el);
    }
  }

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join("");
  }

  /** Own text node first, then element children -- the order a browser gives. */
  get childNodes(): Array<{ nodeType: number; textContent: string }> {
    const nodes: Array<{ nodeType: number; textContent: string }> = [];
    if (this.ownText) nodes.push({ nodeType: 3, textContent: this.ownText });
    return nodes.concat(this.children as unknown as typeof nodes);
  }

  get classList(): { contains: (c: string) => boolean } {
    const classes = this.className.split(/\s+/).filter(Boolean);
    return { contains: (c: string) => classes.includes(c) };
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  getBoundingClientRect(): { x: number; y: number; width: number; height: number } {
    return this.rect;
  }

  descendants(): FakeEl[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector);
  }

  querySelector(selector: string): FakeEl | null {
    return this.descendants().find((d) => matchesSelector(d, selector)) ?? null;
  }

  querySelectorAll(selector: string): FakeEl[] {
    return selector === "*" ? this.descendants() : this.descendants().filter((d) => matchesSelector(d, selector));
  }

  closest(selector: string): FakeEl | null {
    let n: FakeEl | null = this;
    while (n) {
      if (matchesSelector(n, selector)) return n;
      n = n.parentElement;
    }
    return null;
  }
}

/** Only the selector forms the expression actually uses. */
function matchesSelector(el: FakeEl, selector: string): boolean {
  if (selector === "*") return true;
  if (selector === "[aria-label]") return el.getAttribute("aria-label") !== null;
  const prefix = /^\[id\^="(.+)"\]$/.exec(selector);
  if (prefix) return el.id.startsWith(prefix[1]);
  if (selector.startsWith(".")) return el.classList.contains(selector.slice(1));
  return false;
}

interface PageShape {
  hasGpfocus: boolean;
  gpfocus: {
    tag: string;
    ariaLabel: string | null;
    text: string;
    ownerText: string;
    label: string;
    labelSource: string | null;
    labelOverflow: boolean;
  } | null;
  deckyPanelLabels: string[];
  quickAccessTab: string | null;
  visibleQuickAccessTab: string | null;
  deckyPluginRoot: boolean;
}

/**
 * Evaluate the real injected expression against a fake document built from
 * `spec`. The element carrying `gpfocus` in its className is the focused one,
 * exactly as on a Deck -- Steam writes that class itself.
 */
function runPageExpression(spec: ElSpec, expect?: string): PageShape {
  const root = new FakeEl(spec);
  const all = [root, ...root.descendants()];

  const document = {
    activeElement: null as FakeEl | null,
    querySelector: (s: string) => all.find((el) => matchesSelector(el, s)) ?? null,
    querySelectorAll: (s: string) => (s === "*" ? all : all.filter((el) => matchesSelector(el, s))),
    getElementById: (id: string) => all.find((el) => el.id === id) ?? null,
  };
  const CSS = { escape: (s: string) => s };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("document", "CSS", `return ${pageExpression(expect)};`);
  return fn(document, CSS) as PageShape;
}

// ---------------------------------------------------------------------------

test("the injected expression is syntactically valid JavaScript", () => {
  // It is a string, so nothing else in the toolchain would ever tell us. A stray
  // backtick in a comment inside it silently ends the template literal.
  assert.doesNotThrow(() => new Function(`return ${pageExpression()};`));
  assert.doesNotThrow(() => new Function(`return ${pageExpression(".Focusable")};`));
});

test("P1-10: an icon-only control does not inherit the name of the pane it sits in", () => {
  /*
   * The exact shape from the rig, 2026-08-28. The ring is on a 59x56 tab icon
   * with no text of its own; the first ancestor with any text is the whole Quick
   * Access Menu. Reporting that as the control's name let a walk for "bonsAI"
   * match on press zero while the ring sat on an unrelated tab.
   */
  const page = runPageExpression({
    tag: "div",
    id: "quickaccess_content_999",
    rect: { x: 0, y: 0, width: 400, height: 800 },
    children: [
      { tag: "span", text: "Notifications" },
      { tag: "span", text: "Quick Settings" },
      { tag: "span", text: "Performance" },
      { tag: "span", text: "Soundtracks" },
      { tag: "span", text: "Help" },
      { tag: "span", text: "Decky" },
      { tag: "span", text: "bonsAI" },
      { tag: "span", text: "TabMaster" },
      { tag: "span", text: "MagicPods" },
      // The focus target: an icon, no text anywhere beneath it.
      { tag: "div", className: "Focusable gpfocus", rect: { x: 8, y: 40, width: 59, height: 56 } },
    ],
  });

  assert.equal(page.hasGpfocus, true);
  assert.equal(page.gpfocus?.label, "", "an unnameable control must come back unnamed");
  assert.equal(page.gpfocus?.labelOverflow, true, "and must say the text around it was a container's");
  assert.equal(page.gpfocus?.labelSource, null);
  assert.ok(
    !(page.gpfocus?.ownerText ?? "").includes("bonsAI"),
    `ownerText must not carry the pane dump either: ${page.gpfocus?.ownerText}`,
  );
});

test("P1-10: a control is named by its own aria-label ahead of its text", () => {
  // "Move gemma4:e2b-it-qat up" landed the ring exactly on this button and the
  // walk still reported found:false, because subtree text ("Up") was preferred.
  const page = runPageExpression({
    tag: "div",
    children: [
      {
        tag: "button",
        className: "Focusable gpfocus",
        attrs: { "aria-label": "Move gemma4:e2b-it-qat up" },
        children: [{ tag: "span", text: "Up" }],
      },
    ],
  });

  assert.equal(page.gpfocus?.label, "Move gemma4:e2b-it-qat up");
  assert.equal(page.gpfocus?.labelSource, "aria-label");
  assert.equal(page.gpfocus?.text, "Up", "the raw text field still reports what it always did");
});

test("P1-10: an aria-label on a CHILD names the control the ring is actually on", () => {
  /*
   * Steam puts the ring on the outer Focusable wrapper, so a consumer who labels
   * their tab labels a node inside it. bonsAI added aria-label to each tab title
   * specifically to fix this and the rig still read past them -- only the focus
   * target itself was ever consulted, so the fix could not have worked from the
   * consumer's side.
   */
  const page = runPageExpression({
    tag: "div",
    children: [
      {
        tag: "div",
        className: "Focusable gpfocus",
        children: [{ tag: "div", attrs: { "aria-label": "Ask bonsAI" } }],
      },
    ],
  });

  assert.equal(page.gpfocus?.label, "Ask bonsAI");
  assert.equal(page.gpfocus?.labelSource, "descendant-aria-label");
});

test("aria-labelledby is resolved through to the referenced text", () => {
  const page = runPageExpression({
    tag: "div",
    children: [
      { tag: "span", id: "lbl-1", text: "Hybrid retrieval" },
      { tag: "div", className: "Focusable gpfocus", attrs: { "aria-labelledby": "lbl-1" } },
    ],
  });

  assert.equal(page.gpfocus?.label, "Hybrid retrieval");
  assert.equal(page.gpfocus?.labelSource, "aria-labelledby");
});

test("the ToggleField fallback survives: a label four parents up still names the control", () => {
  /*
   * The case the ancestor climb was added for, and the one the P1-10 fix must
   * not break. Decky's ToggleField puts the ring on an unlabelled inner div and
   * keeps the label several levels up; without this every settings toggle reads
   * as an anonymous <DIV> and any assertion against one is a false negative.
   */
  const page = runPageExpression({
    tag: "div",
    children: [
      {
        tag: "div",
        text: "On-screen debug HUD",
        children: [
          { tag: "div", children: [{ tag: "div", children: [{ tag: "div", className: "Focusable gpfocus" }] }] },
        ],
      },
    ],
  });

  assert.equal(page.gpfocus?.label, "On-screen debug HUD");
  assert.equal(page.gpfocus?.labelSource, "ancestor-text", "and it is marked as borrowed, not as its own");
  assert.equal(page.gpfocus?.labelOverflow, false);
});

test("a control's own short text names it, and is not marked as borrowed", () => {
  const page = runPageExpression({
    tag: "div",
    children: [{ tag: "button", className: "Focusable gpfocus", text: "Retry" }],
  });

  assert.equal(page.gpfocus?.label, "Retry");
  assert.equal(page.gpfocus?.labelSource, "text");
});

test("deckyPanelLabels still lists the pane's own short labels", () => {
  // P1-9 leans on this list, so pin that it keeps collecting own-text-node
  // labels and keeps excluding prose.
  const page = runPageExpression({
    tag: "div",
    id: "quickaccess_content_999",
    rect: { x: 0, y: 0, width: 400, height: 800 },
    children: [
      { tag: "span", text: "bonsAI" },
      { tag: "span", text: "v0.5.0" },
      { tag: "button", className: "Focusable gpfocus", text: "ask" },
      { tag: "p", text: "write a long detailed explanation of how bonsai trees are pruned, please" },
    ],
  });

  assert.ok(page.deckyPanelLabels.includes("bonsAI"));
  assert.ok(page.deckyPanelLabels.includes("v0.5.0"));
  assert.ok(
    !page.deckyPanelLabels.some((l) => l.includes("pruned")),
    "prose is not a label",
  );
  assert.equal(page.quickAccessTab, "999");
  assert.equal(page.visibleQuickAccessTab, "999");
  assert.equal(page.deckyPluginRoot, true);
});
