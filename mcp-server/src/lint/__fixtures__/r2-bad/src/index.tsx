import { Button, Focusable, ToggleField } from "decky-frontend-lib";
import { useEffect, useRef, useState } from "react";
import { call } from "@decky/api";

export function Panel() {
  const aRef = useRef(null);
  const bRef = useRef(null);
  return (
    <div>
      <Focusable ref={aRef} onButtonDown={() => {}} onMoveDown={() => bRef.current.focus()} />
      <Focusable ref={bRef} onButtonDown={() => {}} onMoveUp={() => aRef.current.focus()} />
      <Button onClick={() => {}}>Orphan</Button>
    </div>
  );
}
