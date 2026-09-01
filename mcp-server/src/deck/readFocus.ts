/**
 * deck.readFocus -- report what Steam's nav graph actually owns.
 *
 * `gpfocus` / `gpfocuswithin` are classes STEAM writes onto the element its
 * gamepad nav graph currently owns. Reading them is the only honest answer to
 * "what is focused on the Deck right now". `document.activeElement` is the
 * browser's idea of focus, and on Deck the two routinely disagree -- that
 * disagreement is what cost bonsAI three shipped fixes that changed nothing.
 * So activeElement is reported here ONLY as a contrast field, and `agree`
 * is the machine-readable form of the trap.
 *
 * MEASURED CORRECTION to plan 01 § A.1, 2026-08-26. The plan says to read from
 * the `SharedJSContext` target and gives `method: "cdp:SharedJSContext"`. That
 * is wrong. Measured against a live Deck (Steam CEF 126.0.6478.183):
 *
 *     QuickAccess_uid2       289 elements, gpfocus PRESENT
 *     SharedJSContext         15 elements, no gpfocus
 *     MainMenu_uid2           80 elements, no gpfocus
 *     Steam Big Picture Mode 346 elements, no gpfocus
 *
 * SharedJSContext is essentially empty. So this does not assume a target at
 * all: it asks every one of them and reports which answered. If none carries
 * the marker it returns ok:false with a specific reason, rather than a null
 * focus that reads as "nothing is focused".
 */
import { CdpTarget, evaluate, getVersion, listTargets, rewriteWsHost } from "./cdp.js";
import { withCdpTunnel } from "./cdpTunnel.js";

/**
 * Where a control's computed `label` came from. The `ancestor-*` sources are
 * borrowed text -- the label belongs to something the ring is INSIDE, not to
 * the ring's own element -- and a caller that must not act on a borrowed name
 * (openPlugin's list-row test, say) checks for that prefix.
 */
export type LabelSource =
  | "aria-label"
  | "aria-labelledby"
  | "descendant-aria-label"
  | "text"
  | "ancestor-aria-label"
  | "ancestor-text";

export interface FocusElement {
  /** Best-effort CSS path. Null when one could not be built. */
  selector: string | null;
  /** Whether that selector actually resolves back to this element. Never assume. */
  selectorVerified: boolean;
  tag: string;
  id: string | null;
  classes: string[];
  ariaLabel: string | null;
  text: string;
  /**
   * Text of the nearest ancestor that has any, when the element itself has none.
   *
   * Decky's ToggleField, SliderField and friends put the gamepad ring on an
   * unlabelled inner div and keep the label several levels up. Measured on a
   * live Deck 2026-08-26: the ring inside the "On-screen debug HUD" toggle is
   * four parents below the element carrying that text. Without this, every
   * settings toggle reads as an anonymous <DIV> and any text assertion against
   * one is a false negative.
   *
   * Capped at LABEL_MAX characters since 2026-08-28: an ancestor whose text runs
   * to hundreds of characters is a whole pane, not a label, and reporting it as
   * one is what made substring matching a false success. See `label`.
   */
  ownerText: string;
  /**
   * THE control's name, computed the way an accessibility tree computes one.
   * This is what every matcher should use -- walkTo, runSequence, openPlugin.
   *
   * Priority, first non-empty wins: the element's own `aria-label`, its
   * `aria-labelledby` targets, an `aria-label` on a descendant, its own text,
   * then an ancestor's `aria-label` or text. `labelSource` says which fired.
   *
   * WHY THIS EXISTS (P1-10, 2026-08-28). The old scheme reported three raw
   * fields and let each caller rank them, and every caller ranked them
   * differently and at least one ranked them wrongly. Two failures came out of
   * it on the rig, both false rather than merely missing:
   *
   *   A button whose only name is its own `aria-label` ("Move gemma4:e2b-it-qat
   *   up") could not be walked to by that name, because full-subtree text
   *   ("Up") was consulted first.
   *
   *   An icon-only tab, having no text of its own, borrowed the first ancestor
   *   with any -- the entire Quick Access Menu. `walkTo({text: "bonsAI"})` then
   *   substring-matched that dump and reported `found` after ZERO presses, with
   *   the ring nowhere near bonsAI. A false success is the worst shape this rig
   *   can produce: it does not stall, does not error, and every assertion built
   *   on it inherits the lie.
   *
   * Hence LABEL_MAX: text longer than a name plausibly is means the ring is on
   * a container, so the climb STOPS and the label comes back empty with
   * `labelOverflow: true`. Empty is honest; the pane dump is not.
   */
  label?: string;
  /** Which rule produced `label`. Null when nothing named the control. */
  labelSource?: LabelSource | null;
  /**
   * True when naming stopped because the only text available was too long to be
   * a label -- i.e. the walk overshot onto a container. Distinguishes "this
   * control has no name" from "this thing is not a control".
   */
  labelOverflow?: boolean;
  rect: { x: number; y: number; w: number; h: number } | null;
}

