export type GamepadHandlers = {
  onMoveLeft?: () => boolean | void;
  onMoveRight?: () => boolean | void;
  onMoveUp?: () => boolean | void;
  onMoveDown?: () => boolean | void;
  onOKButton?: (evt?: { stopPropagation: () => void }) => void;
  onCancelButton?: () => void;
  onButtonDown?: () => void;
};

const registry = new WeakMap<HTMLElement, GamepadHandlers>();
let activeEl: HTMLElement | null = null;
let focusInBound = false;
const focusEventLog: string[] = [];

export function clearFocusEventLog(): void {
  focusEventLog.length = 0;
}

export function getFocusEventLog(): string[] {
  return [...focusEventLog];
}

export function getActiveFocusSelector(): string {
  if (!activeEl) return "document.body";
  const parts: string[] = [];
  if (activeEl.id) parts.push(`#${activeEl.id}`);
  if (activeEl.className && typeof activeEl.className === "string") {
    const cls = activeEl.className.split(/\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) parts.push(`.${cls.join(".")}`);
  }
  if (!parts.length) parts.push(activeEl.tagName.toLowerCase());
  return parts.join("");
}

const DIRECTION_MAP: Record<string, keyof GamepadHandlers> = {
  Left: "onMoveLeft",
  Right: "onMoveRight",
  Up: "onMoveUp",
  Down: "onMoveDown",
  A: "onOKButton",
  B: "onCancelButton",
  Select: "onButtonDown",
};

export function extractGamepadHandlers(props: Record<string, unknown>): GamepadHandlers {
  const handlers: GamepadHandlers = {};
  for (const key of Object.keys(DIRECTION_MAP) as (keyof GamepadHandlers)[]) {
    if (typeof props[key] === "function") {
      handlers[key] = props[key] as GamepadHandlers[typeof key];
    }
  }
  return handlers;
}

function hasHandlers(handlers: GamepadHandlers): boolean {
  return Object.values(handlers).some((h) => typeof h === "function");
}

function findHandlers(el: HTMLElement | null): { el: HTMLElement; handlers: GamepadHandlers } | null {
  let cur = el;
  while (cur) {
    const handlers = registry.get(cur);
    if (handlers && hasHandlers(handlers)) return { el: cur, handlers };
    cur = cur.parentElement;
  }
  return null;
}

export function setActiveFocus(el: HTMLElement): void {
  if (activeEl === el) return;
  activeEl?.classList.remove("decky-focus-active");
  activeEl = el;
  el.classList.add("decky-focus-active");
  if (el.tabIndex < 0) el.tabIndex = 0;
  el.focus({ preventScroll: true });
}

function firstFocusable(): HTMLElement | null {
  return document.querySelector("[data-decky-focusable]") as HTMLElement | null;
}

export function registerFocusTarget(el: HTMLElement, handlers: GamepadHandlers): void {
  if (!hasHandlers(handlers)) return;
  registry.set(el, handlers);
  el.setAttribute("data-decky-focusable", "true");
  if (!activeEl || !document.contains(activeEl)) {
    setActiveFocus(el);
  }
}

export function unregisterFocusTarget(el: HTMLElement): void {
  registry.delete(el);
  el.removeAttribute("data-decky-focusable");
  if (activeEl === el) {
    activeEl.classList.remove("decky-focus-active");
    activeEl = null;
  }
}

export function ensureFocusManager(): void {
  if (focusInBound) return;
  focusInBound = true;
  document.addEventListener("focusin", (e) => {
    const target = e.target as HTMLElement;
    const found = findHandlers(target);
    if (found) setActiveFocus(found.el);
  });
  window.addEventListener("message", (e) => {
    if (e.data?.type === "decky-focus" && typeof e.data.direction === "string") {
      handleFocusDirection(e.data.direction);
    }
  });
}

export function handleFocusDirection(direction: string): boolean {
  ensureFocusManager();
  let found = findHandlers(activeEl);
  if (!found) {
    const first = firstFocusable();
    if (first) {
      setActiveFocus(first);
      found = findHandlers(first);
    }
  }
  // #region agent log
  fetch("http://127.0.0.1:7250/ingest/d9b9fe73-b859-4d1b-9b3d-56de654fcd83", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "6049fa" },
    body: JSON.stringify({
      sessionId: "6049fa",
      runId: "modal-focus-fix",
      hypothesisId: "D",
      location: "focusManager.ts:handleFocusDirection",
      message: "focus routed",
      data: {
        direction,
        hasActive: Boolean(found),
        activeTag: activeEl?.tagName,
        activeClass: activeEl?.className?.slice?.(0, 80),
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
  if (!found) return false;

  const handlerKey = DIRECTION_MAP[direction];
  if (!handlerKey) return false;

  const cb = found.handlers[handlerKey];
  if (typeof cb !== "function") return false;

  setActiveFocus(found.el);

  if (handlerKey === "onOKButton") {
    focusEventLog.push(`${handlerKey}(${direction})`);
    cb({ stopPropagation: () => {} });
    const clickTarget =
      found.el.tagName === "BUTTON"
        ? (found.el as HTMLButtonElement)
        : (found.el.querySelector("button:not([disabled])") as HTMLButtonElement | null);
    clickTarget?.click();
    return true;
  }

  focusEventLog.push(`${handlerKey}(${direction})`);
  cb();
  return true;
}
