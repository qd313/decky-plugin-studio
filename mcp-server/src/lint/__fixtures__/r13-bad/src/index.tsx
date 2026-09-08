import { Focusable } from "decky-frontend-lib";
import { useEffect, useState } from "react";

export function SpoilerFence({ children }: { children: React.ReactNode }) {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Enter" || e.key === " ") {
        setRevealed(true);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <Focusable onOKButton={() => {}}>
      {revealed ? children : <div>spoiler hidden</div>}
    </Focusable>
  );
}
