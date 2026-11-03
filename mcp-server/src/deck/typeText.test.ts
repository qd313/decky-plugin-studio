/**
 * Tests for deck.typeText.
 *
 * Two halves, because the tool is two things:
 *
 *   THE PAGE HALF is a string of JavaScript that runs in Steam's Quick Access
 *   page. Nothing type-checks it and nothing runs it without a Deck, which is
 *   how readFocus's P1-10 lived for weeks, so it is evaluated here against a
 *   small fake DOM, as readFocus.test.ts does. The fake models React's
 *   value-tracking on purpose: a clear that assigns `el.value = ""` updates the
 *   DOM and leaves React's state on the old text, and a test that could not tell
 *   the two apart would pass the one that does not work.
 *
 *   THE HOST HALF is the order of things and the refusals, driven through the
 *   two seams (the focus read and the CDP session) with a real /json/list from
 *   the fake CDP server. What no test here can say is whether Steam's CEF
 *   accepts Input.insertText on a gpfocus input, whether the ring really sits
 *   on the input itself in bonsAI's Ask field, or whether React sees the
 *   result. Those are device reads, and the tool says it is not yet measured.
 *
 * Hardware guard and killswitch sandbox, as in the other deck tests: the latch
 * is redirected to a temp home so that a developer whose rig is stopped does
 * not fail this file, and so that no test can latch a real one.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const realHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dps-typetext-"));
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;

const { getLatchPath, stopAutomation, armAutomation } = await import("./killswitch.js");
const { prepareExpression, readBackExpression, typeText, openCdpSession } = await import("./typeText.js");
const { startFakeCdp } = await import("./__testutil__/fakeCdp.js");
import type { ReadFocusResult, FocusElement } from "./readFocus.js";
import type { CdpSession, PrepareReply, ReadBackReply } from "./typeText.js";

function assertSandboxed(): void {
  assert.ok(getLatchPath().startsWith(tempHome), `latch path escaped the sandbox: ${getLatchPath()}`);
}

before(() => assertSandboxed());
beforeEach(() => {
  assertSandboxed();
  fs.rmSync(getLatchPath(), { force: true });
});
after(() => {
  process.env.USERPROFILE = realHome.USERPROFILE;
  process.env.HOME = realHome.HOME;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A DOM just real enough for the page expressions
// ---------------------------------------------------------------------------

class FakeEvent {
  type: string;
  constructor(type: string) {
    this.type = type;
  }
}

class FakeNode {
  tagName: string;
  id = "";
  className = "";
  attrs: Record<string, string> = {};
  contentEditable = "inherit";
  disabled = false;
  readOnly = false;
  isConnected = true;
  textContent = "";
  focused = false;
  caret: [number, number] | null = null;
  /** The quickaccess_content_* pane this node sits in, if any. */
  pane: { id: string } | null = null;
  inner: FakeNode[] = [];
  /** React's own copy of the last value it saw. */
  reactTracker = "";
  /** What a controlled field's state holds -- what the next render would show. */
  reactState = "";
  reactEvents = 0;
  constructor(tag: string, private env: FakeEnv) {
    this.tagName = tag.toUpperCase();
  }
  getAttribute(n: string): string | null {
    return n in this.attrs ? this.attrs[n] : null;
  }
  closest(): { id: string } | null {
    return this.pane;
  }
  querySelectorAll(): FakeNode[] {
    return this.inner;
  }
  focus(): void {
    this.focused = true;
    this.env.document.activeElement = this;
  }
  setSelectionRange(a: number, b: number): void {
    this.caret = [a, b];
  }
  /** React's onChange: fires only if the DOM value differs from what its tracker last saw. */
  dispatchEvent(e: FakeEvent): boolean {
    if (e.type === "input") {
      const v = (this as unknown as { _value?: string })._value ?? this.textContent;
      if (v !== this.reactTracker) {
        this.reactTracker = v;
        this.reactState = v;
        this.reactEvents++;
      }
    }
    return true;
  }
}

/** The prototype's own value accessor: what `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set` is. */
class FakeValueNode extends FakeNode {
  _value = "";
  get value(): string {
    return this._value;
  }
  set value(v: string) {
    this._value = String(v);
  }
}
class FakeInputProto extends FakeValueNode {}
class FakeTextAreaProto extends FakeValueNode {}

const valueAccessor = Object.getOwnPropertyDescriptor(FakeValueNode.prototype, "value")!;

interface FakeEnv {
  document: {
    activeElement: FakeNode | null;
    gp: FakeNode | null;
    roots: Record<string, { contains: (n: FakeNode) => boolean } | "invalid">;
    execBroken: boolean;
    querySelector(sel: string): unknown;
    createRange(): { node: FakeNode | null; selectNodeContents(n: FakeNode): void; collapse(): void };
    execCommand(cmd: string): boolean;
  };
  window: Record<string, unknown>;
  selectedNode: FakeNode | null;
}

