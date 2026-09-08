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
- **deck.status** — tunnel, ingest, deck, ollama state, `automationArmed`, and bridge state as **`bridgePortOpen`**. `bridgePortOpen` says only what it measures: the serial port opened and the firmware acked. It is **not** a claim that the board's other USB lead reaches the Deck — with that lead unplugged this still reads `true` (measured 2026-08-27). **`bridgeReady` remains as a deprecated alias** carrying the identical value, because a live consumer reads it; prefer `bridgePortOpen` in new code.
- **deck.startTunnel** / **deck.stopTunnel**
- **deck.probeIngest** / **deck.tailIngest** — `{ since?, lines?, hypothesisId? }`
- **deck.captureScreenshot** — `{ mode?: "auto"|"game"|"desktop", allowNonPluginUi?: boolean }`  
  Returns `{ path, bytes, mode, method, image }` **and an MCP `image` content block beside the JSON text block**, so a model can actually see the picture instead of being handed a filename it cannot open. Images over ~1.5 MB of base64 are downscaled (nearest-neighbour, 25% steps, 240px floor) rather than dropped; if one is dropped or unreadable anyway, the `image` field in the text block says so — the text never lets a caller believe it received a picture it did not. Composited methods preferred (`gamescope-atom`, `grim`). Open QAM + plugin first.
- **deck.record** — `{ seconds?, mode?, quality?: "compressed"|"full", allowNonPluginUi?: boolean }`  
  Returns `{ path, bytes, mode, method, seconds }`. Requires composited `pipewire-gamescope` or `wf-recorder` unless `allowNonPluginUi`. Artifacts: `<workspace>/recordings/`.
- **deck.installCaptureHelper** — `{ which?: "record"|"capture"|"both" }` — installs `studio-record` / `studio-capture` on Deck `~/.local/bin` (remote SSH only).
- **deck.deploy** — `{ mode?: "auto"|"local"|"remote", waitForLoader?: boolean, loaderTimeoutMs?: number }` — unified copy manifest + retry. After the loader restart it waits (default on, 30 s bound) until `plugin_loader` is active and Steam's UI pages are listed over CDP, and reports the wait in `loader`; `loader.ready: false` means the deadline passed and the next `deck.*` call may still land in the restart.
- **deck.reloadPlugin** — `{ mode?: "auto"|"local"|"remote", waitForLoader?: boolean, loaderTimeoutMs?: number }` — restart `plugin_loader` without redeploy; same post-restart wait and `loader` block as `deck.deploy`
- **deck.openPlugin** — `{ pluginName?, drive?, rootSelector?, tabBudget?, listBudget? }` — drives Steam through the bridge to open the panel, verifying each stage against a live focus read. Set `rootSelector` (or `panelRootSelector` in `.decky/preview.json`) so "already open" is decided by your own markup rather than inferred from Decky's pane labels — the list advertises every installed plugin's name, so without it an unmounted panel can read as open. `drive: false` returns the manual checklist only. Safe straight after `deck.deploy`: the first read waits out the loader restart, and the QAM open chord (a toggle) is fired only on the Quick Access page's own report that the menu is shut (`probe-qam` stage), never on a null read from another page.
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
- **deck.pressButton** — `{ buttons, holdMs?, port?, verify?, cdpUrl?, verifySettleMs? }` — raw bridge press; refuses without the board. **A list of buttons is a SIMULTANEOUS press (one HID report), not a chord**: `[GUIDE, A]` that way is a bare GUIDE to Steam — the main menu opens and the A lands in whatever it shows (measured 2026-08-26). Use `deck.pressChord` for hold-then-tap. Retries once, after 350 ms, on exactly one failure — the serial port held by another opener (`PermissionError` on COM open) — and reports `retried: true`; every other failure is a refusal.  
  **Fidelity is earned, not assumed.** A plain press reports `fidelity: "wire-sent"` — the firmware acked the command, and that is the *only* thing an ack proves. It says nothing about whether the Deck received anything: with the board's Deck-side USB lead unplugged the ack still arrives (measured 2026-08-27, when every layer reported success and nothing happened). `fidelity: "steam-routed"` is no longer reachable that way — pass `verify: true` to earn it, which reads Steam's gamepad focus over CDP before and after the press and reports `steam-routed` only when that focus actually changed, `wire-sent` with an honest reason when it did not. It costs a CDP round trip, so it is opt-in. Known limit, shared with `deck.assertFocusMove`: a focus diff cannot tell "the board is unplugged" from "the press landed on a control that legitimately did not move focus."
