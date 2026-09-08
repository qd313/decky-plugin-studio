import { Focusable } from "decky-frontend-lib";
import { useEffect, useRef } from "react";

export function HiddenTabTrap() {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function handleFocusIn(e: FocusEvent) {
      if (e.target instanceof Element && !panelRef.current?.contains(e.target)) {
        panelRef.current?.classList.add("hidden");
      }
    }
    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, []);

  return (
    <Focusable ref={panelRef} onButtonDown={() => {}}>
      <div>tab content</div>
    </Focusable>
  );
}
