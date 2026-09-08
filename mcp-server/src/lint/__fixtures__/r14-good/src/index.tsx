import { Focusable } from "decky-frontend-lib";
import { useRef } from "react";

export function Panel() {
  const rowRef = useRef<HTMLDivElement | null>(null);

  // Checked against a ref this component registered itself -- guaranteed to
  // be an Element from this document, never a value that crossed a realm.
  function isOwnRow(node: unknown): boolean {
    return rowRef.current instanceof Element && node === rowRef.current;
  }

  return (
    <Focusable ref={rowRef} onButtonDown={() => isOwnRow(rowRef.current)}>
      <div>row</div>
    </Focusable>
  );
}
