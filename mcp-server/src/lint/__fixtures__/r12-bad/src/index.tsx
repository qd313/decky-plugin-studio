import { Button, Focusable, ToggleField } from "decky-frontend-lib";
import { useEffect, useRef, useState } from "react";
import { call } from "@decky/api";

export function Panel() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    call("get_items").then(setItems);
  }, []);
  return (
    <div>
      {items.map((item) => (
        <Button key={item} onClick={() => {}}>
          {item}
        </Button>
      ))}
    </div>
  );
}
