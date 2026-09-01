# Decky Plugin Studio — MCP tool reference

For installing or building the extension, see [DEVELOPMENT.md](DEVELOPMENT.md).

> **Preview:** `preview.*` tools drive the in-IDE QAM preview, which is **very much beta**. Use `deck.deploy` + on-device QA for focus, layout, and Steam Input.

## Workspace config

Plugin repos may include [`.decky/preview.json`](../pack/.decky/preview.json):

| Field | Purpose |
|-------|---------|
| `rpcMode` | `discover` (default), `allowlist`, or `dev` |
| `rpcAllowlist` | Extra allowed RPC methods |
| `rpcDenylist` | Always blocked (`_main`, `_unload`, …) |
| `ipcTimeoutMs` | IPC wait for snapshot/RPC (default 120000) |
| `preDeployCommand` | Shell command before `deck.deploy` |
| `panelRootSelector` | CSS selector your panel renders at its root (e.g. `.my-plugin-scope`). Lets `deck.openPlugin` tell "my panel is open" from "my name is a row in Decky's plugin list" |
| `permissions` | Preview permission simulator map |

## deck.*

- **deck.configure** — `{ ip?, user?, port?, ingestPort? }`
- **deck.status** — tunnel, ingest, deck, ollama state
- **deck.startTunnel** / **deck.stopTunnel**
- **deck.probeIngest** / **deck.tailIngest** — `{ since?, lines?, hypothesisId? }`
- **deck.captureScreenshot** — `{ mode?: "auto"|"game"|"desktop", allowNonPluginUi?: boolean }`  
  Returns `{ path, bytes, mode, method }`. Composited methods preferred (`gamescope-atom`, `grim`). Open QAM + plugin first.
- **deck.record** — `{ seconds?, mode?, quality?: "compressed"|"full", allowNonPluginUi?: boolean }`  
  Returns `{ path, bytes, mode, method, seconds }`. Requires composited `pipewire-gamescope` or `wf-recorder` unless `allowNonPluginUi`. Artifacts: `<workspace>/recordings/`.
- **deck.installCaptureHelper** — `{ which?: "record"|"capture"|"both" }` — installs `studio-record` / `studio-capture` on Deck `~/.local/bin` (remote SSH only).
- **deck.deploy** — `{ mode?: "auto"|"local"|"remote" }` — unified copy manifest + retry
- **deck.reloadPlugin** — `{ mode?: "auto"|"local"|"remote" }` — restart `plugin_loader` without redeploy
- **deck.openPlugin** — `{ pluginName?, drive?, rootSelector?, tabBudget?, listBudget? }` — drives Steam through the bridge to open the panel, verifying each stage against a live focus read. Set `rootSelector` (or `panelRootSelector` in `.decky/preview.json`) so "already open" is decided by your own markup rather than inferred from Decky's pane labels — the list advertises every installed plugin's name, so without it an unmounted panel can read as open. `drive: false` returns the manual checklist only.
- **deck.readPluginLog** — `{ lines?, filter? }` — tail `plugin_loader` journal via SSH/local shell; filter applied in-process (not shell)
- **deck.getEnv** — workspace, deck config, tunnel, plugin detect, optional remote SteamOS probe

### Focus rig (on-device, bridge board + CDP)

Every focus read answers **two** questions: *where is the ring* (`gpfocus`) and *could a person
see it* (`visibility`). They are different facts — a control focused behind a bottom-pinned dock
has the right selector, label and rect and is still invisible — and until 2026-08-31 the rig
measured only the first.

- **deck.readFocus** — `{ cdpUrl? }` → `{ ok, gpfocus, visibility, scrollPane, gpfocusWithin, activeElement, agree, quickAccessTab, visibleQuickAccessTab, … }`
  - `visibility` — `{ verdict: "visible"|"partial"|"covered"|"offscreen", visiblePercent: 0–100, coveredBy, clippedBy, points: { visible, covered, clipped, offscreen } }`. A 3×3 grid of points across the focused rect, each put through `document.elementFromPoint`: the element or a descendant is *visible*; another element on top is *covered* (`coveredBy` names it, e.g. `div.bonsai-main-tab-dock > button.Focusable.bonsai-chip`); an ancestor is *clipped* (nothing on top — an overflow clip, reported under `offscreen`, `clippedBy` names it); off the viewport is *offscreen*. `elementFromPoint` skips `pointer-events: none`, so decorative scrims are not coverers and no plugin's dock is special-cased. It is a DOM hit-test, not eyes: wrong colours and compositing artifacts still need a screenshot or a human. `null` when nothing owns the ring.
  - `scrollPane` — `{ selector, scrollTop, scrollHeight, clientHeight }` of the nearest scrolling ancestor, or `null`.
