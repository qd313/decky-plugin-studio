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

## Pattern D — Explicit column hops (2×2 / non-DOM-order vertical)

**Use when:** a grid or multi-column control set (e.g. 2×2 action buttons) must preserve **column** on Up/Down and **row** on Left/Right, and DOM/tab order alone would produce diagonal or wrong-column hops under Steam spatial nav.

**ALWAYS / NEVER:**

NEVER implement Decky D-pad sibling or column hops by discovering targets with `document.querySelector` / `aria-label` / `data-*` / class probes, or by treating `document.activeElement` as proof that focus moved. On Deck those lookups repeatedly miss even when the controls are on-screen, and returning `false` from `onMove*` then lets Steam spatial nav steal the hop (wrong diagonal). ALWAYS register the mounted Deck focus-owner nodes at render time (callback refs / a small registry) and hop between those registered owners; return `true` from `onMove*` once the target is registered so Steam spatial nav cannot steal the move.

### Wiring checklist

1. **Register owners at mount** — callback refs (or a tiny registry) capture the live Deck focus-owner DOM nodes for each cell as they mount; clear on unmount.
2. **Hop by registry key** — `onMoveUp` / `onMoveDown` / `onMoveLeft` / `onMoveRight` resolve the neighbor from the registry, call `.focus()` on that owner, and return `true` when the target is registered.
3. **Do not invent lookup APIs** — no `querySelector`, no `aria-label` / `data-*` / class sibling discovery, no success gate on `document.activeElement`.
4. **No cross-column fallbacks** — if the column neighbor is not registered yet, do not “succeed” by focusing another column; leave the hop unclaimed or wait for mount rather than masking a miss.

### Why DOM probes fail on Deck

| Assumption | What actually happens |
|------------|------------------------|
| `aria-label` finds the `Button` | Decky often parks aria on a wrapping `Panel`, not the button |
| `data-*` on Decky `Button` lands in DOM | Attributes are frequently stripped |
| `className` + `querySelector` finds live nodes | Lookups return miss even when class strings exist in the bundle |
| `focusDeckOwner` + `activeElement` proves the hop | Gate returns `false` → Steam spatial nav continues (wrong diagonal) |
| Cross-column fallback when primary “missed” | Masks failure into wrong-column “success” |

### Related

- Skill: `.cursor/skills/decky-ui-change-focus-gate/SKILL.md` — mandatory gate before shipping UI changes
- Skill: `.cursor/skills/decky-focus-audit/SKILL.md` — static + preview audit pass

## Anti-patterns (all patterns)

| Anti-pattern | Do instead |
|--------------|------------|
| Assume React / DOM order equals focus order | Explicit section-parent graph (Pattern A) or registered owners (Pattern D) |
| `window` / capture-phase `keydown` as primary D-pad path | Decky `Focusable` `onMove*` / `onOKButton` / `onButtonDown` |
| Add a control without updating the parent section graph | Extend the section stop list and parent `onMove*` edges |
| Sibling/column hops via `querySelector` / `aria-label` / `data-*` / class discovery | Mount-time callback refs / registry of focus owners |
| Gate `onMove*` success on `document.activeElement` | Return `true` once the registered owner is focused; do not require `activeElement` proof |
| Cross-column fallbacks when primary lookup “missed” | Only hop to the registered neighbor; never claim a wrong-column focus as success |
