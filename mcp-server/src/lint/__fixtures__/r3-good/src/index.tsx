import { Button, Focusable, ToggleField } from "decky-frontend-lib";
import { useEffect, useRef, useState } from "react";
import { call } from "@decky/api";

export function Panel() {
  return (
    <Focusable>
      <Button onClick={() => {}}>Go</Button>
    </Focusable>
  );
}
