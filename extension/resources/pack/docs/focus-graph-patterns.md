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

## Nothing owns focus when your plugin opens

Measured on a live Deck, 2026-08-26, and confirmed against a second unrelated plugin, so this
is Decky/Steam behaviour rather than any one plugin's bug.

When a plugin is opened from the Decky list, it mounts and renders — and **no element owns
gamepad focus**. In one measurement: 67 `.Focusable` elements present, zero carrying
`gpfocus`, and `document.activeElement` on `<body>`. The next D-pad press re-acquires focus
instead of moving it, so the user's first press is swallowed. Leaving a plugin with B lands in
the same state.

The next press lands on the plugin's topmost control (the Back button), so nothing is broken
and no press is wasted — this is simply where every Decky plugin starts.

**You usually want to leave this alone.** Grabbing focus on mount makes your plugin behave
differently from every other one, and users navigate across plugins by habit. Only place focus
yourself if the ring genuinely needs to start somewhere specific — an ask bar, a primary
action — because nothing else will put it there.

**If you write tooling** that drives the D-pad, do account for it: read focus before the first
press rather than assuming it moves something.

Full measurement and the control experiment: `docs/planning/03-plugin-open-leaves-focus-unowned.md`.

## The `activeElement` trap

**Steam's gamepad focus and the browser's `document.activeElement` are two different things,
and on Deck they routinely disagree.**

Steam writes the classes `gpfocus` and `gpfocuswithin` onto the element its nav graph
currently owns. That is the real answer to "what is focused". `document.activeElement` is the
browser's own idea of focus, and it is not what Steam routes presses to.

This is worth naming rather than filing under "gotchas", because **it fails in the direction
that looks like success**. A focus check written against `activeElement` reports moves that
never happened. bonsAI shipped three separate "fixed" releases against this trap - each one
verified with `activeElement`, each one changing nothing on the device.

**What to do instead**

- To *move* focus: register the element when it is created, and focus the registered owner.
- To *verify* focus: read `gpfocus`. Never `activeElement`.

`deck_readFocus` (Decky Plugin Studio) reads this over CDP and returns both, plus an `agree`
flag. When `agree` is `false`, any assertion you were about to make on `activeElement` would
have been wrong.

**Where the marker actually lives.** Measured against a live Deck on Steam CEF
126.0.6478.183: the marker is in the **QuickAccess** CEF target. `SharedJSContext` holds
about 15 elements and never carries it. A plugin's focus sits under
`quickaccess_content_999`; Steam's own Quick Access tabs are 0 and 3-7.

## Anti-patterns (all patterns)

| Anti-pattern | Do instead |
|--------------|------------|
| Assume React / DOM order equals focus order | Explicit section-parent graph (Pattern A) or registered owners (Pattern D) |
| `window` / capture-phase `keydown` as primary D-pad path | Decky `Focusable` `onMove*` / `onOKButton` / `onButtonDown` |
| Add a control without updating the parent section graph | Extend the section stop list and parent `onMove*` edges |
| Sibling/column hops via `querySelector` / `aria-label` / `data-*` / class discovery | Mount-time callback refs / registry of focus owners |
| Gate `onMove*` success on `document.activeElement` | Return `true` once the registered owner is focused; do not require `activeElement` proof - see [The `activeElement` trap](#the-activeelement-trap) |
| Cross-column fallbacks when primary lookup “missed” | Only hop to the registered neighbor; never claim a wrong-column focus as success |
