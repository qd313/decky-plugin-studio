import { Button, Focusable, ToggleField } from "decky-frontend-lib";
import { useEffect, useRef, useState } from "react";
import { call } from "@decky/api";

export function Panel() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <ToggleField onChange={() => setOpen(!open)} />
      {open && (
        <div>
          <Button onClick={() => {}}>One</Button>
          <Button onClick={() => {}}>Two</Button>
        </div>
      )}
    </div>
  );
}
