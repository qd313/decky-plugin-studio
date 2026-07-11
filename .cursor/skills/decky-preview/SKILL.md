---
name: decky-preview
description: >-
  Drive the Decky Plugin Studio in-IDE preview for fast iteration. Use when
  developing UI/focus behavior, testing hardware simulator scenarios, or
  verifying state preservation across HMR. Covers preview.start/stop/status,
  preview.injectFocusEvent, preview.setHardware, preview.runSequence,
  preview.callRpc, and preview.readLog MCP tools.
---

# Decky preview (Decky Plugin Studio)

> **Very much beta** — fast UI/RPC iteration only. Focus, layout, and Steam Input need `deck.deploy` + on-device QA.

## When to use

- Iterating on `@decky/ui` components without full build/deploy/Steam loop
- Verifying D-pad focus paths after refactors
- Testing plugins that read hardware telemetry or call local Ollama
- Scripted regression via `preview.runSequence`

## Input paths

Manual focus testing (all post into the same `decky-focus` bridge):

- **Keyboard** — arrows, Enter (A), Escape (B) while preview panel focused
- **Virtual gamepad** — on-screen buttons in the preview panel
- **Physical controller** — connect Xbox/DirectInput pad; enable **Use physical controller**; keep preview panel focused

MCP `preview.injectFocusEvent` and `preview.runSequence` reach the live preview when **Decky: Open Preview** is running (IPC via `~/.decky-plugin-studio/preview-ipc/`).

## Workflow

1. **Start preview** — `preview.start` or VSIX command `Decky: Open Preview`
2. **Check status** — `preview.status` returns running state, preview URL, hwState
3. **Simulate hardware** — `preview.setHardware({ cpuTemp: 85, battery: 8, preset: "Hot Game" })`
4. **Drive focus** — physical D-pad, keyboard, virtual pad, `preview.injectFocusEvent("Right")`, or `preview.runSequence({ inputs: ["Right","Down","A"], delayMs: 80, snapshot: "dom" })` (requires preview open)
5. **Backend RPC** — `preview.callRpc("method_name", [arg1, arg2])`
6. **Logs** — `preview.readLog({ lines: 50 })`

## runSequence result fields

- `focusPath` — ordered list of focus callbacks fired
- `activeElement` — selector chain for final focus
- `domSnapshot` — serialized QAM frame HTML (trimmed)
- `logTail` — recent plugin.log lines during the sequence

## Limitations

Preview mocks `@decky/api` and `@decky/ui`. Physical gamepad requires a user gesture in the preview webview (press any button after focusing the panel). Steam Input chord actions are not mapped. Tricky CEF focus bugs still need on-device QA via `deck.deploy` and the **master-debugger** persona.