function makeEnv(): FakeEnv {
  const env: FakeEnv = {
    selectedNode: null,
    window: {},
    document: {
      activeElement: null,
      gp: null,
      roots: {},
      execBroken: false,
      querySelector(sel: string): unknown {
        if (sel === ".gpfocus") return env.document.gp;
        const r = env.document.roots[sel];
        if (r === "invalid") throw new Error("SyntaxError");
        return r ?? null;
      },
      createRange() {
        return {
          node: null as FakeNode | null,
          selectNodeContents(n: FakeNode) {
            this.node = n;
          },
          collapse() {},
        };
      },
      execCommand(cmd: string): boolean {
        if (cmd === "delete" && !env.document.execBroken && env.selectedNode) {
          env.selectedNode.textContent = "";
          return true;
        }
        return false;
      },
    },
  };
  env.window = {
    // In a browser the accessor sits on HTMLInputElement.prototype itself, which
    // is what getOwnPropertyDescriptor needs to find; an inherited one would not do.
    HTMLInputElement: { prototype: Object.defineProperty({}, "value", valueAccessor) },
    HTMLTextAreaElement: { prototype: Object.defineProperty({}, "value", valueAccessor) },
    getSelection: () => ({
      removeAllRanges() {},
      addRange(r: { node: FakeNode | null }) {
        env.selectedNode = r.node;
      },
    }),
  };
  return env;
}

interface FieldSpec {
  tag?: "input" | "textarea" | "div";
  type?: string;
  contentEditable?: string;
  value?: string;
  pane?: string | null;
  disabled?: boolean;
  readOnly?: boolean;
  ariaLabel?: string;
  /** Install React's instance-level value tracking, as a controlled field has it. */
  react?: boolean;
}

/** Typed as the value-bearing node for the tests' sake; a div has no `value` and the tests do not read it. */
function field(env: FakeEnv, spec: FieldSpec = {}): FakeValueNode {
  const tag = spec.tag ?? "input";
  const node =
    tag === "input"
      ? new FakeInputProto("input", env)
      : tag === "textarea"
        ? new FakeTextAreaProto("textarea", env)
        : new FakeNode("div", env);
  if (spec.type) node.attrs.type = spec.type;
  if (spec.ariaLabel) node.attrs["aria-label"] = spec.ariaLabel;
  if (spec.contentEditable) node.contentEditable = spec.contentEditable;
  node.disabled = spec.disabled === true;
  node.readOnly = spec.readOnly === true;
  node.pane = spec.pane === undefined ? { id: "quickaccess_content_999" } : spec.pane === null ? null : { id: spec.pane };
  const value = spec.value ?? "";
  if (node instanceof FakeValueNode) {
    node._value = value;
    if (spec.react) {
      // What React does to a controlled field: an own `value` property that
      // updates its tracker, shadowing the prototype's accessor.
      Object.defineProperty(node, "value", {
        configurable: true,
        get: () => node._value,
        set: (v: string) => {
          node._value = String(v);
          node.reactTracker = String(v);
        },
      });
    }
  } else {
    node.textContent = value;
  }
  node.reactTracker = value;
  node.reactState = value;
  env.document.gp = node;
  return node as FakeValueNode;
}

function runPrepare(env: FakeEnv, root: string | null, clear: boolean): PrepareReply {
  const fn = new Function("document", "window", "Event", `return ${prepareExpression(root, clear)};`);
  return fn(env.document, env.window, FakeEvent) as PrepareReply;
}

function runReadBack(env: FakeEnv, release: boolean): ReadBackReply {
  const fn = new Function("document", "window", `return ${readBackExpression(release)};`);
  return fn(env.document, env.window) as ReadBackReply;
}

// ---------------------------------------------------------------------------
// The page half
// ---------------------------------------------------------------------------

test("both expressions are well-formed JavaScript", () => {
  assert.doesNotThrow(() => new Function(`return ${prepareExpression(null, false)};`));
  assert.doesNotThrow(() => new Function(`return ${prepareExpression(".bonsai-scope", true)};`));
  assert.doesNotThrow(() => new Function(`return ${readBackExpression(true)};`));
  assert.doesNotThrow(() => new Function(`return ${readBackExpression(false)};`));
});

