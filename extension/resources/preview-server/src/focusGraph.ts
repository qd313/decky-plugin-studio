import { handleFocusDirection } from "./shim/focusManager";

export function injectFocusEvent(direction: string): void {
  handleFocusDirection(direction);
}

export function bindFocusGraphKeyboard(): void {
  window.addEventListener("keydown", (e) => {
    const map: Record<string, string> = {
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      Enter: "A",
      Escape: "B",
    };
    const dir = map[e.key];
    if (dir) {
      e.preventDefault();
      injectFocusEvent(dir);
    }
  });
}
