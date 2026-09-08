import { Focusable, TextField } from "decky-frontend-lib";

export function Panel() {
  function handleTextKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Suppress Tab so focus doesn't leave the field. Not a D-pad direction
    // and not an activation key, so this is not the routing rule's business.
    if (e.key === "Tab") {
      e.preventDefault();
    }
  }

  return (
    <div>
      <TextField onKeyDown={handleTextKeyDown} onChange={() => {}} />
      <Focusable onMoveDown={() => {}} onOKButton={() => {}} />
    </div>
  );
}
