---
name: decky-focus-audit
description: >-
  Static and preview focus audit for Decky plugins: Focusable callbacks vs DOM keydown,
  modal cancel/OK, preview.runSequence evidence. Escalate on-device issues to decky-debugger.
  Use before merging navigation-heavy UI or when reviewing D-pad routing.
---

# Decky focus audit

## When to use

- New modals, tabs, nested focus, or settings panels
- PR touches `Focusable`, `onMoveLeft`/`onMoveRight`, or footer buttons
- Preview smoke passes but navigation feels wrong

## Static pass (repo)

Search `src/` for anti-patterns:

| Anti-pattern | Prefer |
|--------------|--------|
| `window.addEventListener("keydown"` as primary D-pad | `Focusable` `onMove*` / `onOKButton` |
| `modal.contains(activeElement)` gating alone | Ancestor walk from known shell ref |
| `el.style.*` via ref on React-managed nodes | CSS vars on scope root + `!important` rules |

Confirm every interactive control is reachable via focus-graph callbacks.

## Preview evidence

With **Decky: Open Preview** open:

1. **`preview.runSequence`** — record `focusPath` after Down/Right sequences.
2. **`preview.snapshotDom`** — confirm `activeElement` matches expected control.
3. **`preview.compareScreenshot`** — coarse layout regression vs `tests/preview-baselines/` when baselines exist.

```bash
node scripts/run-preview-suite.mjs --filter=focus
```

## On-device

Preview cannot reproduce Steam Input chords or real CEF focus. After static + preview passes:

1. **`deck.deploy`**
2. **`deck.openPlugin`** checklist
3. **`deck.captureScreenshot`** or **decky-screenshot-ingest** for evidence

## Escalation

| Finding | Route to |
|---------|----------|
| Design-time graph gaps (new modal flow) | **decky-focus-architect** |
| Runtime bug with logs/measurements | **decky-debugger** |