test("a text input under the ring in Decky's pane is eligible, focused, with the caret at the end", () => {
  const env = makeEnv();
  const el = field(env, { value: "hello", ariaLabel: "Ask" });
  const r = runPrepare(env, null, false);
  assert.equal(r.ringOwned, true);
  assert.equal(r.eligible, true);
  assert.equal(r.kind, "input");
  assert.equal(r.inPanel, true);
  assert.equal(r.valueBefore, "hello");
  assert.equal(r.element?.ariaLabel, "Ask");
  assert.equal(el.focused, true, "DOM focus() was called on the ring's element");
  assert.deepEqual(el.caret, [5, 5], "typing would append");
  assert.equal(env.window.__dpsTypeTextEl, el, "remembered for the read-back");
});

test("clear goes through the native setter, so a React-controlled field sees it", () => {
  const env = makeEnv();
  const el = field(env, { value: "old question", react: true });
  const r = runPrepare(env, null, true);
  assert.equal(r.cleared.ok, true);
  assert.equal(r.cleared.method, "native value setter + input event");
  assert.equal(el._value, "");
  assert.equal(el.reactState, "", "React's state followed the DOM: its onChange fired");
  assert.equal(el.reactEvents, 1);
});

test("control: a plain `el.value = ''` would NOT have been seen -- the fake can tell the two apart", () => {
  // Without this, the test above proves nothing: if the fake's React model
  // were too forgiving, it would pass the clear that does not work on a Deck.
  const env = makeEnv();
  const el = field(env, { value: "old question", react: true });
  el.value = "";
  el.dispatchEvent(new FakeEvent("input"));
  assert.equal(el._value, "", "the DOM was cleared");
  assert.equal(el.reactState, "old question", "and React's state was not");
  assert.equal(el.reactEvents, 0);
});

test("a textarea clears and reads the same way", () => {
  const env = makeEnv();
  const el = field(env, { tag: "textarea", value: "a\nb", react: true });
  const r = runPrepare(env, null, true);
  assert.equal(r.kind, "textarea");
  assert.equal(r.cleared.ok, true);
  assert.equal(el.reactState, "");
});

test("a contenteditable host is cleared by select-all and execCommand(delete)", () => {
  const env = makeEnv();
  const el = field(env, { tag: "div", contentEditable: "true", value: "typed here" });
  const r = runPrepare(env, null, true);
  assert.equal(r.kind, "contenteditable");
  assert.equal(r.cleared.method, "select-all + execCommand(delete)");
  assert.equal(r.cleared.ok, true);
  assert.equal(el.textContent, "");
});

test("a clear that does not empty the field says so, so the host can refuse to type", () => {
  const env = makeEnv();
  field(env, { tag: "div", contentEditable: "true", value: "stuck" });
  env.document.execBroken = true;
  const r = runPrepare(env, null, true);
  assert.equal(r.eligible, true);
  assert.equal(r.cleared.requested, true);
  assert.equal(r.cleared.ok, false);
});

test("contenteditable='inherit' is not a contenteditable host", () => {
  // A descendant of an editable host reports contentEditable 'inherit'; the ring
  // on a plain div inside one is not the field itself.
  const env = makeEnv();
  field(env, { tag: "div", value: "x" });
  const r = runPrepare(env, null, false);
  assert.equal(r.eligible, false);
  assert.equal(r.kind, null);
});

test("a wrapper that merely CONTAINS an input is refused, and the input inside is named", () => {
  const env = makeEnv();
  const wrapper = field(env, { tag: "div", value: "Ask" });
  const inside = new FakeInputProto("input", env);
  inside.attrs.placeholder = "Ask anything";
  wrapper.inner = [inside];
  const r = runPrepare(env, null, false);
  assert.equal(r.eligible, false);
  assert.equal(r.kind, null);
  assert.equal(r.editableInside?.count, 1);
  assert.equal(r.editableInside?.first?.placeholder, "Ask anything");
  assert.equal(wrapper.focused, false, "nothing was focused on a refusal");
  assert.equal(env.document.activeElement, null);
  assert.equal(env.window.__dpsTypeTextEl, undefined, "nothing was remembered either");
});

test("inputs that do not take text are refused: a checkbox is not a field", () => {
  for (const type of ["checkbox", "radio", "button", "range", "file"]) {
    const env = makeEnv();
    field(env, { type });
    const r = runPrepare(env, null, false);
    assert.equal(r.eligible, false, type);
    assert.equal(r.element?.type, type);
  }
  for (const type of ["text", "search", "password", "email", "url"]) {
    const env = makeEnv();
    field(env, { type });
    assert.equal(runPrepare(env, null, false).eligible, true, type);
  }
});

test("disabled and read-only fields are refused with the reason", () => {
  const a = makeEnv();
  field(a, { disabled: true });
  assert.match(runPrepare(a, null, false).why ?? "", /disabled/);
  const b = makeEnv();
  field(b, { readOnly: true });
  assert.match(runPrepare(b, null, false).why ?? "", /read-only/);
});