export type VisibilityVerdict = "visible" | "partial" | "covered" | "offscreen";

/**
 * Could a person SEE the focused control? (Plan 06, 2026-08-31.)
 *
 * Focus and visibility are two different facts, and until this existed the rig
 * measured only the first. On bonsAI a control focused BEHIND its bottom-pinned
 * dock passed `deck_walkTo` (found: true), `deck_runSequence` (every step
 * matched) and `deck_readFocus` (correct selector, label and rect) -- and a
 * human found it in thirty seconds. Second incident of that class in two days;
 * the 2026-08-30 one was the pane's last 50px clipped by an `overflow: hidden`
 * ancestor. Both are DOM-measurable in the eval the tools already run.
 *
 * Mechanism: a 3x3 grid of points across the element's rect, inset 2px, each
 * put through `document.elementFromPoint`. The element itself or a descendant
 * is a visible point; any other element on top is a covered point (the hit is
 * recorded); an ancestor is a clipped point (nothing is on top -- the element
 * simply is not painted there, which is what an overflow clip looks like); a
 * point off the viewport is offscreen. `elementFromPoint` sees stacking exactly
 * as the compositor resolves it and skips `pointer-events: none`, so a
 * decorative scrim does not register as a coverer while an interactive dock
 * does -- no plugin's dock is special-cased here.
 *
 * Honest limit: this is a DOM hit-test, not eyes. It cannot see a control in
 * the wrong colour or a compositing artifact; those still need a screenshot or
 * a human. The claim is exactly that focused-but-occluded and
 * focused-but-offscreen can never again pass silently.
 */
export interface Visibility {
  verdict: VisibilityVerdict;
  /** Sampled: visible points out of nine, as a percentage. */
  visiblePercent: number;
  /** The most frequent element found ON TOP of a sampled point, when any was. */
  coveredBy: string | null;
  /** The most frequent ANCESTOR hit instead of the element -- an overflow clip. */
  clippedBy: string | null;
  points: { visible: number; covered: number; clipped: number; offscreen: number };
}

/**
 * The nearest scrolling ancestor of the focused element -- the pane Steam
 * scrolls a control "into view" of. Reported so a sweep can record where the
 * pane was at every stop, and so a reader can tell "scrolled out of the pane"
 * from "the pane itself is off screen".
 */
