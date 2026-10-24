---
name: decky-focus-audit
description: >-
  Static focus audit for Decky plugins: Focusable callbacks vs DOM keydown,
  modal cancel/OK, plugin.lintFocus evidence. Escalate on-device issues to decky-debugger.
  Use before merging navigation-heavy UI or when reviewing D-pad routing.
---

# Decky focus audit

## When to use

- New modals, tabs, nested focus, or settings panels
- PR touches `Focusable`, `onMoveLeft`/`onMoveRight`, or footer buttons
- Static checks pass but navigation feels wrong

## Static pass (repo)

Search `src/` for anti-patterns:

| Anti-pattern | Prefer |
|--------------|--------|
| `window.addEventListener("keydown"` as primary D-pad | `Focusable` `onMove*` / `onOKButton` |
| `modal.contains(activeElement)` gating alone | Ancestor walk from known shell ref |
| `el.style.*` via ref on React-managed nodes | CSS vars on scope root + `!important` rules |

Confirm every interactive control is reachable via focus-graph callbacks.

## Lint evidence

Run **`plugin.lintFocus`** and record every finding (one-way moves, unreachable controls, DOM keydown routing).

## On-device

Only the Deck shows real Steam Input chords and CEF focus. After the static pass:

1. **`deck.deploy`**
2. **`deck.openPlugin`** — opens the panel by driving the Deck
3. **`deck.readFocus`** / **`deck.assertFocusMove`** for where the ring really goes
4. **`deck.captureScreenshot`** or **decky-screenshot-ingest** for evidence

## Escalation

| Finding | Route to |
|---------|----------|
| Design-time graph gaps (new modal flow) | **decky-focus-architect** |
| Runtime bug with logs/measurements | **decky-debugger** |