- **deck.assertFocusMove** — `{ press, expect?, holdMs?, settleTimeoutMs?, port?, cdpUrl? }` — press, then read until focus stops changing; `moved` and `matched` reported separately.
- **deck.walkTo** — `{ direction, text, exact?, budget?, stallLimit?, acquireFocus?, port?, cdpUrl? }` — direction presses only, never A/B/START. Returns `found`, `matched`, `seen`, `stalled`, `overshot`, and **`visibility`** for the stop it ended on; `found: true` with a verdict other than `visible` is shouted in `summary` (`found after 3 press(es): <BUTTON> "Show details", but COVERED by …`).
- **deck.runSequence** — `{ steps: [{ press, expect?, label?, requireVisible?, … }], stopOnFailure?, mustReachText?, requireVisible?, runName?, writeEvidence?, acquireFocus?, port?, cdpUrl? }` — one tunnel, cycle detection, evidence file under `runs/`. Each step now carries `visibility` / `visible`; the result carries `stopsFocusedButNotVisible` (the starting read counted) and `notVisibleStops`. **`requireVisible` fails a step the way `expect` does — default `false` for this release (report-only: measured, counted, shouted, not failed); it flips to fail-by-default next release.**
- **deck.sweep** — `{ direction?: "DOWN", returnTrip?: true, lanes?: 0, laneButton?: "RB", budget?: 80, stallLimit?: 2, acquireFocus?, runName?, writeEvidence?, port?, cdpUrl? }` — free play, scripted: walk `direction` until the ring stops or cycles, walk back, optionally repeat per carousel lane via LB/RB. Direction presses and LB/RB only, never A/B/START. Records at **every** stop: `label`, `selector`, `rect`, pane `scrollTop`, `visibility`. Writes `runs/<runName|sweep_<ts>>.json` containing exactly `{ tool, pattern, ok, reason, stopped, totals, notVisible, legs, stops }` — nothing clock-dependent — so a consumer commits a baseline (`runs/sweep-main-tab.expected.json`) and QA becomes *sweep → diff*. `totals` = `{ stopsRecorded, stopsVisited, unlabeledStops, cycles, stopsFocusedButNotVisible, presses, legs }`; read `stopsFocusedButNotVisible` first. The tool result adds `summary`, `durationMs`, `evidenceFile`, `fidelity`, `acquired`, `pressRetries`. Measured on bonsAI's Main tab: 38 rows in 41 presses (~27 s); two back-to-back runs differed by one byte, a 1px rect jitter on an animated chip — diff `totals`, labels and verdicts before rects.
- **deck.pressButton** — `{ buttons, holdMs?, port? }` — raw bridge press; refuses without the board. Retries once, after 350 ms, on exactly one failure — the serial port held by another opener (`PermissionError` on COM open) — and reports `retried: true`; every other failure is a refusal.
- **deck.readPage** / **deck.waitFor** — evaluate an expression in the plugin's page (read, do not drive).
- **deck.stopAutomation** / **deck.automationStatus** — the killswitch; re-arming is not a tool.

### Capture environment

| Variable | Purpose |
|----------|---------|
| `DECKY_STUDIO_WORKSPACE` | Plugin workspace root (artifacts, cwd) |
| `DECKY_STUDIO_ALLOW_STEAMOS_RW` | Set `0` to skip optional pacman/steamos-readonly on Deck |
| `BONSAI_ALLOW_STEAMOS_RW` | Legacy alias (still read) |

## plugin.*

- **plugin.detect** / **plugin.build** / **plugin.verifyZip**
- **plugin.diffRpc** — `{ backendOnly, frontendOnly, matched, previewDenied? }` from `main.py` vs `src/` `call()` sites

## preview.*

- **preview.start** / **preview.stop** / **preview.status**
- **preview.health** — preview open + IPC readiness
- **preview.injectFocusEvent** — `{ direction }`
- **preview.setHardware** — partial hardware state
- **preview.runSequence** — `{ inputs, delayMs?, hwOverrides?, snapshot? }`
- **preview.callRpc** — `{ method, args?, collectEmitsMs? }` — discovery-based allowlist; optional emit collection window
- **preview.tailEmit** — `{ since?, lines?, event? }` — tail sidecar `decky.emit` log (`emit-log.jsonl`)
- **preview.callTestHook** — `{ method, args? }` — `window.__deckyPreviewTestHooks`
- **preview.snapshotDom** — `{ selector? }`
- **preview.captureScreenshot** — `{ selector? }` → `screenshots/preview/`
- **preview.compareScreenshot** — `{ name, selector?, threshold?, updateBaseline? }` — vs `tests/preview-baselines/<name>.png`
- **preview.setHttpAllow** — `{ allowlist }`
- **preview.setPermissions** — `{ permissions: { hardware_control: false, … } }`
- **preview.readLog** — `{ lines? }`

## Preview test suite

After **Decky: Init Pack** and **Decky: Open Preview**:

```bash
node scripts/run-preview-suite.mjs --tier=smoke
node scripts/run-preview-suite.mjs --update-baselines   # refresh preview-baselines/
```

See [device-qa-runbook.md](../docs/device-qa-runbook.md).

## Skills and agents (Init Pack)

| Skill / agent | MCP tools used |
|---------------|----------------|
| **decky-onboard** | `deck.configure`, `plugin.detect`, `plugin.build`, `deck.deploy`, `deck.openPlugin` |
| **decky-release** | `plugin.build`, `plugin.verifyZip`, `plugin.diffRpc`, `deck.deploy` |
| **decky-focus-audit** | `preview.runSequence`, `preview.compareScreenshot`, `deck.captureScreenshot` |
| **decky-debugger** | `deck.tailIngest`, `deck.readPluginLog`, `deck.reloadPlugin` |
| **decky-focus-architect** | design-time; validates with preview + device QA |
