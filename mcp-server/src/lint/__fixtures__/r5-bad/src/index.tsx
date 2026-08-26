import { Button, Focusable, ToggleField } from "decky-frontend-lib";
import { useEffect, useRef, useState } from "react";
import { call } from "@decky/api";

export function Panel() {
  return (
    <div>
      <Focusable
        onButtonDown={() => {}}
        onMoveDown={() => document.querySelector(".save-button").focus()}
      />
    </div>
  );
}
