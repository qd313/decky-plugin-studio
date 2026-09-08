/**
 * Proves the fix for "the preview lies about D-pad keydown."
 *
 * Before this fix, `bindFocusGraphKeyboard` registered a plain bubble-phase
 * `keydown` listener on `window`. Because the plugin renders into the same
 * document as this shim (no iframe boundary -- see the roadmap item this
 * closes only part of), a plugin that wired its own `keydown` listener to
 * fake D-pad routing would see the exact same native key press a developer
 * uses to drive the preview. That handler is dead on a real Deck -- Steam
 * never dispatches DOM keyboard events into a plugin -- but it "worked" in
 * the preview, which is exactly the lie this feature exists to remove.
 *
 * Node has no real DOM, so this test builds the smallest possible model of
 * the WHATWG event-dispatch algorithm (capture down, target, bubble up)
 * across a three-node chain: window -> document -> a plugin element. That is
 * enough surface to prove the real property: a capture-phase listener on
 * `window`, registered before the plugin ever runs, can observe and swallow
 * the key press before a bubble-phase listener anywhere underneath it -- on
 * `document`, or on the specific element behind a JSX `onKeyDown` -- ever
 * sees it. Pulling in jsdom for one property of one event would be more
 * machinery than the fix it is checking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { bindFocusGraphKeyboard } from "./focusGraph";
import { registerFocusTarget } from "./shim/focusManager";

type Listener = (e: FakeEvent) => void;

class FakeEvent {
  propagationStopped = false;
  immediatePropagationStopped = false;
  defaultPrevented = false;

  constructor(
    public readonly type: string,
    public readonly key?: string,
  ) {}

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  stopImmediatePropagation(): void {
    this.propagationStopped = true;
    this.immediatePropagationStopped = true;
  }
}

/**
 * Stands in for window, document, and a plugin-rendered element alike. Real
 * capture/bubble ordering only exists across a node tree, so this is a tree
 * node with just enough element-ish surface for focusManager.ts to run.
 */
class FakeNode {
  parent: FakeNode | null = null;
  tabIndex = -1;
  tagName = "DIV";
  id = "";
  className = "";
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Array<{ fn: Listener; capture: boolean }>>();

  get parentElement(): FakeNode | null {
    return this.parent;
  }

  classList = {
    add: (_cls: string): void => {},
    remove: (_cls: string): void => {},
  };

  focus(_opts?: unknown): void {}

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  querySelector(_selector: string): FakeNode | null {
    return null;
  }

  contains(node: FakeNode | null): boolean {
    let cur = node;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parent;
    }
    return false;
  }

  addEventListener(type: string, fn: Listener, opts?: boolean | { capture?: boolean }): void {
    const capture = typeof opts === "object" ? !!opts.capture : !!opts;
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture });
    this.listeners.set(type, list);
  }

  private listenersFor(type: string): Array<{ fn: Listener; capture: boolean }> {
    return this.listeners.get(type) ?? [];
  }

  /** Full WHATWG dispatch: capture from the root down, target, bubble back up. */
  static dispatch(target: FakeNode, event: FakeEvent): void {
    const ancestors: FakeNode[] = [];
    let cur = target.parent;
    while (cur) {
      ancestors.push(cur);
      cur = cur.parent;
    }
    const outermostFirst = [...ancestors].reverse();

    for (const node of outermostFirst) {
      for (const { fn, capture } of node.listenersFor(event.type)) {
        if (!capture) continue;
        fn(event);
        if (event.immediatePropagationStopped) return;
      }
      if (event.propagationStopped) return;
    }

    for (const { fn } of target.listenersFor(event.type)) {
      fn(event);
      if (event.immediatePropagationStopped) return;
    }
    if (event.propagationStopped) return;

    for (const node of ancestors) {
      for (const { fn, capture } of node.listenersFor(event.type)) {
        if (capture) continue;
        fn(event);
        if (event.immediatePropagationStopped) return;
      }
      if (event.propagationStopped) return;
    }
  }
}

function buildFakeDom(): { win: FakeNode; doc: FakeNode; pluginButton: FakeNode } {
  const win = new FakeNode();
  const doc = new FakeNode();
  doc.parent = win;
  const pluginButton = new FakeNode();
  pluginButton.parent = doc;
  return { win, doc, pluginButton };
}

test("an ArrowDown key reaches the Focusable handler and never reaches the plugin's own keydown listeners", () => {
  const { win, doc, pluginButton } = buildFakeDom();
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).document = doc;

  // The preview shim binds first, before any plugin code has run -- exactly
  // as sandbox-host.tsx does today (bindFocusGraphKeyboard() precedes mount()).
  bindFocusGraphKeyboard();

  // A plugin that (wrongly) tries to route the D-pad itself: one listener
  // shaped like `document.addEventListener("keydown", ...)`, one shaped like
  // a JSX `onKeyDown` on the element itself. Neither should ever fire for a
  // direction key.
  let documentKeydownCalls = 0;
  doc.addEventListener("keydown", () => {
    documentKeydownCalls++;
  });
  let elementKeydownCalls = 0;
  pluginButton.addEventListener("keydown", () => {
    elementKeydownCalls++;
  });

  // The one true path: a Focusable onMoveDown prop.
  let onMoveDownCalls = 0;
  registerFocusTarget(pluginButton as unknown as HTMLElement, {
    onMoveDown: () => {
      onMoveDownCalls++;
    },
  });

  const event = new FakeEvent("keydown", "ArrowDown");
  FakeNode.dispatch(pluginButton, event);

  assert.equal(onMoveDownCalls, 1, "the Focusable onMoveDown handler must fire");
  assert.equal(documentKeydownCalls, 0, "a document-level keydown listener must never see the direction key");
  assert.equal(elementKeydownCalls, 0, "an element-level keydown listener (JSX onKeyDown) must never see the direction key");
  assert.equal(event.defaultPrevented, true);
});

test("a non-direction key is left alone: no Focusable call, and the plugin's own listener still sees it", () => {
  const { win, doc, pluginButton } = buildFakeDom();
  (globalThis as Record<string, unknown>).window = win;
  (globalThis as Record<string, unknown>).document = doc;

  bindFocusGraphKeyboard();

  let elementKeydownCalls = 0;
  pluginButton.addEventListener("keydown", () => {
    elementKeydownCalls++;
  });

  let onMoveDownCalls = 0;
  registerFocusTarget(pluginButton as unknown as HTMLElement, {
    onMoveDown: () => {
      onMoveDownCalls++;
    },
  });

  const event = new FakeEvent("keydown", "a");
  FakeNode.dispatch(pluginButton, event);

  assert.equal(onMoveDownCalls, 0, "a letter key is not a D-pad direction");
  assert.equal(elementKeydownCalls, 1, "the fix must not swallow keydown events it doesn't recognise");
  assert.equal(event.defaultPrevented, false);
});
