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
  /** `pointer-events: none` -- the fake elementFromPoint skips it, as a browser does. */
  pointerEvents?: "none";
  /** Paint order override; ties go to the later element in document order. */
  zIndex?: number;
  /** `overflow: hidden` -- descendants are only hittable inside this box. */
  clips?: boolean;
  /** `border-radius` in px: the corners outside the arc are not part of the box. */
  radius?: number;
  /** A scrolling pane: scrollHeight/clientHeight/scrollTop as the page reads them. */
  scroll?: { scrollTop: number; scrollHeight: number; clientHeight: number };
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
  pointerEvents: "none" | undefined;
  zIndex: number;
  clips: boolean;
  radius: number;
  scrollTop: number | undefined;
  scrollHeight: number | undefined;
  clientHeight: number | undefined;
  children: FakeEl[] = [];
  parentElement: FakeEl | null = null;

  constructor(spec: ElSpec) {
    this.tagName = (spec.tag ?? "div").toUpperCase();
    this.id = spec.id ?? "";
    this.className = spec.className ?? "";
    this.attrs = spec.attrs ?? {};
    this.ownText = spec.text ?? "";
    this.rect = spec.rect ?? { x: 0, y: 0, width: 0, height: 0 };
    this.pointerEvents = spec.pointerEvents;
    this.zIndex = spec.zIndex ?? 0;
    this.clips = spec.clips ?? false;
    this.radius = spec.radius ?? 0;
    this.scrollTop = spec.scroll?.scrollTop;
    this.scrollHeight = spec.scroll?.scrollHeight;
    this.clientHeight = spec.scroll?.clientHeight;
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

  getBoundingClientRect(): {
    x: number;
    y: number;
    width: number;
    height: number;
    left: number;
    top: number;
    right: number;
    bottom: number;
  } {
    const r = this.rect;
    return { ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height };
  }

  containsPoint(x: number, y: number): boolean {
    const r = this.rect;
    if (!(r.width > 0 && r.height > 0 && x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) {
      return false;
    }
    // Rounded corners: outside the arc is not the element, as in a browser.
    const rad = Math.min(this.radius, r.width / 2, r.height / 2);
    if (rad <= 0) return true;
    const cx = x < r.x + rad ? r.x + rad : x > r.x + r.width - rad ? r.x + r.width - rad : x;
    const cy = y < r.y + rad ? r.y + rad : y > r.y + r.height - rad ? r.y + r.height - rad : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
  }

  contains(other: FakeEl | null): boolean {
    let n: FakeEl | null = other;
    while (n) {
      if (n === this) return true;
      n = n.parentElement;
    }
    return false;
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
  visibility: {
    verdict: "visible" | "partial" | "covered" | "offscreen";
    visiblePercent: number;
    coveredBy: string | null;
    clippedBy: string | null;
    points: { visible: number; covered: number; clipped: number; offscreen: number };
  } | null;
  scrollPane: { selector: string | null; scrollTop: number; scrollHeight: number; clientHeight: number } | null;
}

const VIEWPORT = { innerWidth: 1280, innerHeight: 800 };

/**
 * Hit-testing the way a browser does it, reduced to what the oracle relies on:
 * the top-most element whose box contains the point, where "top-most" is the
 * highest z-index and then the latest in document order; elements with
 * `pointer-events: none` are transparent to the test; and a descendant of an
 * `overflow: hidden` box is only hittable inside that box. Outside the viewport
 * there is nothing to hit.
 */
function elementFromPoint(all: FakeEl[], x: number, y: number): FakeEl | null {
  if (x < 0 || y < 0 || x >= VIEWPORT.innerWidth || y >= VIEWPORT.innerHeight) return null;
  let best: FakeEl | null = null;
  for (const el of all) {
    if (el.pointerEvents === "none" || !el.containsPoint(x, y)) continue;
    let clipped = false;
    for (let a = el.parentElement; a; a = a.parentElement) {
      if (a.clips && !a.containsPoint(x, y)) {
        clipped = true;
        break;
      }
    }
    if (clipped) continue;
    if (!best || el.zIndex >= best.zIndex) best = el;
  }
  return best;
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
    documentElement: root,
    querySelector: (s: string) => all.find((el) => matchesSelector(el, s)) ?? null,
    querySelectorAll: (s: string) => (s === "*" ? all : all.filter((el) => matchesSelector(el, s))),
    getElementById: (id: string) => all.find((el) => el.id === id) ?? null,
    elementFromPoint: (x: number, y: number) => elementFromPoint(all, x, y),
  };
  const CSS = { escape: (s: string) => s };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("document", "CSS", "window", `return ${pageExpression(expect)};`);
  return fn(document, CSS, VIEWPORT) as PageShape;
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

// ---------------------------------------------------------------------------
// The visibility oracle (plan 06). Focus and visibility are two different
// facts; every fixture below has the ring correctly on the control, and only
// the second fact varies.
// ---------------------------------------------------------------------------

/** A 400x800 QAM pane with a control at `rect` and whatever else sits on top. */
function paneWith(control: ElSpec, ...others: ElSpec[]): ElSpec {
  return {
    tag: "div",
    id: "quickaccess_content_999",
    rect: { x: 0, y: 0, width: 400, height: 800 },
    children: [
      { tag: "span", text: "bonsAI" },
      { tag: "button", className: "Focusable gpfocus", text: "Show details", ...control },
      ...others,
    ],
  };
}

/** The bonsAI dock: 246px pinned to the pane's foot, chips inside, interactive. */
function dock(top: number): ElSpec {
  return {
    tag: "div",
    className: "bonsai-main-tab-dock",
    rect: { x: 0, y: top, width: 400, height: 800 - top },
    children: [
      {
        tag: "button",
        className: "Focusable _2BB6ufjFaAmdnwLOqMU7 bonsai-chip",
        rect: { x: 0, y: top, width: 400, height: 800 - top },
        text: "Summarise",
      },
    ],
  };
}

test("visibility: a control with nothing on top of it is visible at every point", () => {
  const page = runPageExpression(paneWith({ rect: { x: 20, y: 100, width: 300, height: 40 } }));
  assert.equal(page.visibility?.verdict, "visible");
  assert.equal(page.visibility?.visiblePercent, 100);
  assert.equal(page.visibility?.coveredBy, null);
  assert.equal(page.visibility?.clippedBy, null);
  assert.deepEqual(page.visibility?.points, { visible: 9, covered: 0, clipped: 0, offscreen: 0 });
});

test("visibility: rounded corners are not clipping -- the measured bonsAI button reads as visible", () => {
  /*
   * Measured on the Deck 2026-08-31, first live read of the oracle: bonsAI's
   * "Show details" is 98x32 with border-radius 8px, and with a 2px inset two
   * corner samples fell outside the arc, hit the parent row, and a perfectly
   * visible control came back "partial, 78%, clipped by its own row". A
   * quarter-of-the-short-side inset keeps every sample inside any radius up
   * to a full pill.
   */
  const button = { rect: { x: 52, y: 458, width: 98, height: 32 }, radius: 8 };
  const page = runPageExpression(paneWith(button));
  assert.equal(page.visibility?.verdict, "visible");
  assert.equal(page.visibility?.clippedBy, null);
  assert.deepEqual(page.visibility?.points, { visible: 9, covered: 0, clipped: 0, offscreen: 0 });

  // A full pill, the tightest case.
  const pill = runPageExpression(paneWith({ rect: { x: 52, y: 458, width: 98, height: 32 }, radius: 16 }));
  assert.equal(pill.visibility?.verdict, "visible");
});

test("visibility: the 2026-08-31 shape -- focused behind the dock is COVERED, and the dock is named", () => {
  /*
   * Steam scrolled "Show details" into the pane; the pane is what Steam owns.
   * The dock is pinned over the pane's last 246px and Steam knows nothing about
   * it, so the control lands focused and entirely behind the chips. Every focus
   * tool called this success. The coverer must be named in the consumer's own
   * vocabulary -- the hyphenated class buildSelector would have thrown away.
   */
  const page = runPageExpression(
    paneWith({ rect: { x: 20, y: 600, width: 300, height: 40 } }, dock(554)),
  );
  assert.equal(page.visibility?.verdict, "covered");
  assert.equal(page.visibility?.visiblePercent, 0);
  assert.equal(
    page.visibility?.coveredBy,
    "div.bonsai-main-tab-dock > button.Focusable.bonsai-chip",
    "the path to the coverer must carry the dock's own class name, and drop Steam's hash",
  );
  assert.deepEqual(page.visibility?.points, { visible: 0, covered: 9, clipped: 0, offscreen: 0 });
  // Focus itself was read correctly the whole time. That is the point.
  assert.equal(page.gpfocus?.label, "Show details");
});

test("visibility: a control half under the dock is PARTIAL, with the coverer still named", () => {
  // Rows sampled at y=532, 550, 568 against a dock starting at 554: two rows
  // clear, one row under it.
  const page = runPageExpression(
    paneWith({ rect: { x: 20, y: 530, width: 300, height: 40 } }, dock(554)),
  );
  assert.equal(page.visibility?.verdict, "partial");
  assert.equal(page.visibility?.visiblePercent, 67);
  assert.equal(page.visibility?.coveredBy, "div.bonsai-main-tab-dock > button.Focusable.bonsai-chip");
  assert.deepEqual(page.visibility?.points, { visible: 6, covered: 3, clipped: 0, offscreen: 0 });
});

test("visibility: a control below the viewport is OFFSCREEN with no coverer", () => {
  const page = runPageExpression(paneWith({ rect: { x: 20, y: 820, width: 300, height: 40 } }));
  assert.equal(page.visibility?.verdict, "offscreen");
  assert.equal(page.visibility?.visiblePercent, 0);
  assert.equal(page.visibility?.coveredBy, null);
  assert.deepEqual(page.visibility?.points, { visible: 0, covered: 0, clipped: 0, offscreen: 9 });
});

test("visibility: a collapsed box is OFFSCREEN -- there is nothing to see", () => {
  const page = runPageExpression(paneWith({ rect: { x: 20, y: 100, width: 300, height: 0 } }));
  assert.equal(page.visibility?.verdict, "offscreen");
  assert.equal(page.visibility?.points.offscreen, 9);
});

test("visibility: the 2026-08-30 shape -- clipped by an overflow:hidden ancestor reads as OFFSCREEN, naming the clipper", () => {
  /*
   * The pane's last 50px were cut off by an ancestor with overflow: hidden.
   * Every element was present, focusable and asserted, and unreachable by eye.
   * Nothing is ON TOP of the control here -- the hit lands on an ancestor --
   * so it is not "covered"; it is not painted, which is the offscreen family.
   */
  const page = runPageExpression({
    tag: "div",
    id: "quickaccess_content_999",
    rect: { x: 0, y: 0, width: 400, height: 800 },
    children: [
      {
        tag: "div",
        className: "bonsai-scroll-region",
        clips: true,
        rect: { x: 0, y: 0, width: 400, height: 700 },
        children: [
          { tag: "button", className: "Focusable gpfocus", text: "Copy", rect: { x: 20, y: 710, width: 300, height: 40 } },
        ],
      },
    ],
  });
  assert.equal(page.visibility?.verdict, "offscreen");
  assert.equal(page.visibility?.coveredBy, null, "nothing is on top of it");
  assert.equal(page.visibility?.clippedBy, "div#quickaccess_content_999");
  assert.deepEqual(page.visibility?.points, { visible: 0, covered: 0, clipped: 9, offscreen: 0 });
});

test("visibility: a decorative scrim with pointer-events:none is NOT a coverer", () => {
  /*
   * elementFromPoint skips pointer-events:none, and the oracle must not bring
   * such an element back through any geometric second opinion: a fade over
   * the dock is decoration, and calling it a coverer would flag every control
   * under a gradient. The contrast case right after pins that the same box
   * WITH pointer events is a coverer -- so the skip is the browser's rule
   * being honoured, not the oracle failing to look.
   */
  const scrim = (pe?: "none"): ElSpec => ({
    tag: "div",
    className: "bonsai-dock-fade",
    pointerEvents: pe,
    rect: { x: 0, y: 500, width: 400, height: 300 },
  });
  const under = { rect: { x: 20, y: 600, width: 300, height: 40 } };

  const decorative = runPageExpression(paneWith(under, scrim("none")));
  assert.equal(decorative.visibility?.verdict, "visible");
  assert.equal(decorative.visibility?.coveredBy, null);

  const interactive = runPageExpression(paneWith(under, scrim()));
  assert.equal(interactive.visibility?.verdict, "covered");
  assert.equal(interactive.visibility?.coveredBy, "div.bonsai-dock-fade");
});

test("visibility: coveredBy is the most frequent coverer when several overlap", () => {
  // A small badge covers one corner; the dock covers the rest. The dock is the
  // answer -- the badge is real, but naming it would send a reader to the
  // wrong element.
  const page = runPageExpression(
    paneWith(
      { rect: { x: 20, y: 600, width: 300, height: 40 } },
      dock(554),
      { tag: "span", className: "bonsai-badge", zIndex: 5, rect: { x: 300, y: 600, width: 30, height: 30 } },
    ),
  );
  assert.equal(page.visibility?.verdict, "covered");
  assert.equal(page.visibility?.coveredBy, "div.bonsai-main-tab-dock > button.Focusable.bonsai-chip");
});

test("visibility: nothing focused means nothing measured, not 'visible'", () => {
  const page = runPageExpression({ tag: "div", children: [{ tag: "span", text: "idle" }] });
  assert.equal(page.hasGpfocus, false);
  assert.equal(page.visibility, null);
  assert.equal(page.scrollPane, null);
});

test("scrollPane: the nearest scrolling ancestor and its offset are reported", () => {
  const page = runPageExpression({
    tag: "div",
    id: "quickaccess_content_999",
    rect: { x: 0, y: 0, width: 400, height: 800 },
    children: [
      {
        tag: "div",
        className: "Panel",
        scroll: { scrollTop: 312, scrollHeight: 2000, clientHeight: 700 },
        rect: { x: 0, y: 0, width: 400, height: 700 },
        children: [
          { tag: "div", children: [{ tag: "button", className: "Focusable gpfocus", text: "Copy", rect: { x: 20, y: 100, width: 300, height: 40 } }] },
        ],
      },
    ],
  });
  assert.equal(page.scrollPane?.scrollTop, 312);
  assert.equal(page.scrollPane?.scrollHeight, 2000);
  assert.equal(page.scrollPane?.clientHeight, 700);
  assert.match(page.scrollPane?.selector ?? "", /Panel/);
});