test("a ring outside the plugin's pane is refused, and nothing is focused", () => {
  const other = makeEnv();
  const el = field(other, { pane: "quickaccess_content_3" });
  const r = runPrepare(other, null, false);
  assert.equal(r.eligible, false);
  assert.equal(r.inPanel, false);
  assert.match(r.why ?? "", /quickaccess_content_3/);
  assert.equal(el.focused, false);

  const none = makeEnv();
  field(none, { pane: null });
  assert.match(runPrepare(none, null, false).why ?? "", /not inside a Quick Access plugin pane/);
});

test("with a panel root selector, the ring must be inside that root, whatever pane it is in", () => {
  const env = makeEnv();
  const el = field(env, { pane: null });
  env.document.roots[".bonsai-scope"] = { contains: (n) => n === el };
  const inside = runPrepare(env, ".bonsai-scope", false);
  assert.equal(inside.eligible, true);
  assert.equal(inside.inPanel, true);

  const env2 = makeEnv();
  field(env2);
  env2.document.roots[".bonsai-scope"] = { contains: () => false };
  const outside = runPrepare(env2, ".bonsai-scope", false);
  assert.equal(outside.eligible, false, "Decky's pane does not rescue a ring outside the named root");
  assert.match(outside.why ?? "", /outside the plugin panel root/);

  const env3 = makeEnv();
  field(env3);
  assert.match(runPrepare(env3, ".bonsai-scope", false).why ?? "", /not in the document/);

  const env4 = makeEnv();
  field(env4);
  env4.document.roots["???"] = "invalid";
  assert.match(runPrepare(env4, "???", false).why ?? "", /not a valid selector/);
});

test("nothing carrying gpfocus is reported as an unowned ring, not as a field", () => {
  const env = makeEnv();
  const r = runPrepare(env, null, false);
  assert.equal(r.ringOwned, false);
  assert.equal(r.eligible, false);
});

test("the read-back returns the value, focus facts, and lets go of the element on release", () => {
  const env = makeEnv();
  const el = field(env, { value: "abc" });
  runPrepare(env, null, false);
  env.document.gp = el;
  el._value = "abcdef";
  const first = runReadBack(env, false);
  assert.equal(first.present, true);
  assert.equal(first.value, "abcdef");
  assert.equal(first.activeIsElement, true);
  assert.equal(first.ringStillOnElement, true);
  assert.equal(env.window.__dpsTypeTextEl, el, "not released yet");

  env.document.activeElement = null;
  el.isConnected = false;
  const second = runReadBack(env, true);
  assert.equal(second.activeIsElement, false);
  assert.equal(second.connected, false);
  assert.equal(env.window.__dpsTypeTextEl, undefined, "released");
  assert.equal(runReadBack(env, true).present, false);
});

// ---------------------------------------------------------------------------
// The host half
// ---------------------------------------------------------------------------

function el(extra: Partial<FocusElement> = {}): FocusElement {
  return {
    selector: null,
    selectorVerified: false,
    tag: "INPUT",
    id: null,
    classes: [],
    ariaLabel: null,
    text: "",
    ownerText: "",
    label: "Ask",
    rect: null,
    ...extra,
  };
}

function focusOn(title = "QuickAccess_uid2", gp: FocusElement | null = el()): ReadFocusResult {
  return {
    ok: true,
    fidelity: "steam-owned",
    method: `cdp:${title}`,
    target: { title, url: "about:blank?t=0" },
    steamBuild: null,
    gpfocus: gp,
    visibility: null,
    scrollPane: null,
    gpfocusWithin: [],
    activeElement: null,
    agree: false,
    deckyPluginRoot: true,
    deckyPanelLabels: [],
    quickAccessTab: "999",
    visibleQuickAccessTab: "999",
    targetsScanned: [title],
  };
}

const unownedFocus: ReadFocusResult = {
  ...focusOn(),
  ok: false,
  fidelity: null,
  gpfocus: null,
  target: null,
  reason: "gpfocus marker not found in any target - Steam client may have changed, or nothing currently owns gamepad focus.",
};

function prepOk(over: Partial<PrepareReply> = {}): PrepareReply {
  return {
    ringOwned: true,
    eligible: true,
    why: null,
    element: { tag: "input", type: "text", id: null, classes: ["AskBox"], ariaLabel: "Ask", placeholder: null, contentEditable: "inherit" },
    editableInside: null,
    kind: "input",
    inPanel: true,
    valueBefore: "",
    cleared: { requested: false, method: null, ok: false },
    ...over,
  };
}

