---
name: decky-preview
description: >-
  Drive the Decky Plugin Studio in-IDE preview for fast iteration. Use when
  developing UI/focus behavior, testing hardware simulator scenarios, or
  verifying state preservation across HMR. Covers preview.start/stop/status/health,
  preview.injectFocusEvent, preview.setHardware, preview.runSequence,
  preview.callRpc, preview.callTestHook, preview.snapshotDom,
  preview.captureScreenshot, preview.setHttpAllow, preview.setPermissions,
  and preview.readLog MCP tools.
---

# Decky preview (Decky Plugin Studio)

> **Very much beta** — fast UI/RPC iteration only. Focus, layout, and Steam Input need `deck.deploy` + on-device QA.

## When to use

- Iterating on `@decky/ui` components without full build/deploy/Steam loop
- Verifying D-pad focus paths after refactors
- Testing plugins that read hardware telemetry or call local Ollama
- Scripted regression via `preview.runSequence` or `scripts/run-preview-suite.mjs`

## Input paths

- **Keyboard** — arrows, Enter (A), Escape (B) while preview panel focused
- **Virtual gamepad** — on-screen buttons in the preview panel
- **Physical controller** — W3C Gamepad API when preview panel focused

## Workflow

1. **Start preview** — `preview.start` or **Decky: Open Preview**
2. **Preflight** — `preview.health` (or suite runner checks IPC)
3. **Simulate hardware** — `preview.setHardware({ cpuTemp: 85, preset: "Hot Game" })`
4. **Drive focus** — `preview.injectFocusEvent("Right")` or `preview.runSequence({ inputs: ["Right","A"], delayMs: 80 })`
5. **Backend RPC** — `preview.callRpc("method_name", [args])` (discovered from `main.py`)
6. **Test hooks** — `preview.callTestHook("setTab", ["settings"])` via `window.__deckyPreviewTestHooks`
7. **Inspect** — `preview.snapshotDom({ selector })`, `preview.captureScreenshot({ selector })`
8. **Permissions** — `preview.setPermissions({ hardware_control: false })`
9. **HTTP** — `preview.setHttpAllow("host:port,...")`
10. **Logs** — `preview.readLog({ lines: 50 })`

## Config

Workspace [`.decky/preview.json`](../../.decky/preview.json): `rpcMode`, `ipcTimeoutMs`, `permissions`, `preDeployCommand`.

## Limitations

See [PREVIEW_LIMITATIONS.md](../../../docs/PREVIEW_LIMITATIONS.md). On-device QA: `deck.deploy` + **master-debugger**.
