# Focus graph patterns

Decky QAM navigation is a **focus graph**, not DOM tab order. Wire explicit `Focusable` callbacks before relying on `keydown` or browser focus.

## Pattern A — section-parent explicit graph

**Use when:** a vertical stack of controls (settings rows, transcript blocks, modal sections) must be reachable with D-pad Up/Down.

**Rule:** the **section parent** `Focusable` owns `onMoveUp` and `onMoveDown`. Children do not assume siblings exist in DOM order.

### Wiring checklist

1. **Enumerate stops** in document order (top → bottom). Name each stop: button, slider, spoiler, nested row, etc.
2. **Hold refs** (or stable focus handles) for each stop the parent must reach.
3. **Parent `onMoveDown`:** from current stop, call `.focus()` (or Decky equivalent) on the next stop in the list; return `true` when handled.
4. **Parent `onMoveUp`:** same, previous stop in the list.
5. **Leaf controls:** each interactive `Button` needs `focusable`, `onMoveUp`/`onMoveDown` (often delegate to parent or neighbor), and `onButtonDown` for A/activate.
6. **Sliders / spoilers:** wrap in a bridging `Focusable` or use a proven parent-ref pattern — do not assume the slider is the next DOM sibling.

### Decky `Focusable` callbacks (reference)

| Callback | Typical use |
|----------|-------------|
| `onMoveUp` / `onMoveDown` | Vertical graph edges (Pattern A) |
| `onMoveLeft` / `onMoveRight` | Horizontal rows, tabs, chip strips |
| `onOKButton` / `onButtonDown` | A button / activate |
| `onCancelButton` | B / back, close modal |

Return `true` when the callback handled the event so propagation stops.

### Anti-patterns

- Assuming React render order equals focus order
- `window.addEventListener("keydown")` as the primary D-pad path
- Adding a control without updating the parent section graph

### Related

- Skill: `.cursor/skills/decky-ui-change-focus-gate/SKILL.md` — mandatory gate before shipping UI changes
- Skill: `.cursor/skills/decky-focus-audit/SKILL.md` — static + preview audit pass
