/**
 * deck.typeText -- put text into the plugin's own text field by CDP injection,
 * and say plainly that this is NOT what a person does.
 *
 * Nothing could type on the Deck. bonsAI pinned test questions into
 * settings.json over SSH with the panel closed, purely because a question could
 * not be entered from a tool, and every Ask test went through that workaround.
 * The real answer is a keyboard on the bridge board (ROADMAP: "Type text on the
 * Deck"). Until that exists this is the fallback the roadmap names: CDP
 * `Input.insertText`, which works today and proves much less.
 *
 * WHAT IT PROVES AND WHAT IT DOES NOT. Text arrives in the field as the page's
 * own editing pipeline sees it (a real `input` event, so React state follows),
 * which shows the field, its handlers and whatever reads them work. It does not
 * touch the controller, the bridge, Steam's on-screen keyboard, or the A press
 * that opens that keyboard. A field that takes injected text says nothing about
 * whether a person with a Deck in their hands could get text into it. So the
 * result's fidelity is `"injected"`, below even `"wire-sent"` (fidelity.ts), and
 * is never `"steam-routed"`.
 *
 * WHERE IT WILL AND WILL NOT WRITE.
 *
 *   ONLY THE ELEMENT THE RING IS ON. It reads focus first, and the target is
 *   `.gpfocus` -- Steam's own gamepad marker -- not `document.activeElement`,
 *   which on the Deck routinely names something else (readFocus.ts). That
 *   element must itself be an <input> (of a type that takes text), a <textarea>
 *   or a contenteditable host. A wrapper that merely contains an input is
 *   refused, and the refusal names the input inside it: filling "the field near
 *   the ring" is a guess, and a guess that lands on the wrong field is a
 *   passing test of the wrong thing.
 *
 *   ONLY THE PLUGIN'S OWN PANEL. Steam's own text fields (the Store search box,
 *   a login, a rename dialog) are not ours to fill by injection. The ring must
 *   be on the Quick Access page, inside the plugin's panel root when the
 *   workspace names one (panelRootSelector in .decky/preview.json), else inside
 *   Decky's plugin pane (quickaccess_content_999).
 *
 *   NEVER MOVES THE RING. DOM `focus()` is called on that element, and only
 *   because the ring already sits on it; focus() does not move the ring. When
 *   nothing owns the ring the tool refuses -- it presses nothing, so placing the
 *   ring is deck_walkTo's job.
 *
 * CLEARING. For <input> and <textarea> the value is set to "" through the
 * prototype's NATIVE setter and an `input` event is dispatched. Assigning
 * `el.value = ""` directly does not work on a React-controlled field: React
 * keeps its own copy of the last value it saw and compares the next event
 * against it, so a plain assignment updates the DOM and leaves React's state
 * (and the next onChange) on the old text. Going around the instance property
 * is the well-known way to make React notice. A contenteditable host is cleared
 * by selecting its contents and `execCommand("delete")`. Either way the value is
 * read back, and a clear that did not empty the field stops the tool BEFORE it
 * types, so text is never appended to something the caller asked to replace.
 * Which method ran is reported in `cleared.method`. Not measured on a Deck.
 *
 * SUBMIT. `submit: true` dispatches Enter through `Input.dispatchKeyEvent`
 * (keyDown then keyUp) on the same page and says so. It never presses A, and it
 * is not sent when the text did not read back as expected or when the field no
 * longer holds DOM focus, since Enter would go to the wrong place or send the
 * wrong text.
 *
 * Writes no run file. The result carries the evidence (before, after, expected).
 */
import { openCdpTunnel } from "./cdpTunnel.js";
import { listTargets, rewriteWsHost } from "./cdp.js";
import { MiniWebSocket } from "./ws.js";
import { readFocusAt, isQuickAccessTarget, type ReadFocusResult } from "./readFocus.js";
import { describe as describeFocus } from "./focusKey.js";
import { automationStopped, stoppedMessage } from "./killswitch.js";
import { currentMachineIfAny } from "../machines.js";
import { reportCallStage } from "../callDeadline.js";
import type { Fidelity } from "./fidelity.js";

