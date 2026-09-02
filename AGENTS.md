# Decky Plugin Development — Agent Guide

This repository is configured for **Decky Plugin Studio**. Use the bundled MCP tools and subagent personas in `.cursor/agents/` when working on this plugin.

## Platform contract (read first)

- **Focus-graph first:** D-pad navigation uses Decky `Focusable` callbacks (`onMoveLeft`, `onMoveRight`, `onOKButton`, etc.), not DOM `keydown`.
- **Build parity:** After changes to `src/`, `main.py`, or `plugin.json`, run `plugin.build` (MCP) or `./scripts/build.sh` / `./scripts/build.ps1` before on-device QA.
- **Preview vs on-device:** The live preview is **very much beta**. Use `preview.start` for fast UI iteration; use `deck.deploy` + on-device QA for focus/layout bugs the preview cannot reproduce faithfully.

## MCP tools (Decky Plugin Studio)

| Tool | Purpose |
|------|---------|
| `deck.stopAutomation` | **KILLSWITCH.** Stop every press now and latch it off until a human re-arms |
| `deck.automationStatus` | Is the rig armed, or did somebody stop it? |
| `deck.configure` | Set DECK_IP, DECK_USER, ingest port |
| `deck.startTunnel` / `deck.stopTunnel` | Reverse SSH tunnel for NDJSON ingest |
| `deck.probeIngest` / `deck.tailIngest` | Debug log capture from Deck |
| `deck.captureScreenshot` | Composited Deck screenshot (open QAM + plugin) |
| `deck.record` | Composited screen recording to `recordings/` |
| `deck.installCaptureHelper` | Install capture helpers on Deck |
| `deck.deploy` | Build + deploy (local SteamOS/Bazzite or remote SSH) |
| `deck.reloadPlugin` | Restart plugin_loader without redeploy |
| `deck.openPlugin` | Checklist to open QAM + plugin on Deck |
| `deck.launchGame` | Start a game by pressing buttons — Steam menu → Home → Recent Games tile (identified by app id) → Play; refuses a second game, an uninstalled one, or Install/Update/Buy |
| `deck.exitGame` | Exit the running game the same way — Steam menu → Exit game → Confirm; done when `RunningApps` empties |
| `deck.pressChord` | Hold one button, tap another — the real QAM toggle is hold GUIDE, tap A; `[GUIDE, A]` in `deck.pressButton` is a simultaneous press, which opens the main menu instead |
| `deck.readPluginLog` | Tail plugin_loader journal on Deck |
| `deck.getEnv` | Workspace + Deck environment snapshot |
| `plugin.detect` / `plugin.build` / `plugin.verifyZip` | Workspace validation and build |
| `plugin.diffRpc` | Compare `main.py` RPCs vs frontend `call()` sites |
| `preview.start` / `preview.stop` / `preview.status` / `preview.health` | In-IDE QAM preview |
| `preview.injectFocusEvent` | Simulate D-pad input |
| `preview.setHardware` | Drive hardware simulator (temps, battery, fans) |
| `preview.runSequence` | Replay input sequence + return DOM snapshot |
| `preview.callRpc` / `preview.readLog` | Backend RPC and log tail |
| `preview.tailEmit` | Tail preview sidecar emit events (streaming RPC) |
| `preview.snapshotDom` / `preview.captureScreenshot` | Idle DOM inspect + preview PNG |
| `preview.compareScreenshot` | Visual regression vs `tests/preview-baselines/` |
| `preview.setHttpAllow` | Extend HTTP passthrough allowlist |
| `preview.setPermissions` | Deny capabilities in preview |
| `preview.callTestHook` | Drive `window.__deckyPreviewTestHooks` |

## Stopping the rig

`deck.pressButton` and everything built on it drive a **real controller wired to a
real Deck**. If anything looks wrong -- the ring somewhere you did not expect, a
sequence heading somewhere you did not intend, a press that activated something --
call **`deck.stopAutomation`** immediately. It presses nothing, it is idempotent,
and stopping a run that turned out to be fine costs one re-arm.

You cannot undo it. There is no arming tool, on purpose: an agent that can clear
its own killswitch does not have one. Re-arming is the user's job -- their status
bar click, the **Decky: Arm Deck Automation** command, or `pnpm run arm`. The
stop itself is theirs too: the status bar, <kbd>ctrl+alt+.</kbd>, or `pnpm stop`.

When a press refuses, read *why* before reacting. "Deck automation is STOPPED"
means a human stopped you and you should stop too -- say so and wait, do not look
for another route to the same press. That is different from a bridge that is
unplugged, and the two have opposite correct responses.

A human can also stop you from outside this session entirely, so a refusal you
did not expect is not necessarily a bug.

## Preview test suite

```bash
node scripts/run-preview-suite.mjs --tier=smoke
```

Requires **Decky: Open Preview**. Agent loop: `.cursor/skills/decky-tier-qa/SKILL.md`.

## Subagents

| Agent | When |
|-------|------|
| **decky-debugger** | Runtime focus/layout bugs — evidence-first fixes |
| **decky-focus-architect** | Design-time focus graphs before implementation |
| **decky-ui-focus-gate** | Mandatory pre-ship D-pad focus triage for UI edits — invoke via **decky-ui-change-focus-gate** skill |

Related skills (not subagents): **decky-onboard**, **decky-dev-loop**, **decky-tier-qa**, **decky-preview**, **decky-screenshot-ingest**, **decky-release**, **decky-focus-audit**, **decky-ui-change-focus-gate**.

Archive substantive runs in `.cursor/agents/SUBAGENT_REPORTS.md`.

## Preview limitations

See [PREVIEW_LIMITATIONS.md](docs/PREVIEW_LIMITATIONS.md). Deck-only scenarios: `tests/preview-suite/deck-only.json` (template).
