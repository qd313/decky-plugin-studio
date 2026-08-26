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
  rect: { x: number; y: number; w: number; h: number } | null;
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
  /** Ancestor chain carrying gpfocuswithin, innermost first. */
  gpfocusWithin: FocusElement[];
  activeElement: FocusElement | null;
  /** false means Steam and the browser disagree -- the false-positive detector. */
  agree: boolean;
  /** Focus is inside a Decky plugin's pane rather than Steam's own chrome. */
  deckyPluginRoot: boolean;
  /** e.g. "999" for Decky; Steam's own tabs are 0 and 3-7. */
  quickAccessTab: string | null;
  targetsScanned: string[];
}

/**
 * Runs inside the page. Kept as one self-contained expression so it can be sent
 * over Runtime.evaluate with no page-side setup.
 *
 * Selector strategy: Steam's class names are a mix of stable semantic ones
 * (DialogButton, Focusable, Panel) and per-build hashes (cXzBZxhPBl7fZs9LODEnc,
 * _2BB6uf--jFaAmdnwLOqMU7). Only letter-only classes are kept, the path is
 * anchored to the nearest ancestor with a real id, and the result is then
 * re-queried to confirm it resolves back to the same element. A selector that
 * does not verify is returned with selectorVerified:false rather than silently
 * handed over as if it were good.
 */
const PAGE_EXPRESSION = `(() => {
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
    return {
      selector: sel,
      selectorVerified: verified,
      tag: el.tagName,
      id: hasRealId(el) ? el.id : null,
      classes: (el.className || '').toString().split(/\\s+/).filter(Boolean),
      ariaLabel: el.getAttribute ? el.getAttribute('aria-label') : null,
      text: (el.textContent || '').trim().slice(0, 120),
      rect: r
    };
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

  return {
    hasGpfocus: !!gp,
    elementCount: document.querySelectorAll('*').length,
    gpfocus: describe(gp),
    gpfocusWithin: within,
    activeElement: describe(active),
    agree: !!gp && gp === active,
    quickAccessTab: tab,
    deckyPluginRoot: tab === '999'
  };
})()`;

interface PageResult {
  hasGpfocus: boolean;
  elementCount: number;
  gpfocus: FocusElement | null;
  gpfocusWithin: FocusElement[];
  activeElement: FocusElement | null;
  agree: boolean;
  quickAccessTab: string | null;
  deckyPluginRoot: boolean;
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
    gpfocusWithin: [],
    activeElement: null,
    agree: false,
    deckyPluginRoot: false,
    quickAccessTab: null,
    targetsScanned: [],
  };
}

/**
 * Read focus from a CDP endpoint that is already reachable.
 *
 * Exported so a caller holding its own tunnel -- or a test holding a fake CDP
 * server -- can use it without any SSH involved.
 */
export async function readFocusAt(base: string, timeoutMs = 10_000): Promise<ReadFocusResult> {
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
        PAGE_EXPRESSION,
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
      gpfocusWithin: page.gpfocusWithin,
      activeElement: page.activeElement,
      agree: page.agree,
      deckyPluginRoot: page.deckyPluginRoot,
      quickAccessTab: page.quickAccessTab,
      targetsScanned: scanned,
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