// ---------------------------------------------------------------------------
// A CDP session: more than Runtime.evaluate, over one socket
// ---------------------------------------------------------------------------

/**
 * cdp.ts's `evaluate()` opens a socket per call and speaks one method. This
 * tool needs `Runtime.evaluate` and `Input.*` on the SAME page in order, and the
 * element it prepared must still be the one it reads back, so it keeps one
 * socket for the whole call. Kept here rather than in cdp.ts so the generic
 * client stays the two-call thing its header promises.
 */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export async function openCdpSession(wsUrl: string, timeoutMs = 10_000): Promise<CdpSession> {
  const ws = await MiniWebSocket.connect(wsUrl, { timeoutMs });
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string }
  >();

  ws.onClose((reason) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`connection closed before a reply to ${p.method}: ${reason}`));
      pending.delete(id);
    }
  });

  ws.onMessage((text) => {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      return; // not ours; CDP also emits events we did not subscribe to
    }
    if (typeof msg.id !== "number") return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`CDP error on ${p.method}: ${msg.error.message ?? "unknown"}`));
    else p.resolve(msg.result);
  });

  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (err) {
          pending.delete(id);
          clearTimeout(timer);
          reject(err as Error);
        }
      });
    },
    close() {
      ws.close();
    },
  };
}

