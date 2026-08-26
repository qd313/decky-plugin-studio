# Preview limitations (v0.3)

Decky Plugin Studio preview is **very much beta** — useful for **fast iteration**, not a replacement for on-device QA.

## What works well

- React/TS UI layout and text
- `@decky/api` `call()` RPC to your real `main.py` (via Python sidecar; **RPC discovery** from `main.py`)
- Focus-graph simulation via keyboard, virtual gamepad, **physical gamepad (W3C Gamepad API)**, and `preview.runSequence`
- Hardware telemetry reads (sysfs/hwmon/psutil intercept → simulator sliders)
- Local Ollama at `127.0.0.1:11434` (HTTP allowlist via `preview.setHttpAllow`)
- Python state preservation across sidecar restarts (JSON-serializable attrs)
- Automated scenarios via `scripts/run-preview-suite.mjs` + `preview.callTestHook`
- **Visual regression (coarse)** via `preview.compareScreenshot` and suite `compareScreenshot` steps (html2canvas — not pixel-perfect)
- **Streaming RPC (experimental)** via sidecar `decky.emit`, `preview.tailEmit`, and `preview.callRpc` with `collectEmitsMs`

## What is approximate or missing

| Area | Preview behavior |
|------|------------------|
| `deck.openPlugin` on device | MCP returns a manual checklist only — no Steam/QAM automation |
| Steam CEF focus graph | Approximated via `Focusable` message bridge |
| `@decky/ui` styling | Mock components on a shared SteamOS token set — close in palette and geometry, still not pixel-perfect Steam |
| Gamescope / QAM compositing | Device-accurate geometry only — a 400px flyout on a 1280x800 stage. Real gamescope composition still needs `deck.captureScreenshot`. |
| TDP / sysfs writes | Logged and mocked success |
| Physical gamepad (USB/BT) | W3C standard layout when preview panel focused |
| Steam Input chords | Not simulated — on-device QA required |
| Decky permissions | **Simulator** via `preview.setPermissions` / `.decky/preview.json` (approximation) |
| Real Deck loopback networking | N/A — preview runs on dev machine |

## Focus: what preview cannot tell you

Preview renders your plugin in a browser. A browser has `document.activeElement`; it does not
have Steam's gamepad nav graph. Preview can show you that a handler *ran*. It cannot show you
where Steam would actually put the highlight.

That gap is the `activeElement` trap, explained in full in
[focus-graph-patterns.md](../pack/docs/focus-graph-patterns.md#the-activeelement-trap). The
short version: a focus check written against `activeElement` reports moves that never
happened, and it fails in the direction that looks like success.

So treat "focus moved to the right control" as **`deck-only`**. On device, **`deck_readFocus`**
reads Steam's own `gpfocus` marker over CDP and tells you whether it agrees with
`activeElement`.

## Deck-only QA bucket

Some scenarios cannot run in preview (Steam Input chords, gamescope capture, in-game overlay). Tag them **`deck-only`** in `tests/preview-suite/` and run via:

1. `deck.deploy`
2. On-device checklist in [device-qa-runbook.md](device-qa-runbook.md)
3. `deck.captureScreenshot` / **decky-screenshot-ingest** skill

Template: `tests/preview-suite/deck-only.json` (after Init Pack).

## When to deploy to Deck

Use **`deck.deploy`** or **`Decky: Deploy to Deck`** before merging changes that touch:

- D-pad routing edge cases (modals, nested focus, tab restore)
- Clipping/geometry inside real Steam chrome
- Screenshot/vision capture
- Privileged sysfs writes

Invoke the **decky-debugger** subagent for on-device ingest/tunnel workflows.

## Steam Input / native controller bridge (deferred)

Phase 1 uses the browser **Gamepad API** inside the VS Code preview webview. That covers most XInput/DirectInput pads (Xbox, DualSense, Switch Pro in PC mode) when Steam exposes a standard virtual gamepad.

**Not covered without a native bridge:**

- Steam Input **chord** actions (Steam+QAM, L4/R4 combos)
- Deck-specific back-button semantics when Steam remaps away from W3C button indices
- Input when the preview webview is unfocused (by design — avoids fighting IDE shortcuts)

**Future options if W3C mapping is insufficient:**

1. Force a generic XInput desktop configuration in Steam Input for dev
2. Native HID/SDL reader in the extension host mapping raw reports → `decky-focus` directions
3. On-device QA via `deck.deploy` for true Steam Input behavior