export interface ScrollPane {
  selector: string | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface ReadFocusResult {
  ok: boolean;
  reason?: string;
  /** Only ever "steam-owned" -- there is no weaker tier, by design. */
  fidelity: "steam-owned" | null;
  method: string;
  target: { title: string; url: string } | null;
  steamBuild: string | null;
  gpfocus: FocusElement | null;
  /**
   * Whether a person could see `gpfocus`. Null when nothing owns the ring, or
   * the payload predates the field. Always informational here; walkTo shouts
   * it in its summary, runSequence counts it and can fail on it.
   */
  visibility: Visibility | null;
  /** The pane `gpfocus` scrolls inside, with its current scroll offset. */
  scrollPane: ScrollPane | null;
  /** Ancestor chain carrying gpfocuswithin, innermost first. */
  gpfocusWithin: FocusElement[];
  activeElement: FocusElement | null;
  /** false means Steam and the browser disagree -- the false-positive detector. */
  agree: boolean;
  /** Focus is inside a Decky plugin's pane rather than Steam's own chrome. */
  deckyPluginRoot: boolean;
  /**
   * Discrete short text labels inside that pane, innermost pane only. Decky
   * puts the open plugin's name here as a label of its own; nothing else on the
   * page identifies WHICH plugin is open.
   */
  deckyPanelLabels: string[];
  /** e.g. "999" for Decky; Steam's own tabs are 0 and 3-7. */
  quickAccessTab: string | null;
  /**
   * Which Quick Access pane is actually on screen, which is NOT the same
   * question as `quickAccessTab`.
   *
   * `quickAccessTab` says which pane contains the ring, and it is null whenever
   * the ring sits on the QAM's own tab rail -- which is exactly where it lands
   * when the menu first opens. Measured 2026-08-26: openPlugin read a null tab,
   * concluded the QAM was shut, and fired the open chord at an already-open
   * menu, which closed it again.
   */
  visibleQuickAccessTab: string | null;
  targetsScanned: string[];
  /** Did the focused element match the caller's `expect` selector? null = not asked, or the selector was invalid. */
  matchesExpect?: boolean | null;
}

/**
 * Runs inside the page. Kept as one self-contained expression so it can be sent
 * over Runtime.evaluate with no page-side setup.
 *
 * EXPORTED FOR TESTS. Everything in here used to be unreachable from the suite
 * -- it is a string, so nothing type-checks it and nothing runs it without a
 * Deck. That is not an academic gap: P1-10 (an icon-only control reported under
 * the text of the entire Quick Access Menu) lived in this string for weeks, and
 * the unit tests could not have caught it because they build FocusElement
 * objects host-side and never execute this. readFocus.test.ts now evaluates it
 * against a small fake DOM.
 *

 * Selector strategy: Steam's class names are a mix of stable semantic ones
 * (DialogButton, Focusable, Panel) and per-build hashes (cXzBZxhPBl7fZs9LODEnc,
 * _2BB6uf--jFaAmdnwLOqMU7). Only letter-only classes are kept, the path is
 * anchored to the nearest ancestor with a real id, and the result is then
 * re-queried to confirm it resolves back to the same element. A selector that
 * does not verify is returned with selectorVerified:false rather than silently
 * handed over as if it were good.
 */
export function pageExpression(expect?: string): string {
  const EXPECT = expect ? JSON.stringify(expect) : "null";
  return `(() => {
  var EXPECT = ${EXPECT};
  var STABLE_CLASS = /^_?[A-Za-z]+$/;
  var REACT_ID = /^\\u00ab/;

  function stableClasses(el) {
    var raw = (el.className || '').toString().split(/\\s+/);
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var c = raw[i];
      if (!c) continue;
      if (c.indexOf('gpfocus') === 0) continue;
      if (STABLE_CLASS.test(c)) out.push(c);
    }
    return out;
  }

  function hasRealId(el) {
    return !!(el.id && !REACT_ID.test(el.id));
  }

  function buildSelector(el) {
    var parts = [];
    var n = el;
    var guard = 0;
    while (n && n.nodeType === 1 && guard++ < 12) {
      if (hasRealId(n)) { parts.unshift('#' + CSS.escape(n.id)); break; }
      var seg = n.tagName.toLowerCase();
      var cls = stableClasses(n);
      for (var i = 0; i < cls.length && i < 3; i++) seg += '.' + CSS.escape(cls[i]);
      if (n.parentElement) {
        var sibs = Array.prototype.slice.call(n.parentElement.children);
        var idx = sibs.indexOf(n);
        if (idx >= 0) seg += ':nth-child(' + (idx + 1) + ')';
      }
      parts.unshift(seg);
      n = n.parentElement;
    }
    return parts.length ? parts.join(' > ') : null;
  }

  /*
   * Longest string still plausibly a control's NAME.
   *
   * Above this we are looking at a container's contents, not a label. Measured
   * on the rig 2026-08-28: bonsAI's icon-only QAM tabs have no text of their
   * own, and the first ancestor that has any is the whole Quick Access Menu --
   * "NotificationsQuick SettingsPerformanceSoundtracksHelpDeckybonsAITabMaster..."
   * Returning that as the focused control's name made walkTo substring-match
   * "bonsAI" against it and report success without pressing anything.
   *
   * 80 is chosen against real labels rather than theory: the longest genuine
   * ones seen on the rig are Decky setting rows in the fifties ("Hybrid
   * retrieval (meaning search)", "Move gemma4:e2b-it-qat up"), and the shortest
   * false positive was several hundred. Nothing sits near the boundary.
   */
  var LABEL_MAX = 80;

  function attr(el, name) {
    try { return (el && el.getAttribute) ? el.getAttribute(name) : null; } catch (e) { return null; }
  }

  function textOf(el) {
    return ((el && el.textContent) || '').trim();
  }

  function labelledByText(el) {
    var ids = (attr(el, 'aria-labelledby') || '').trim();
    if (!ids) return '';
    var parts = ids.split(/\\s+/), out = [];
    for (var i = 0; i < parts.length; i++) {
      var ref = null;
      try { ref = document.getElementById(parts[i]); } catch (e) { ref = null; }
      var t = textOf(ref);
      if (t) out.push(t);
    }
    return out.join(' ').trim();
  }

  function named(label, source) {
    return { label: label.slice(0, 120), labelSource: source, labelOverflow: false };
  }

  /*
   * A control's accessible name, in the order an accessibility tree resolves one.
   *
   * The ancestor climb at the bottom is the Decky ToggleField case and it stays
   * -- the ring genuinely lands on an unlabelled inner div with the label four
   * parents up. What changed on 2026-08-28 is that it no longer WINS: anything
   * naming the element itself is preferred, and an ancestor whose text is too
   * long to be a label ends the climb empty-handed instead of handing back a
   * whole pane. See FocusElement.label.
   */
  function accessibleNameOf(el) {
    var none = { label: '', labelSource: null, labelOverflow: false };
    if (!el) return none;

    var own = (attr(el, 'aria-label') || '').trim();
    if (own) return named(own, 'aria-label');

    var by = labelledByText(el);
    if (by) return named(by, 'aria-labelledby');

    /*
     * A descendant's aria-label. Steam puts the ring on an outer Focusable
     * wrapper, so a consumer who labels the control labels a node INSIDE it --
     * bonsAI added aria-label="Ask bonsAI" to each tab's title node and the rig
     * still read past it, because only the focus target itself was consulted.
     */
    var inner = null;
    try { inner = el.querySelector ? el.querySelector('[aria-label]') : null; } catch (e) { inner = null; }
    var innerLabel = inner ? (attr(inner, 'aria-label') || '').trim() : '';
    if (innerLabel) return named(innerLabel, 'descendant-aria-label');

    var text = textOf(el);
    if (text) {
      if (text.length <= LABEL_MAX) return named(text, 'text');
      // The ring is on a container. Every ancestor's text is a superset of this
      // one, so climbing can only make it worse -- stop and say so.
      return { label: '', labelSource: null, labelOverflow: true };
    }

    var n = el.parentElement, guard = 0;
    while (n && guard++ < 6) {
      var na = (attr(n, 'aria-label') || '').trim();
      if (na) return named(na, 'ancestor-aria-label');
      var nt = textOf(n);
      if (nt) {
        if (nt.length <= LABEL_MAX) return named(nt, 'ancestor-text');
        return { label: '', labelSource: null, labelOverflow: true };
      }
      n = n.parentElement;
    }
    return none;
  }

  /*
   * Ancestor text only -- the element's own text is reported as the text field.
   *
   * This used to short-circuit to the element's own textContent, which made
   * ownerText a duplicate of text for every element that had any and meant the
   * field never described what its name says it describes. Kept as a reported
   * field for post-mortems; matching goes through the label field instead.
   *
   * (No backticks anywhere in this function: it lives inside a template
   * literal, and one would end the string mid-expression.)
   */
  function ownerTextOf(el) {
    var n = el.parentElement, guard = 0;
    while (n && guard++ < 6) {
      var t = textOf(n);
      if (t) return t.length <= LABEL_MAX ? t : '';
      n = n.parentElement;
    }
    return '';
  }

  function describe(el) {
    if (!el) return null;
    var sel = null, verified = false;
    try {
      sel = buildSelector(el);
      if (sel) verified = document.querySelector(sel) === el;
    } catch (e) { sel = null; verified = false; }
    var r = null;
    try {
      var b = el.getBoundingClientRect();
      r = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    } catch (e) { r = null; }
    var name = accessibleNameOf(el);
    return {
      selector: sel,
      selectorVerified: verified,
      tag: el.tagName,
      id: hasRealId(el) ? el.id : null,
      classes: (el.className || '').toString().split(/\\s+/).filter(Boolean),
      ariaLabel: attr(el, 'aria-label'),
      text: (el.textContent || '').trim().slice(0, 120),
      ownerText: ownerTextOf(el),
      label: name.label,
      labelSource: name.labelSource,
      labelOverflow: name.labelOverflow,
      rect: r
    };
  }

  /*
   * Class names a human would recognise. buildSelector's STABLE_CLASS keeps only
   * letter-only names, which is right for a selector meant to re-resolve -- but
   * a consumer's own classes are hyphenated (bonsai-main-tab-dock), and a
   * coverer described without them is "div:nth-child(3)", which tells nobody
   * what is in the way. Steam's per-build hashes carry digits or a leading
   * underscore, so letters-and-hyphens is the line between the two.
   */
  var READABLE_CLASS = /^[A-Za-z]+(-[A-Za-z0-9]+)*$/;

  function readableSegment(el) {
    if (!el || el.nodeType !== 1) return null;
    var seg = el.tagName.toLowerCase();
    if (hasRealId(el)) return seg + '#' + el.id;
    var raw = (el.className || '').toString().split(/\\s+/);
    var n = 0;
    for (var i = 0; i < raw.length && n < 3; i++) {
      var c = raw[i];
      if (!c || c.indexOf('gpfocus') === 0 || !READABLE_CLASS.test(c)) continue;
      seg += '.' + c;
      n++;
    }
    return n > 0 ? seg : null;
  }

  /*
   * Name the thing found on top of a focused control: a short path of
   * recognisable segments from the hit up towards -- but not including -- the
   * first ancestor it shares with the focused element. For a chip inside a
   * bottom-pinned dock that reads "div.bonsai-main-tab-dock > button.Focusable
   * .bonsai-chip", which is what a person needs to go and look at. Nameless
   * wrappers are skipped; at least the hit's own tag always comes back.
   */
  function describeCoverer(hit, el) {
    var segs = [];
    var n = hit, guard = 0;
    while (n && n.nodeType === 1 && guard++ < 10 && segs.length < 4) {
      if (n !== hit && n.contains && n.contains(el)) break;
      var seg = readableSegment(n);
      if (seg) segs.unshift(seg);
      n = n.parentElement;
    }
    if (!segs.length) segs.push(hit.tagName ? hit.tagName.toLowerCase() : '?');
    return segs.join(' > ');
  }

  function mostFrequent(tally) {
    var best = null, bestN = 0;
    for (var k in tally) {
      if (tally[k] > bestN) { best = k; bestN = tally[k]; }
    }
    return best;
  }

  function viewport() {
    var w = 0, h = 0;
    try {
      if (typeof window !== 'undefined' && window.innerWidth > 0) { w = window.innerWidth; h = window.innerHeight; }
      else if (document.documentElement) { w = document.documentElement.clientWidth; h = document.documentElement.clientHeight; }
    } catch (e) { w = 0; h = 0; }
    return { w: w, h: h };
  }

  /*
   * Could a person SEE this element? See the Visibility type for the why.
   *
   * A 3x3 grid across the rect, inset from the edges. MEASURED CORRECTION to
   * plan 06's "inset ~2px", 2026-08-31: bonsAI's 98x32 "Show details" button
   * has border-radius 8px, and at 2px its corner samples fell outside the
   * rounded corner and hit the parent row -- a visible control read as 78%
   * "partial, clipped by its own row". The inset is now a quarter of the
   * shorter side (2px floor, 12px cap): a point that far in from both edges
   * is inside any radius up to a full pill, and the grid still spans the box.
   * Each point is put through document.elementFromPoint:
   * the element or a descendant is visible; any other element is a coverer;
   * an ANCESTOR means the element is not painted there -- an overflow clip, or
   * the element is transparent to hit-testing -- and counts as clipped, which
   * is reported under offscreen because nothing is on top of it. A point off
   * the viewport is offscreen. Verdict: all nine visible -> visible; none
   * visible -> covered if anything was found on top, else offscreen; otherwise
   * partial.
   *
   * No fallback to rect overlap anywhere in here, on purpose: elementFromPoint
   * skipping pointer-events:none is what keeps a decorative scrim from counting
   * as a coverer, and any geometric second opinion would bring the scrim back.
   */
  var INSET_MIN = 2, INSET_MAX = 12, INSET_RATIO = 0.25;

  function visibilityOf(el) {
    if (!el) return null;
    var out = {
      verdict: 'offscreen',
      visiblePercent: 0,
      coveredBy: null,
      clippedBy: null,
      points: { visible: 0, covered: 0, clipped: 0, offscreen: 0 }
    };
    var b = null;
    try { b = el.getBoundingClientRect(); } catch (e) { b = null; }
    if (!b || !(b.width > 0) || !(b.height > 0)) {
      // A collapsed box has nothing to sample; nine offscreen points is the
      // honest count for "there is no box to see".
      out.points.offscreen = 9;
      return out;
    }
    var vp = viewport();
    var x0 = b.left, x1 = b.left + b.width, y0 = b.top, y1 = b.top + b.height;
    var inset = Math.min(INSET_MAX, Math.max(INSET_MIN, Math.min(b.width, b.height) * INSET_RATIO));
    // A box thinner than twice the inset samples its centre line instead.
    var ix = b.width > 2 * inset ? inset : b.width / 2;
    var iy = b.height > 2 * inset ? inset : b.height / 2;
    var xs = [x0 + ix, (x0 + x1) / 2, x1 - ix];
    var ys = [y0 + iy, (y0 + y1) / 2, y1 - iy];
    var coverers = {}, clippers = {};
    for (var yi = 0; yi < 3; yi++) {
      for (var xi = 0; xi < 3; xi++) {
        var x = xs[xi], y = ys[yi];
        if (x < 0 || y < 0 || x >= vp.w || y >= vp.h) { out.points.offscreen++; continue; }
        var hit = null;
        try { hit = document.elementFromPoint(x, y); } catch (e) { hit = null; }
        if (!hit) { out.points.offscreen++; continue; }
        if (hit === el || (el.contains && el.contains(hit))) { out.points.visible++; continue; }
        var name = describeCoverer(hit, el);
        if (hit.contains && hit.contains(el)) {
          out.points.clipped++;
          clippers[name] = (clippers[name] || 0) + 1;
        } else {
          out.points.covered++;
          coverers[name] = (coverers[name] || 0) + 1;
        }
      }
    }
    out.visiblePercent = Math.round((out.points.visible / 9) * 100);
    out.coveredBy = mostFrequent(coverers);
    out.clippedBy = mostFrequent(clippers);
    if (out.points.visible === 9) out.verdict = 'visible';
    else if (out.points.visible === 0) out.verdict = out.points.covered > 0 ? 'covered' : 'offscreen';
    else out.verdict = 'partial';
    return out;
  }

  /*
   * The nearest ancestor that scrolls: more content than box, and not
   * overflow:visible. overflow:hidden counts -- scrollTop still works on it,
   * and a pane that clips is exactly the 2026-08-30 shape.
   */
  function scrollPaneOf(el) {
    var n = el ? el.parentElement : null, guard = 0;
    while (n && guard++ < 24) {
      var sh = n.scrollHeight, ch = n.clientHeight;
      if (typeof sh === 'number' && typeof ch === 'number' && sh > ch + 1) {
        var ov = '';
        try { ov = getComputedStyle(n).overflowY || ''; } catch (e) { ov = ''; }
        if (ov !== 'visible') {
          var sel = null;
          try { sel = buildSelector(n); } catch (e) { sel = null; }
          return {
            selector: sel,
            scrollTop: Math.round(n.scrollTop || 0),
            scrollHeight: Math.round(sh),
            clientHeight: Math.round(ch)
          };
        }
      }
      n = n.parentElement;
    }
    return null;
  }

  var gp = document.querySelector('.gpfocus');
  var active = document.activeElement;
  var within = [];
  if (gp) {
    var n = gp.parentElement, guard = 0;
    while (n && guard++ < 16) {
      if (n.classList && n.classList.contains('gpfocuswithin')) within.push(describe(n));
      n = n.parentElement;
    }
  }

  // Decky's Quick Access tab is 999; Steam's own are 0 and 3-7.
  var tab = null;
  if (gp) {
    var pane = gp.closest('[id^="quickaccess_content_"]');
    if (pane) tab = pane.id.replace('quickaccess_content_', '');
  }

  /*
   * Discrete text labels inside the Decky pane the ring is in.
   *
   * Decky renders the open plugin's name as its own text node in the panel
   * header ("bonsAI"), inside the same subtree as the ring. That is the only
   * thing on the page that says WHICH plugin is open -- deckyPluginRoot is just
   * a test for tab 999, which is true for every plugin alike.
   *
   * Own text only (child text nodes, not descendants' text) and short strings
   * only, so this is a list of labels rather than a bag of prose. Callers match
   * a whole label exactly; a paragraph that merely mentions a plugin's name --
   * a suggestion chip reading "...how bonsai trees are pruned", say -- is not a
   * label and must not read as "that plugin's panel is open".
   */
  var deckyPanelLabels = [];
  if (gp) {
    var pane999 = gp.closest('[id^="quickaccess_content_"]');
    if (pane999) {
      var els = pane999.querySelectorAll('*');
      for (var li = 0; li < els.length && deckyPanelLabels.length < 60; li++) {
        var own = '';
        var kids = els[li].childNodes;
        for (var ki = 0; ki < kids.length; ki++) {
          if (kids[ki].nodeType === 3) own += kids[ki].textContent;
        }
        own = own.trim();
        if (own && own.length <= 40 && deckyPanelLabels.indexOf(own) === -1) {
          deckyPanelLabels.push(own);
        }
      }
    }
  }

  // A selector we cannot parse is "unknown", not "did not match".
  var matchesExpect = null;
  if (EXPECT && gp) {
    try { matchesExpect = gp.matches(EXPECT); } catch (e) { matchesExpect = null; }
  }

  // The pane with a real box is the one on screen. Steam keeps the others mounted.
  var visibleTab = null;
  var panes = document.querySelectorAll('[id^="quickaccess_content_"]');
  for (var pi = 0; pi < panes.length; pi++) {
    var pr = panes[pi].getBoundingClientRect();
    if (pr.width > 0 && pr.height > 0) { visibleTab = panes[pi].id.replace('quickaccess_content_', ''); break; }
  }

  return {
    hasGpfocus: !!gp,
    elementCount: document.querySelectorAll('*').length,
    gpfocus: describe(gp),
    visibility: visibilityOf(gp),
    scrollPane: scrollPaneOf(gp),
    gpfocusWithin: within,
    activeElement: describe(active),
    agree: !!gp && gp === active,
    quickAccessTab: tab,
    visibleQuickAccessTab: visibleTab,
    deckyPluginRoot: tab === '999',
    deckyPanelLabels: deckyPanelLabels,
    matchesExpect: matchesExpect
  };
})()`;
}

interface PageResult {
  hasGpfocus: boolean;
  elementCount: number;
  gpfocus: FocusElement | null;
  visibility?: Visibility | null;
  scrollPane?: ScrollPane | null;
  gpfocusWithin: FocusElement[];
  activeElement: FocusElement | null;
  agree: boolean;
  quickAccessTab: string | null;
  visibleQuickAccessTab: string | null;
  deckyPluginRoot: boolean;
  deckyPanelLabels: string[];
  matchesExpect: boolean | null;
}

export interface ReadFocusOptions {
  /** Where CDP is reachable. Default assumes a forward tunnel on 8080. */
  cdpUrl?: string;
  timeoutMs?: number;
}

const PREFLIGHT =
  "Could not reach Steam's CEF debugger. On the Deck, confirm " +
  "~/.steam/steam/.cef-enable-remote-debugging exists and Steam has been restarted " +
  "since it was created, then open a forward tunnel: " +
  "ssh -N -L 8080:127.0.0.1:8080 deck@<deck-ip>";

function emptyResult(method: string): ReadFocusResult {
  return {
    ok: false,
    fidelity: null,
    method,
    target: null,
    steamBuild: null,
    gpfocus: null,
    visibility: null,
    scrollPane: null,
    gpfocusWithin: [],
    activeElement: null,
    agree: false,
    deckyPluginRoot: false,
    deckyPanelLabels: [],
    quickAccessTab: null,
    visibleQuickAccessTab: null,
    targetsScanned: [],
  };
}

/**
 * Read focus from a CDP endpoint that is already reachable.
 *
 * Exported so a caller holding its own tunnel -- or a test holding a fake CDP
 * server -- can use it without any SSH involved.
 */
export async function readFocusAt(
  base: string,
  timeoutMs = 10_000,
  expect?: string,
): Promise<ReadFocusResult> {
  const empty = emptyResult(`cdp:${base}`);

  let targets: CdpTarget[];
  try {
    targets = await listTargets(base, timeoutMs);
  } catch (err) {
    return { ...empty, reason: `${PREFLIGHT} (${(err as Error).message})` };
  }

  let steamBuild: string | null = null;
  try {
    steamBuild = (await getVersion(base, timeoutMs)).browser ?? null;
  } catch {
    // Non-fatal: the build string is for post-mortems, not for correctness.
  }

  const pages = targets.filter((t) => t.webSocketDebuggerUrl);
  if (pages.length === 0) {
    return { ...empty, steamBuild, reason: `${PREFLIGHT} (no debuggable targets listed)` };
  }

  const scanned: string[] = [];
  const failures: string[] = [];

  // Ask every target rather than assuming which one owns focus. Plan 01 named
  // SharedJSContext; measurement says the QAM target carries the marker.
  for (const t of pages) {
    scanned.push(t.title);
    let page: PageResult;
    try {
      page = await evaluate<PageResult>(
        rewriteWsHost(t.webSocketDebuggerUrl!, base),
        pageExpression(expect),
        timeoutMs,
      );
    } catch (err) {
      failures.push(`${t.title}: ${(err as Error).message}`);
      continue;
    }
    if (!page?.hasGpfocus) continue;

    return {
      ok: true,
      fidelity: "steam-owned",
      method: `cdp:${t.title}`,
      target: { title: t.title, url: t.url },
      steamBuild,
      gpfocus: page.gpfocus,
      visibility: page.visibility ?? null,
      scrollPane: page.scrollPane ?? null,
      gpfocusWithin: page.gpfocusWithin,
      activeElement: page.activeElement,
      agree: page.agree,
      deckyPluginRoot: page.deckyPluginRoot,
      deckyPanelLabels: page.deckyPanelLabels ?? [],
      quickAccessTab: page.quickAccessTab,
      visibleQuickAccessTab: page.visibleQuickAccessTab ?? null,
      targetsScanned: scanned,
      matchesExpect: page.matchesExpect ?? null,
    };
  }

  // Nothing carried the marker. That is reported as a failure, never as "focus
  // is null" -- a renamed Steam class must not read as "nothing is focused".
  const detail = failures.length ? ` Errors: ${failures.join("; ")}` : "";
  return {
    ...empty,
    steamBuild,
    targetsScanned: scanned,
    reason:
      "gpfocus marker not found in any target - Steam client may have changed, " +
      `or nothing currently owns gamepad focus. Scanned: ${scanned.join(", ")}.${detail}`,
  };
}

/**
 * Read focus from the configured Deck.
 *
 * With no cdpUrl this opens its own SSH forward for the call and closes it
 * again, so the tool does not silently depend on a tunnel somebody else
 * remembered to start.
 */
export async function readFocus(opts: ReadFocusOptions = {}): Promise<ReadFocusResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  if (opts.cdpUrl) return readFocusAt(opts.cdpUrl, timeoutMs);

  try {
    return await withCdpTunnel((base) => readFocusAt(base, timeoutMs));
  } catch (err) {
    return { ...emptyResult("ssh-tunnel"), reason: (err as Error).message };
  }
}