/** Runtime.evaluate on a session, by value, with a thrown expression turned into a thrown Error. */
async function evalValue<T>(session: CdpSession, expression: string): Promise<T> {
  const r = (await session.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as {
    result?: { value?: T };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (r?.exceptionDetails) {
    const why = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "unknown";
    throw new Error(`expression threw in the page: ${why}`);
  }
  return r?.result?.value as T;
}

// ---------------------------------------------------------------------------
// What runs inside the page
// ---------------------------------------------------------------------------

/** What the page says about the element under the ring. */
export interface PageElement {
  tag: string;
  type: string | null;
  id: string | null;
  classes: string[];
  ariaLabel: string | null;
  placeholder: string | null;
  contentEditable: string | null;
}

export type EditableKind = "input" | "textarea" | "contenteditable";

export interface PrepareReply {
  ringOwned: boolean;
  eligible: boolean;
  /** Why not, in words, when `eligible` is false. */
  why: string | null;
  element: PageElement | null;
  /** When the ring is on something that is not editable: the editable things INSIDE it. */
  editableInside: { count: number; first: PageElement | null } | null;
  kind: EditableKind | null;
  inPanel: boolean;
  /** The value before anything was done, "" when there is no element. */
  valueBefore: string;
  cleared: { requested: boolean; method: string | null; ok: boolean };
}

export interface ReadBackReply {
  present: boolean;
  connected: boolean;
  value: string;
  /** Does the browser agree the element holds DOM focus? Enter goes to activeElement. */
  activeIsElement: boolean;
  /** Is the ring still on that element? Informational: nothing here presses. */
  ringStillOnElement: boolean;
}

/**
 * Inspect `.gpfocus`; if (and only if) it is an editable element inside the
 * plugin's panel, DOM-focus it, optionally clear it, put the caret at the end,
 * and remember it for the read-back.
 *
 * EXPORTED FOR TESTS, for the reason readFocus.pageExpression is: it is a
 * string, so nothing type-checks it and nothing runs it without a Deck. The test
 * file evaluates it against a small fake DOM. (No backticks in here -- it lives
 * inside a template literal -- and no backslashes, so nothing needs doubling.)
 */
export function prepareExpression(panelRootSelector: string | null, clear: boolean): string {
  return `(() => {
  var ROOT = ${JSON.stringify(panelRootSelector ?? null)};
  var CLEAR = ${clear ? "true" : "false"};
  var NON_TEXT = ['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color', 'hidden'];

  function attr(el, name) {
    try { return el && el.getAttribute ? el.getAttribute(name) : null; } catch (e) { return null; }
  }

  function describe(el) {
    if (!el) return null;
    var raw = (el.className && el.className.toString) ? el.className.toString().split(' ') : [];
    var classes = [];
    for (var i = 0; i < raw.length && classes.length < 4; i++) {
      if (raw[i] && raw[i].indexOf('gpfocus') !== 0) classes.push(raw[i]);
    }
    return {
      tag: (el.tagName || '').toLowerCase(),
      type: attr(el, 'type'),
      id: el.id || null,
      classes: classes,
      ariaLabel: attr(el, 'aria-label'),
      placeholder: attr(el, 'placeholder'),
      contentEditable: typeof el.contentEditable === 'string' ? el.contentEditable : null
    };
  }

  function valueOf(el, kind) {
    if (kind === 'contenteditable') return el.textContent || '';
    return el.value == null ? '' : String(el.value);
  }

  var out = {
    ringOwned: false, eligible: false, why: null, element: null, editableInside: null,
    kind: null, inPanel: false, valueBefore: '',
    cleared: { requested: CLEAR, method: null, ok: false }
  };

  var gp = document.querySelector('.gpfocus');
  if (!gp) { out.why = 'no element on this page carries gpfocus'; return out; }
  out.ringOwned = true;
  out.element = describe(gp);

  var tag = (gp.tagName || '').toLowerCase();
  var kind = null;
  if (tag === 'textarea') {
    kind = 'textarea';
  } else if (tag === 'input') {
    var t = (attr(gp, 'type') || 'text').toLowerCase();
    if (NON_TEXT.indexOf(t) === -1) kind = 'input';
  } else if (gp.contentEditable === 'true' || gp.contentEditable === 'plaintext-only') {
    kind = 'contenteditable';
  }
  out.kind = kind;

  var inPanel = false, panelWhy = '';
  if (ROOT) {
    var root = null, bad = false;
    try { root = document.querySelector(ROOT); } catch (e) { bad = true; }
    if (bad) panelWhy = 'the panel root selector "' + ROOT + '" is not a valid selector';
    else if (!root) panelWhy = 'the panel root "' + ROOT + '" is not in the document';
    else if (root.contains(gp)) inPanel = true;
    else panelWhy = 'the ring is outside the plugin panel root "' + ROOT + '"';
  } else {
    var pane = gp.closest ? gp.closest('[id^="quickaccess_content_"]') : null;
    if (pane && pane.id === 'quickaccess_content_999') inPanel = true;
    else if (pane) panelWhy = 'the ring is in Quick Access pane "' + pane.id + '", not the Decky plugin pane quickaccess_content_999';
    else panelWhy = 'the ring is not inside a Quick Access plugin pane';
  }
  out.inPanel = inPanel;

  if (!inPanel) { out.why = panelWhy; return out; }

  if (!kind) {
    var inner = [];
    try { inner = gp.querySelectorAll ? gp.querySelectorAll('input, textarea, [contenteditable]') : []; } catch (e) { inner = []; }
    out.editableInside = { count: inner.length, first: inner.length ? describe(inner[0]) : null };
    out.why = 'the ring is on an element that is not a text field';
    return out;
  }
  if (gp.disabled === true) { out.why = 'the field is disabled'; return out; }
  if (gp.readOnly === true) { out.why = 'the field is read-only'; return out; }

  out.eligible = true;

  // The ring already sits on this element, so DOM focus here cannot move it.
  try { gp.focus({ preventScroll: true }); } catch (e) { try { gp.focus(); } catch (e2) {} }

  out.valueBefore = valueOf(gp, kind);

  if (CLEAR) {
    if (kind === 'contenteditable') {
      out.cleared.method = 'select-all + execCommand(delete)';
      try {
        var sel = window.getSelection();
        var range = document.createRange();
        range.selectNodeContents(gp);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete');
      } catch (e) {}
    } else {
      out.cleared.method = 'native value setter + input event';
      try {
        var proto = kind === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(gp, '');
        gp.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) {}
    }
    out.cleared.ok = valueOf(gp, kind) === '';
  }

  // Insert at the END, so typing appends (and, after a clear, starts at zero).
  try {
    if (kind === 'contenteditable') {
      var sel2 = window.getSelection();
      var r2 = document.createRange();
      r2.selectNodeContents(gp);
      r2.collapse(false);
      sel2.removeAllRanges();
      sel2.addRange(r2);
    } else {
      var len = valueOf(gp, kind).length;
      gp.setSelectionRange(len, len);
    }
  } catch (e) { /* email and number inputs refuse a selection; the caret is where focus() left it */ }

  window.__dpsTypeTextEl = gp;
  window.__dpsTypeTextKind = kind;
  return out;
})()`;
}

/** Read the prepared element back, and optionally let go of it. */
export function readBackExpression(release: boolean): string {
  return `(() => {
  var el = window.__dpsTypeTextEl;
  var kind = window.__dpsTypeTextKind;
  var RELEASE = ${release ? "true" : "false"};
  if (!el) return { present: false, connected: false, value: '', activeIsElement: false, ringStillOnElement: false };
  var value = kind === 'contenteditable' ? (el.textContent || '') : (el.value == null ? '' : String(el.value));
  var out = {
    present: true,
    connected: el.isConnected !== false,
    value: value,
    activeIsElement: document.activeElement === el,
    ringStillOnElement: document.querySelector('.gpfocus') === el
  };
  if (RELEASE) { window.__dpsTypeTextEl = undefined; window.__dpsTypeTextKind = undefined; }
  return out;
})()`;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export interface TypeTextOptions {
  /** What to type. May be "" when `clear` or `submit` is the point. */
  text: string;
  /** Press Enter (Input.dispatchKeyEvent) once the text has read back as expected. Never presses A. */
  submit?: boolean;
  /** Empty the field first, instead of appending to what is there. */
  clear?: boolean;
  /**
   * CSS selector for the plugin's own panel root. Decides what counts as "the
   * plugin's page"; the dispatcher defaults it to panelRootSelector in
   * .decky/preview.json. Without one the plugin pane is Decky's (999).
   */
  rootSelector?: string;
  cdpUrl?: string;
  /** Per-CDP-call limit. Default 10 s. */
  timeoutMs?: number;
  /** Wait between insert and read-back, so a re-render has landed. Default 150 ms. */
  settleMs?: number;
  /** Test seam: the focus read. Production reads the Deck over CDP. */
  readFocusFn?: (base: string) => Promise<ReadFocusResult>;
  /** Test seam: open a session on a page's websocket URL. Production opens a real one. */
  openSessionFn?: (wsUrl: string, timeoutMs: number) => Promise<CdpSession>;
}

export interface TypeTextElement {
  tag: string;
  type: string | null;
  kind: EditableKind | null;
  id: string | null;
  classes: string[];
  label: string | null;
  placeholder: string | null;
}

export interface TypeTextResult {
  /** Text went in AND read back as expected (AND Enter was sent, when asked). */
  ok: boolean;
  /** Input.insertText (or the clear alone, when text was "") was delivered to the page. */
  typed: boolean;
  /**
   * "injected" when something was delivered; null when the call refused or
   * failed before delivering anything. Never "steam-routed": see the header.
   */
  fidelity: Fidelity;
  reason?: string;
  summary: string;
  /** True when the call ended because the killswitch was thrown. */
  stopped: boolean;
  /** The element the ring was on, as far as it could be told. */
  element: TypeTextElement | null;
  /** On a refusal for the wrong kind of element: what was found instead, in words. */
  found: string | null;
  /** The page that was written to. */
  target: { title: string; url: string } | null;
  /** What defined "the plugin's page": the selector, or Decky's plugin pane. */
  panelRoot: string | null;
  cleared: { requested: boolean; method: string | null; ok: boolean };
  valueBefore: string | null;
  /** What the field should hold: (nothing, or valueBefore) + text. */
  expected: string | null;
  /** What the field held after the insert settled. */
  valueAfter: string | null;
  /** valueAfter === expected, and the element was still in the document. */
  matched: boolean;
  /** Is the ring still on that element? Null when it was not read. */
  ringStayed: boolean | null;
  submit: { requested: boolean; sent: boolean; key: "Enter"; via: "Input.dispatchKeyEvent"; reason?: string };
  /** The field's value after Enter, since a submit often clears it. Null unless Enter was sent. */
  valueAfterSubmit: string | null;
  insert: "Input.insertText";
  focus: ReadFocusResult | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function emptyResult(clear: boolean, submit: boolean): TypeTextResult {
  return {
    ok: false,
    typed: false,
    fidelity: null,
    summary: "",
    stopped: false,
    element: null,
    found: null,
    target: null,
    panelRoot: null,
    cleared: { requested: clear, method: null, ok: false },
    valueBefore: null,
    expected: null,
    valueAfter: null,
    matched: false,
    ringStayed: null,
    submit: { requested: submit, sent: false, key: "Enter", via: "Input.dispatchKeyEvent" },
    valueAfterSubmit: null,
    insert: "Input.insertText",
    focus: null,
  };
}

/** "<input type=checkbox "Name">" -- what an element was, for a refusal that names it. */
function nameElement(el: PageElement | null, label: string): string {
  if (!el) return "nothing";
  const type = el.type ? ` type=${el.type}` : "";
  const name = (el.ariaLabel || el.placeholder || label || "").trim();
  return `<${el.tag}${type}>${name ? ` "${name.slice(0, 60)}"` : ""}`;
}

function toElement(el: PageElement | null, kind: EditableKind | null, label: string): TypeTextElement | null {
  if (!el) return null;
  return {
    tag: el.tag,
    type: el.type,
    kind,
    id: el.id,
    classes: el.classes,
    label: (el.ariaLabel || label || "").trim() || null,
    placeholder: el.placeholder,
  };
}

export async function typeText(opts: TypeTextOptions): Promise<TypeTextResult> {
  const clear = opts.clear === true;
  const submit = opts.submit === true;
  const base = emptyResult(clear, submit);

  if (typeof opts.text !== "string") {
    return { ...base, reason: "text must be a string.", summary: "refused: no text" };
  }
  const text = opts.text;
  if (!text && !clear && !submit) {
    return {
      ...base,
      reason: "Nothing to do: text is empty and neither clear nor submit was asked for.",
      summary: "refused: nothing to type",
    };
  }

  const machineName = currentMachineIfAny()?.name;
  const latched = automationStopped(machineName);
  if (latched) {
    return {
      ...base,
      stopped: true,
      reason: stoppedMessage(latched),
      summary: "refused: Deck automation is stopped, so nothing was typed",
    };
  }

  const timeoutMs = opts.timeoutMs ?? 10_000;
  const settleMs = opts.settleMs ?? 150;
  const rootSelector = (opts.rootSelector ?? "").trim() || null;
  const panelRoot = rootSelector ?? "quickaccess_content_999 (Decky's plugin pane)";

  let cdpBase = opts.cdpUrl;
  let closeTunnel: (() => void) | null = null;
  if (!cdpBase) {
    try {
      reportCallStage("open tunnel");
      const tunnel = await openCdpTunnel();
      cdpBase = tunnel.base;
      closeTunnel = tunnel.close;
    } catch (err) {
      return {
        ...base,
        reason: (err as Error).message,
        summary: "could not reach the Deck, so nothing was typed",
      };
    }
  }

  let session: CdpSession | null = null;
  let prepared = false;
  // Set just BEFORE the insert is sent: if the send then throws, whether any text landed is unknown.
  let delivered = false;
  // True once the page has been told to let go of the element, so the finally block does not ask twice.
  let released = false;
  try {
    // ---- 1. Read focus. No press, no write. ------------------------------
    reportCallStage("read focus");
    const focus = await (opts.readFocusFn ?? ((b: string) => readFocusAt(b, timeoutMs)))(cdpBase);
    const withFocus = { ...base, focus, panelRoot };

    if (!focus.ok) {
      const unowned = (focus.reason ?? "").includes("gpfocus marker not found");
      return {
        ...withFocus,
        reason: unowned
          ? "Nothing owns the gamepad ring, so there is no field to type into. This tool presses nothing " +
            "and never places the ring: put it on the field first (deck_walkTo), then call again."
          : focus.reason,
        summary: unowned
          ? "refused: nothing owns the ring, so nothing was typed"
          : "could not read focus, so nothing was typed",
      };
    }

    const where = focus.target?.title ?? "an unnamed page";
    if (!isQuickAccessTarget(focus)) {
      return {
        ...withFocus,
        target: focus.target,
        found: `the ring is on ${describeFocus(focus)} on the page "${where}"`,
        reason:
          `The ring is on the page "${where}", which is not the Quick Access page the plugin renders in. ` +
          "Steam's own text fields are not ours to fill by injection, so nothing was typed.",
        summary: `refused: the ring is on "${where}", not on the plugin's page`,
      };
    }

    // ---- 2. Find that page's own debugger socket. -------------------------
    reportCallStage("find page target");
    const targets = await listTargets(cdpBase, timeoutMs);
    const want = focus.target!;
    const page =
      targets.find((t) => t.webSocketDebuggerUrl && t.title === want.title && t.url === want.url) ??
      targets.find((t) => t.webSocketDebuggerUrl && t.title === want.title);
    if (!page?.webSocketDebuggerUrl) {
      return {
        ...withFocus,
        target: want,
        reason: `The focus read came from "${want.title}" but that page is not listed with a debugger socket now (listed: ${targets.map((t) => t.title).join(", ") || "none"}).`,
        summary: "could not reach the page the ring is on, so nothing was typed",
      };
    }

    const recheck = automationStopped(machineName);
    if (recheck) {
      return {
        ...withFocus,
        target: want,
        stopped: true,
        reason: stoppedMessage(recheck),
        summary: "KILLSWITCH: stopped before anything was typed",
      };
    }

    // ---- 3. Inspect the ring's element; focus and clear it if it qualifies.
    reportCallStage("prepare field");
    session = await (opts.openSessionFn ?? openCdpSession)(rewriteWsHost(page.webSocketDebuggerUrl, cdpBase), timeoutMs);
    const prep = await evalValue<PrepareReply>(session, prepareExpression(rootSelector, clear));
    prepared = prep?.eligible === true;

    const label = focus.gpfocus?.label ?? "";
    const element = toElement(prep?.element ?? null, prep?.kind ?? null, label);
    const common = { ...withFocus, target: want, element };

    if (!prep?.ringOwned) {
      return {
        ...common,
        reason:
          "The focus read saw the ring, but on the second look nothing on that page carried it. The ring moved " +
          "or was dropped between the two reads; nothing was typed.",
        summary: "refused: the ring was gone by the time the field was inspected",
      };
    }
    if (!prep.eligible) {
      const inside =
        prep.editableInside && prep.editableInside.count > 0
          ? ` It holds ${prep.editableInside.count} editable element(s) inside it (first: ${nameElement(prep.editableInside.first, "")}); ` +
            "this tool fills only the element the ring is ON and never moves the ring, so it did not guess."
          : "";
      const found = `${nameElement(prep.element, label)} -- ${prep.why ?? "not eligible"}`;
      return {
        ...common,
        found,
        reason: `Refused: ${prep.why ?? "the ring's element is not eligible"}. Found ${found}.${inside} Nothing was typed.`,
        summary: `refused: the ring is on ${nameElement(prep.element, label)}, ${prep.why ?? "not a text field in the plugin's panel"}`,
      };
    }

    const cleared = prep.cleared ?? { requested: clear, method: null, ok: false };
    const withPrep = { ...common, cleared, valueBefore: prep.valueBefore };

    if (clear && !cleared.ok) {
      return {
        ...withPrep,
        reason:
          `Clear did not empty the field (method: ${cleared.method ?? "none"}). Nothing was typed, ` +
          "so the old text is not mixed with the new.",
        summary: "stopped: the field would not clear, so nothing was typed",
      };
    }

    const expected = (clear ? "" : prep.valueBefore) + text;

    // ---- 4. Insert. -----------------------------------------------------
    const midRun = automationStopped(machineName);
    if (midRun) {
      return {
        ...withPrep,
        stopped: true,
        expected,
        fidelity: clear && cleared.ok ? "injected" : null,
        typed: clear && cleared.ok,
        reason: stoppedMessage(midRun),
        summary: "KILLSWITCH: stopped before the text was inserted",
      };
    }

    let typed = false;
    if (text) {
      reportCallStage("insert text");
      try {
        delivered = true;
        await session.send("Input.insertText", { text });
        typed = true;
      } catch (err) {
        return {
          ...withPrep,
          expected,
          reason:
            `Input.insertText failed: ${(err as Error).message}. Whether any of the text landed is unknown ` +
            "-- read the field (deck_readPage) before trusting it.",
          summary: "insert failed",
        };
      }
    } else {
      // A clear (or a bare submit) with no text: the clear above was the injection.
      typed = clear;
    }

    await sleep(settleMs);
    const back = await evalValue<ReadBackReply>(session, readBackExpression(!submit));
    released = !submit;
    const valueAfter = back?.present ? back.value : null;
    const matched = back?.present === true && back.connected && valueAfter === expected;
    const afterInsert = {
      ...withPrep,
      typed,
      fidelity: (typed ? "injected" : null) as Fidelity,
      expected,
      valueAfter,
      matched,
      ringStayed: back?.present ? back.ringStillOnElement : null,
    };

    const why = !back?.present
      ? "the element was no longer tracked on the page"
      : !back.connected
        ? "the element left the document (the panel re-rendered it)"
        : `the field reads ${JSON.stringify(valueAfter)} but ${JSON.stringify(expected)} was expected` +
          " (a maxlength, a controlled field that rejected the change, or newlines in a one-line input would do this)";

    // ---- 5. Submit, if asked, and only on a clean read-back. ----------------
    if (!submit) {
      return {
        ...afterInsert,
        ok: typed && matched,
        reason: matched ? undefined : `The text was injected but did not read back as expected: ${why}.`,
        summary: matched
          ? `typed ${text.length} character(s) by injection and read them back; this proves the field works, not that a controller could fill it`
          : `injected, but the read-back does not match: ${why}`,
      };
    }

    let submitReason: string | undefined;
    if (!matched) submitReason = `not sent: the text did not read back as expected (${why})`;
    else if (back.activeIsElement !== true) {
      submitReason = "not sent: the field no longer holds DOM focus, so Enter would go somewhere else";
    } else {
      const lastCheck = automationStopped(machineName);
      if (lastCheck) submitReason = `not sent: ${stoppedMessage(lastCheck)}`;
    }

    if (submitReason) {
      await evalValue<ReadBackReply>(session, readBackExpression(true)).catch(() => undefined);
      released = true;
      return {
        ...afterInsert,
        ok: false,
        submit: { requested: true, sent: false, key: "Enter", via: "Input.dispatchKeyEvent", reason: submitReason },
        reason: `The text went in${matched ? "" : " but did not read back"}; Enter ${submitReason}.`,
        summary: `injected; Enter ${submitReason}`,
      };
    }

    reportCallStage("send Enter");
    const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    try {
      await session.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r", unmodifiedText: "\r" });
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    } catch (err) {
      return {
        ...afterInsert,
        ok: false,
        submit: {
          requested: true,
          sent: false,
          key: "Enter",
          via: "Input.dispatchKeyEvent",
          reason: `failed: ${(err as Error).message}`,
        },
        reason: `The text went in and read back, but Enter failed: ${(err as Error).message}.`,
        summary: "injected; Enter failed",
      };
    }

    await sleep(settleMs);
    const after = await evalValue<ReadBackReply>(session, readBackExpression(true)).catch(() => undefined);
    released = true;
    return {
      ...afterInsert,
      ok: true,
      submit: { requested: true, sent: true, key: "Enter", via: "Input.dispatchKeyEvent" },
      valueAfterSubmit: after?.present ? after.value : null,
      summary:
        `typed ${text.length} character(s) by injection, read them back, and sent Enter as a DOM key event ` +
        "(Input.dispatchKeyEvent, not an A press); none of it went through the controller or Steam's keyboard",
    };
  } catch (err) {
    return {
      ...base,
      fidelity: delivered ? "injected" : null,
      reason:
        `${(err as Error).message}.` +
        (prepared ? " The field had already been focused or cleared on the page before this failed." : ""),
      summary: "failed before the text could be confirmed",
    };
  } finally {
    if (session) {
      // Best effort: do not leave the element reference on the Steam page.
      if (prepared && !released) {
        try {
          await evalValue(session, readBackExpression(true));
        } catch {
          /* the page may be gone */
        }
      }
      session.close();
    }
    closeTunnel?.();
  }
}
