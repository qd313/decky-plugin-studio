---
name: decky-ui-change-focus-gate
description: >-
  Mandatory D-pad focus check on every Deck UI change. Invoke before marking done on
  component, focus-graph, or QAM/Settings control work. Requires on-Deck verification;
  preview mocks do not validate focus graphs.
---

# UI change focus gate (MANDATORY)

## When this workflow applies — EVERY time

Invoke before marking **done** on any change that touches:

- `src/components/**` (main tab, settings, modals, transcripts, spoilers, branches, reply actions)
- `src/utils/build*Element.tsx`, `*FocusGraph.ts`, `*Navigation.ts`, `*Scroll.ts` (plugin-specific examples)
- New `Focusable`, `Button`, `ToggleField`, `DeckFocusSlider`, or `PanelSectionRow` in QAM/Settings

**No exceptions** for "small" or "cosmetic" UI edits.

## Pre-ship checklist (agent must complete)

1. **Enumerate focus stops** in document order for the affected section.
2. **Wire explicit graph** at section parent per [Pattern A](docs/focus-graph-patterns.md) (section parent owns `onMoveUp` / `onMoveDown`).
3. **Every Decky Button** that must be D-pad reachable: `focusable` + `onMoveUp` / `onMoveDown` + `onButtonDown` for A/activate.
4. **Sliders / spoilers:** bridge `Focusable` or proven parent-ref pattern — never assume DOM order.
5. **Column/sibling hops:** must use mount-time refs / a focus-owner registry ([Pattern D](docs/focus-graph-patterns.md)). **Fail the gate** if the change discovers D-pad targets with `querySelector` / `aria-label` / `data-*` / class probes, or gates `onMove*` on `document.activeElement`.
6. **Add/update** `docs/testing.md` D-pad row (or the project's prompt-testing doc).
7. **On-Deck verify** via `deck.deploy` — preview mocks do **not** validate focus graphs.
8. **Scroll behavior:** if touching answer bubbles or tab scroll, verify D-pad scroll is smooth.

## If you only changed copy/CSS

Still run steps 1–2 mentally: did layout change focus order or clip focusable children?

## Triage prompt

Invoke the **decky-ui-focus-gate** subagent (`.cursor/agents/decky-ui-focus-gate.md`) before marking done on any Deck UI edit. It runs this checklist as triage-only verification — use the subagent when you need an explicit gate pass/fail, not just a self-check.

Source triage id: `bonsai/triage/ui-change-focus-gate`

## Related skills

| Need | Skill |
|------|-------|
| Pre-ship gate pass/fail (triage-only) | **decky-ui-focus-gate** (subagent) |
| Static anti-patterns + preview evidence | **decky-focus-audit** |
| Design-time graph before implementation | **decky-focus-architect** (subagent) |
| Runtime focus bug with logs | **decky-debugger** (subagent) |
| Deploy + open plugin on Deck | **decky-dev-loop** |

## Appendix: example focus chain (plugin-specific)

One real plugin's "live turn" reply section — use as a template when enumerating stops, not as a universal order:

turn header → answer bubble → spoiler reveal → strategy branches → checklist → thumbs → chip rows → utility → context strip