function back(value: string, over: Partial<ReadBackReply> = {}): ReadBackReply {
  return { present: true, connected: true, value, activeIsElement: true, ringStillOnElement: true, ...over };
}

interface Script {
  prepare: PrepareReply;
  /** Successive read-back replies. */
  backs: ReadBackReply[];
  failInsert?: string;
  failKey?: string;
}

/** A session that records every call and answers from a script. */
function scripted(script: Script): { open: () => Promise<CdpSession>; calls: Array<{ method: string; params: Record<string, unknown> }>; opened: () => number; closed: () => number } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let opened = 0;
  let closed = 0;
  let b = 0;
  const session: CdpSession = {
    async send(method, params = {}) {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") {
        const expr = String(params.expression);
        if (expr.includes("NON_TEXT")) return { result: { value: script.prepare } };
        const reply = script.backs[Math.min(b++, script.backs.length - 1)];
        return { result: { value: reply } };
      }
      if (method === "Input.insertText" && script.failInsert) throw new Error(script.failInsert);
      if (method === "Input.dispatchKeyEvent" && script.failKey) throw new Error(script.failKey);
      return {};
    },
    close() {
      closed++;
    },
  };
  return {
    open: async () => {
      opened++;
      return session;
    },
    calls,
    opened: () => opened,
    closed: () => closed,
  };
}

async function withFakeDeck<T>(fn: (base: string) => Promise<T>, titles = ["QuickAccess_uid2"]): Promise<T> {
  const fake = await startFakeCdp(titles, () => ({}));
  try {
    return await fn(fake.base);
  } finally {
    await fake.close();
  }
}

const insertCalls = (s: ReturnType<typeof scripted>) => s.calls.filter((c) => c.method === "Input.insertText");
const keyCalls = (s: ReturnType<typeof scripted>) => s.calls.filter((c) => c.method === "Input.dispatchKeyEvent");