- **deck.pressChord** — `{ hold, tap, port? }` — hold one button, tap another, release: the real chord, four HID reports in sequence. `hold: "GUIDE", tap: "A"` is the Quick Access Menu toggle. Same refusals as `deck.pressButton`. Prefer `deck.openPlugin` when the goal is the panel — it asks the Quick Access page whether the menu is already open before toggling it.
- **deck.launchGame** — `{ name? | appid?, budget?: 40, waitMs?: 60000, runName?, writeEvidence?, port?, cdpUrl? }` — starts a game by pressing what a thumb would: GUIDE → *Home* → RIGHT along the Recent Games shelf → A on the tile → A on *Play*, each stage verified by a read before the next press (`RunningApps` and the library first, zero presses; the tile by the app id in its own `<img src>`, never its text; the button by the exact label `Play`; the launch by the app id appearing in `RunningApps`, under a second on device). Refuses before pressing: neither or both of `name`/`appid`; a *different* game running (named, with a pointer at `deck.exitGame` — never a second game); an ambiguous name (candidates listed); an uninstalled game; an app page showing *Install / Update / Buy / Pre-load / Pre-purchase / Purchase / Add to Cart / Download*; a game not on the shelf (v1: play it once by hand, or extend to the Library grid). `alreadyRunning: true` with zero presses when it is up already. Result in the shape of `deck.openPlugin`'s — `{ ok, appid, name, alreadyRunning?, running, route, stages, seen, presses, fidelity, stopped, reason?, checklist?, evidenceFile, summary }` — and `runs/<runName|launch-game_<ts>>.json` holds the stages, the controls seen, `RunningApps` before and after, and the duration. Leaves the ring where Steam puts it (route `/apprunning`); `deck.openPlugin` gets the panel back, over the running game.
- **deck.exitGame** — `{ waitMs?: 60000, runName?, writeEvidence?, port?, cdpUrl? }` — GUIDE (the menu opens on the game's own entry) → RIGHT (*Resume game*) → DOWN to the exact *Exit game* → A → A on *Confirm* only when a read shows the ring on it; anything else on the ring is a refusal that reports the game still running. Done when the app id leaves `RunningApps`; reports the measured post-exit state (`/library/app/<appid>`, ring on *Play*). `nothingRunning: true` with zero presses when nothing is up. Evidence `runs/<runName|exit-game_<ts>>.json`.
- **deck.readPage** / **deck.waitFor** — evaluate an expression in the plugin's page (read, do not drive).
- **deck.stopAutomation** / **deck.automationStatus** — the killswitch; re-arming is not a tool.

### Run hygiene (set up a run, prove it is worth starting, replay it)

Added 2026-09-07. **Every tool in this section is desk-verified only — none has run against a real
Deck yet.** They are listed here so they are discoverable, not because they are trusted.

- **deck.checkReady** — `{ awake?, buildMatches?, runningAppId?, pluginOpen?, noForeignCdpTunnel?, modalOnScreen?, focusRingOwned?, pluginRoot?, pluginName?, rootSelector?, cdpUrl?, targetsSettleMs?, timeoutMs? }` — takes a **declared** state and returns the diff against the actual one, so a run fails at step zero with a named reason instead of blind. Every field is optional and an absent field is not checked. Returns `{ ok, checks: { <name>: { declared, actual, verdict: "pass"|"fail"|"unknown", reason } }, failed[], unknown[], summary }`. **An unknown never reads as a pass**: a reader that errors reports `unknown`, which is its own outcome. `buildMatches` hashes every file in the deploy manifest locally and compares against one `sha256sum` pass over the installed directory on the Deck, distinguishing "hash differs" from "never deployed" from "could not ask". Honest limit: `modalOnScreen` only detects a modal that has captured the focus ring (the one class this repo has measured), so a modal that does not grab the ring reads as "no modal".
- **deck.saveCheck** / **deck.replayChecks** — save a `deck.sweep` or `deck.runSequence` result, with its expected landings, as a named check file in the consumer's repo; then rerun every saved check after a deploy and diff each against its saved result. Landings, totals, visibility verdicts and per-step pass/fail are compared; `durationMs`, `evidenceFile`, `pressRetries`, `fidelity`, `acquired` and generated prose are **ignored on purpose** — a check that fails for a reason unrelated to the plugin trains people to ignore red. Each check records the build hash it passed against, so a diff can say "this changed" separately from "this was never true here". A malformed or truncated check file is rejected with a clear message and the rest of the replay continues.
- **deck.holdAwake** `{ ttlMinutes?: 30, note? }` / **deck.restorePowerSettings** `{}` — turn off the screen-blank and suspend timeouts for a test run, recording the previous values **before** changing anything, and put exactly those values back. **Read the battery warning below.**
- **deck.snapshotSettings** `{ includeData?: false, ttlMinutes?: 30, note? }` / **deck.restoreSettings** `{}` — copy the plugin's settings directory (optionally its data directory) off the Deck into a checksummed run file, and put exactly that copy back. Restore stages then swaps rather than extracting over the live directory, and clears the old remote directory first, so a restore is byte-identical rather than a merge.

All four state tools share one state machine (`snapshotLease.ts`), by design rather than by coincidence:

- Old values are written to a run file **the instant they are read**, before anything changes, so a crashed session still leaves them recoverable.
- A second snapshot over an unrestored one is **refused**, naming the stale snapshot and the tool that restores it.
- Restore is a clean no-op when nothing was snapshotted, and safe to call twice.
- A partially-written or hand-edited run file is **detected** (checksum) rather than silently trusted.
- Snapshots expire after `ttlMinutes` (default 30) and expiry fails toward the *safe* state — the Deck sleeps again, the settings go back.

> **Battery warning, and the honest limit on expiry.** Expiry is checked **lazily**, when one of these
> tools is next called — not by a background timer, which could not survive the crash the run file
> exists to protect against. So a session that calls `deck.holdAwake` and then never calls any of
> these tools again leaves the Deck awake indefinitely. A Deck left never sleeping drains itself with
> nobody watching. Always pair a hold with its restore.

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

- **preview.start** / **preview.stop** / **preview.status** — `preview.start` now **checks that the preview URL actually answers** before reporting `running: true`; it previously set a boolean and claimed success without asking anything. When nothing answers it reports `running: false` with a reason.
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
