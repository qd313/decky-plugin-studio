import { handleFocusDirection } from "./shim/focusManager";

export function injectFocusEvent(direction: string): void {
  handleFocusDirection(direction);
}

const KEY_TO_DIRECTION: Record<string, string> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Enter: "A",
  Escape: "B",
};

/**
 * Let a developer drive the preview with their own keyboard, without ever
 * letting the plugin observe a real DOM key event for it.
 *
 * Steam does not dispatch DOM keyboard events into a plugin -- D-pad and
 * button presses arrive only as calls to Focusable's `onMove*` /
 * `onOKButton` / `onCancelButton` props. Today the plugin renders into the
 * same document as this shim (there is no iframe boundary yet), so a plugin
 * that wires its own `keydown` listener for "D-pad" handling would otherwise
 * see the exact same native key press this shim uses to drive the preview,
 * and the bug would look fixed here while staying dead on device.
 *
 * The listener is registered on the capture phase, at module load -- before
 * any plugin code has run -- and swallows the event with
 * stopImmediatePropagation before translating it into a Focusable call. On a
 * single node (window), a listener that runs first can still stop one
 * registered after it regardless of that later listener's own capture flag,
 * because DOM dispatch invokes same-node listeners in registration order.
 * On a descendant node -- `document`, or the element behind a JSX
 * `onKeyDown` -- capture guarantees this handler is reached, and stopped,
 * before the event ever propagates that far. Either shape a plugin might
 * use to intercept `keydown` is covered.
 */
export function bindFocusGraphKeyboard(): void {
  window.addEventListener(
    "keydown",
    (e) => {
      const dir = KEY_TO_DIRECTION[e.key];
      if (dir) {
        e.preventDefault();
        e.stopImmediatePropagation();
        injectFocusEvent(dir);
      }
    },
    { capture: true },
  );
}