test("typing: the order is prepare, insert, read back -- and the fidelity is injected, never steam-routed", async () => {
  const s = scripted({ prepare: prepOk({ valueBefore: "" }), backs: [back("what is a bonsai")] });
  const r = await withFakeDeck((base) =>
    typeText({ text: "what is a bonsai", cdpUrl: base, readFocusFn: async () => focusOn(), openSessionFn: s.open, settleMs: 0 }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.typed, true);
  assert.equal(r.fidelity, "injected");
  assert.equal(r.matched, true);
  assert.equal(r.valueBefore, "");
  assert.equal(r.expected, "what is a bonsai");
  assert.equal(r.valueAfter, "what is a bonsai");
  assert.equal(r.element?.kind, "input");
  assert.equal(r.target?.title, "QuickAccess_uid2");
  assert.deepEqual(
    s.calls.map((c) => c.method),
    ["Runtime.evaluate", "Input.insertText", "Runtime.evaluate"],
  );
  assert.deepEqual(insertCalls(s)[0].params, { text: "what is a bonsai" });
  assert.equal(keyCalls(s).length, 0, "no Enter unless asked");
  assert.equal(r.submit.requested, false);
  assert.equal(r.submit.sent, false);
  assert.match(String(s.calls[2].params.expression), /RELEASE = true/, "the page was let go of");
  assert.equal(s.closed(), 1, "the session was closed");
  assert.match(r.summary, /proves the field works, not that a controller could fill it/);
});

test("without clear the text is appended: expected is what was there plus the text", async () => {
  const s = scripted({ prepare: prepOk({ valueBefore: "Q: " }), backs: [back("Q: hello")] });
  const r = await withFakeDeck((base) =>
    typeText({ text: "hello", cdpUrl: base, readFocusFn: async () => focusOn(), openSessionFn: s.open, settleMs: 0 }),
  );
  assert.equal(r.expected, "Q: hello");
  assert.equal(r.matched, true);
  assert.match(String(s.calls[0].params.expression), /CLEAR = false/);
});

test("clear: the expectation drops the old text, and cleared.method is reported", async () => {
  const s = scripted({
    prepare: prepOk({ valueBefore: "old", cleared: { requested: true, method: "native value setter + input event", ok: true } }),
    backs: [back("new")],
  });
  const r = await withFakeDeck((base) =>
    typeText({ text: "new", clear: true, cdpUrl: base, readFocusFn: async () => focusOn(), openSessionFn: s.open, settleMs: 0 }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.valueBefore, "old");
  assert.equal(r.expected, "new");
  assert.deepEqual(r.cleared, { requested: true, method: "native value setter + input event", ok: true });
  assert.match(String(s.calls[0].params.expression), /CLEAR = true/);
});

test("a clear that did not empty the field stops BEFORE typing", async () => {
  const s = scripted({
    prepare: prepOk({ valueBefore: "stuck", cleared: { requested: true, method: "native value setter + input event", ok: false } }),
    backs: [back("stuck")],
  });
  const r = await withFakeDeck((base) =>
    typeText({ text: "new", clear: true, cdpUrl: base, readFocusFn: async () => focusOn(), openSessionFn: s.open, settleMs: 0 }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.typed, false);
  assert.equal(r.fidelity, null);
  assert.match(r.reason ?? "", /did not empty the field/);
  assert.equal(insertCalls(s).length, 0, "old and new text were never mixed");
  // The element reference on the page was still let go of.
  assert.ok(s.calls.some((c) => /RELEASE = true/.test(String(c.params.expression))));
});

test("a read-back that differs is ok:false and says what it expected, but the fidelity is still injected", async () => {
  const s = scripted({ prepare: prepOk(), backs: [back("what is a bon")] });
  const r = await withFakeDeck((base) =>
    typeText({ text: "what is a bonsai", cdpUrl: base, readFocusFn: async () => focusOn(), openSessionFn: s.open, settleMs: 0 }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.typed, true, "the text was delivered");
  assert.equal(r.matched, false);
  assert.equal(r.fidelity, "injected");
  assert.equal(r.valueAfter, "what is a bon");
  assert.match(r.reason ?? "", /did not read back as expected/);
});

test("an element that left the document is not a match, even when its old value would be", async () => {
  const s = scripted({ prepare: prepOk(), backs: [back("hi", { connected: false })] });
  const r = await withFakeDeck((base) =>
    typeText({ text: "hi", cdpUrl: base, readFocusFn: async () => focusOn(), openSessionFn: s.open, settleMs: 0 }),
  );
  assert.equal(r.matched, false);
  assert.match(r.reason ?? "", /left the document/);
});

test("submit: Enter is a DOM key event (keyDown then keyUp), sent after the text read back, and says so", async () => {
  const s = scripted({ prepare: prepOk(), backs: [back("hi"), back("")] });
  const r = await withFakeDeck((base) =>
    typeText({ text: "hi", submit: true, cdpUrl: base, readFocusFn: async () => focusOn(), openSessionFn: s.open, settleMs: 0 }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.submit, { requested: true, sent: true, key: "Enter", via: "Input.dispatchKeyEvent" });
  assert.equal(r.valueAfter, "hi");
  assert.equal(r.valueAfterSubmit, "", "the field was emptied by the submit");
  const methods = s.calls.map((c) => c.method);
  assert.deepEqual(methods, [
    "Runtime.evaluate",
    "Input.insertText",
    "Runtime.evaluate",
    "Input.dispatchKeyEvent",
    "Input.dispatchKeyEvent",
    "Runtime.evaluate",
  ]);
  const [down, up] = keyCalls(s);
  assert.equal(down.params.type, "keyDown");
  assert.equal(up.params.type, "keyUp");
  for (const k of [down, up]) {
    assert.equal(k.params.key, "Enter");
    assert.equal(k.params.windowsVirtualKeyCode, 13);
  }
  assert.match(r.summary, /not an A press/);
  // The first read-back must NOT have released the element: Enter needs it.
  assert.match(String(s.calls[2].params.expression), /RELEASE = false/);
  assert.match(String(s.calls[5].params.expression), /RELEASE = true/);
});

test("submit is not sent when the text did not read back", async () => {
  const s = scripted({ prepare: prepOk(), backs: [back("something else"), back("")] });
  const r = await withFakeDeck((base) =>
    typeText({ text: "hi", submit: true, cdpUrl: base, readFocusFn: async () => focusOn(), openSessionFn: s.open, settleMs: 0 }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.submit.sent, false);
  assert.match(r.submit.reason ?? "", /did not read back/);
  assert.equal(keyCalls(s).length, 0, "Enter would have submitted the wrong text");
});

test("submit is not sent when the field no longer holds DOM focus", async () => {
  const s = scripted({ prepare: prepOk(), backs: [back("hi", { activeIsElement: false }), back("hi")] });
  const r = await withFakeDeck((base) =>
    typeText({ text: "hi", submit: true, cdpUrl: base, readFocusFn: async () => focusOn(), openSessionFn: s.open, settleMs: 0 }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.typed, true);
  assert.equal(r.matched, true);
  assert.equal(r.submit.sent, false);
  assert.match(r.submit.reason ?? "", /no longer holds DOM focus/);
  assert.equal(keyCalls(s).length, 0, "Enter would have gone to another element");
});

test("a failed Enter is reported, with the text still counted as typed", async () => {
  const s = scripted({ prepare: prepOk(), backs: [back("hi")], failKey: "boom" });
  const r = await withFakeDeck((base) =>
    typeText({ text: "hi", submit: true, cdpUrl: base, readFocusFn: async () => focusOn(), openSessionFn: s.open, settleMs: 0 }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.typed, true);
  assert.equal(r.fidelity, "injected");
  assert.equal(r.submit.sent, false);
  assert.match(r.submit.reason ?? "", /boom/);
});

test("an insert that throws leaves it unknown whether text landed, and fidelity says injected", async () => {
  const s = scripted({ prepare: prepOk(), backs: [back("")], failInsert: "CDP error on Input.insertText: nope" });
  const r = await withFakeDeck((base) =>
    typeText({ text: "hi", cdpUrl: base, readFocusFn: async () => focusOn(), openSessionFn: s.open, settleMs: 0 }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.typed, false);
  assert.match(r.reason ?? "", /whether any of the text landed is unknown/i);
  assert.ok(s.closed() >= 1);
});

test("a clear with empty text is a clear alone, still injected", async () => {
  const s = scripted({
    prepare: prepOk({ valueBefore: "old", cleared: { requested: true, method: "native value setter + input event", ok: true } }),
    backs: [back("")],
  });
  const r = await withFakeDeck((base) =>
    typeText({ text: "", clear: true, cdpUrl: base, readFocusFn: async () => focusOn(), openSessionFn: s.open, settleMs: 0 }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.fidelity, "injected");
  assert.equal(insertCalls(s).length, 0, "nothing to insert");
  assert.equal(r.valueAfter, "");
});

test("a panel root selector from the caller reaches the page expression", async () => {
  const s = scripted({ prepare: prepOk(), backs: [back("x")] });
  await withFakeDeck((base) =>
    typeText({ text: "x", rootSelector: ".bonsai-scope", cdpUrl: base, readFocusFn: async () => focusOn(), openSessionFn: s.open, settleMs: 0 }),
  );
  assert.match(String(s.calls[0].params.expression), /var ROOT = ".bonsai-scope";/);
});

// ---- refusals: nothing may be written ------------------------------------

test("an unowned ring is refused without opening a session -- and the tool never places the ring", async () => {
  const s = scripted({ prepare: prepOk(), backs: [back("")] });
  const r = await withFakeDeck((base) =>
    typeText({ text: "x", cdpUrl: base, readFocusFn: async () => unownedFocus, openSessionFn: s.open }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.typed, false);
  assert.equal(r.fidelity, null);
  assert.match(r.reason ?? "", /Nothing owns the gamepad ring/);
  assert.match(r.reason ?? "", /never places the ring/);
  assert.equal(s.opened(), 0);
});

test("the ring on a Steam page of its own is refused: not the plugin's page", async () => {
  const s = scripted({ prepare: prepOk(), backs: [back("")] });
  const r = await withFakeDeck(
    (base) =>
      typeText({
        text: "x",
        cdpUrl: base,
        readFocusFn: async () => focusOn("Steam Big Picture Mode", el({ label: "Search the store" })),
        openSessionFn: s.open,
      }),
    ["Steam Big Picture Mode"],
  );
  assert.equal(r.ok, false);
  assert.equal(r.fidelity, null);
  assert.match(r.reason ?? "", /Steam's own text fields are not ours to fill/);
  assert.match(r.found ?? "", /Steam Big Picture Mode/);
  assert.equal(s.opened(), 0, "never even connected to that page");
});

test("a focused element that is not a field is refused, and what was found is named", async () => {
  const s = scripted({
    prepare: prepOk({
      eligible: false,
      kind: null,
      why: "the ring is on an element that is not a text field",
      element: { tag: "input", type: "checkbox", id: null, classes: [], ariaLabel: "Enable thing", placeholder: null, contentEditable: "inherit" },
    }),
    backs: [back("")],
  });
  const r = await withFakeDeck((base) =>
    typeText({ text: "x", cdpUrl: base, readFocusFn: async () => focusOn(), openSessionFn: s.open, settleMs: 0 }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.typed, false);
  assert.equal(r.fidelity, null);
  assert.match(r.found ?? "", /<input type=checkbox> "Enable thing"/);
  assert.equal(insertCalls(s).length, 0);
  assert.equal(keyCalls(s).length, 0);
});

test("a wrapper around an input is refused, naming the input inside rather than guessing", async () => {
  const s = scripted({
    prepare: prepOk({
      eligible: false,
      kind: null,
      why: "the ring is on an element that is not a text field",
      element: { tag: "div", type: null, id: null, classes: ["Focusable"], ariaLabel: null, placeholder: null, contentEditable: "inherit" },
      editableInside: {
        count: 1,
        first: { tag: "input", type: "text", id: null, classes: [], ariaLabel: null, placeholder: "Ask anything", contentEditable: "inherit" },
      },
    }),
    backs: [back("")],
  });
  const r = await withFakeDeck((base) =>
    typeText({ text: "x", cdpUrl: base, readFocusFn: async () => focusOn(), openSessionFn: s.open, settleMs: 0 }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /1 editable element\(s\) inside it/);
  assert.match(r.reason ?? "", /"Ask anything"/);
  assert.match(r.reason ?? "", /never moves the ring/);
  assert.equal(insertCalls(s).length, 0);
});

test("a ring that vanished between the two reads is refused", async () => {
  const s = scripted({ prepare: prepOk({ ringOwned: false, eligible: false, why: "no element on this page carries gpfocus", element: null }), backs: [back("")] });
  const r = await withFakeDeck((base) =>
    typeText({ text: "x", cdpUrl: base, readFocusFn: async () => focusOn(), openSessionFn: s.open, settleMs: 0 }),
  );
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /moved or was dropped between the two reads/);
  assert.equal(insertCalls(s).length, 0);
});

test("empty text with nothing else to do is refused before anything is read", async () => {
  const s = scripted({ prepare: prepOk(), backs: [back("")] });
  let focusReads = 0;
  const r = await typeText({
    text: "",
    cdpUrl: "http://127.0.0.1:1",
    readFocusFn: async () => {
      focusReads++;
      return focusOn();
    },
    openSessionFn: s.open,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /Nothing to do/);
  assert.equal(focusReads, 0);
  assert.equal(s.opened(), 0);

  const bad = await typeText({ text: undefined as unknown as string, cdpUrl: "http://127.0.0.1:1" });
  assert.match(bad.reason ?? "", /text must be a string/);
});

test("an unreachable Deck types nothing and says it could not read focus", async () => {
  const s = scripted({ prepare: prepOk(), backs: [back("")] });
  const r = await typeText({ text: "x", cdpUrl: "http://127.0.0.1:1", openSessionFn: s.open });
  assert.equal(r.ok, false);
  assert.equal(r.typed, false);
  assert.equal(r.fidelity, null);
  assert.equal(s.opened(), 0);
  assert.match(r.summary, /could not read focus/);
});

test("the killswitch refuses before focus is read, and a stop mid-call stops before the insert", async () => {
  const s = scripted({ prepare: prepOk(), backs: [back("x")] });
  let focusReads = 0;
  await stopAutomation({ by: "command", reason: "test", skipTunnels: true });
  const stopped = await typeText({
    text: "x",
    cdpUrl: "http://127.0.0.1:1",
    readFocusFn: async () => {
      focusReads++;
      return focusOn();
    },
    openSessionFn: s.open,
  });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.stopped, true);
  assert.match(stopped.reason ?? "", /STOPPED/);
  assert.equal(focusReads, 0);
  assert.equal(s.opened(), 0);
  armAutomation();

  // Thrown while the focus read is in flight: the re-check before the page is
  // touched must see it.
  const s2 = scripted({ prepare: prepOk(), backs: [back("x")] });
  const mid = await withFakeDeck((base) =>
    typeText({
      text: "x",
      cdpUrl: base,
      readFocusFn: async () => {
        await stopAutomation({ by: "command", reason: "mid-call", skipTunnels: true });
        return focusOn();
      },
      openSessionFn: s2.open,
      settleMs: 0,
    }),
  );
  assert.equal(mid.stopped, true);
  assert.equal(mid.fidelity, null);
  assert.equal(s2.opened(), 0, "the page was never opened");
  assert.equal(insertCalls(s2).length, 0);
});

// ---- the real session over a real socket ----------------------------------

test("the session speaks over one socket and matches replies to calls", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => "answer");
  try {
    const wsUrl = fake.base.replace("http://", "ws://") + "/devtools/page/T0";
    const session = await openCdpSession(wsUrl, 3000);
    try {
      const a = (await session.send("Runtime.evaluate", { expression: "1" })) as { result: { value: string } };
      const b = (await session.send("Input.insertText", { text: "x" })) as { result: { value: string } };
      assert.equal(a.result.value, "answer");
      assert.equal(b.result.value, "answer");
    } finally {
      session.close();
    }
  } finally {
    await fake.close();
  }
});

test("the session rejects a call that gets no answer, naming the method", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => ({ __hang: true }));
  try {
    const wsUrl = fake.base.replace("http://", "ws://") + "/devtools/page/T0";
    const session = await openCdpSession(wsUrl, 150);
    try {
      await assert.rejects(() => session.send("Input.insertText", { text: "x" }), /Input\.insertText timed out/);
    } finally {
      session.close();
    }
  } finally {
    await fake.close();
  }
});
