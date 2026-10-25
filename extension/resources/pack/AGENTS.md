# Decky Plugin Development — Agent Guide

This repository is configured for **Decky Plugin Studio**. Use the bundled MCP tools and the subagent personas in `.cursor/agents/` (Cursor) or `.claude/agents/` (Claude Code) when working on this plugin.

## Platform contract (read first)

- **Focus-graph first:** D-pad navigation uses Decky `Focusable` callbacks (`onMoveLeft`, `onMoveRight`, `onOKButton`, etc.), not DOM `keydown`.
- **The linter enforces the focus-graph rule:** `plugin.lintFocus` rule R13 flags D-pad routing through a DOM `keydown`/`keyup`/`keypress` handler, and R14 flags `instanceof Element`/`Node` on a node that may come from another document (the QAM is a different realm, so the brand check is false for every node).
- **Fidelity is earned:** `deck.pressButton` reports `fidelity: "wire-sent"` — the bridge firmware acked, which says nothing about whether the Deck received anything. Pass `verify: true` to earn `"steam-routed"`, which reads focus before and after the press. Treat a bare `wire-sent` as "sent", never as "landed".
- **Build parity:** After changes to `src/`, `main.py`, or `plugin.json`, run `plugin.build` (MCP) or `./scripts/build.sh` / `./scripts/build.ps1` before on-device QA.
- **Check on the Deck:** there is no in-IDE preview (it was retired on 2026-10-24). Run `deck.deploy`, then check the UI on the Deck or a stand-in. Start a run with `deck.checkReady`, so a run on a sleeping Deck or a stale build fails at step zero.
- **Which machine:** every `deck.*` tool takes `machine: "<name>"` (see `deck.listMachines`). Without it you drive `deck`, the real Deck. A stand-in (a Bazzite VM, or the maintainer's PC running Big Picture with Decky for Windows) is `kind: "standin"`, and **every result says `machine: { name, kind, os }`** -- never file a stand-in's verdict as the Deck's; declare `machineKind: "deck"` in `deck.checkReady` when a run must only ever run on the real Deck. **One driver per machine:** a driving call takes the machine's lease for your session; if another live session holds it you get a refusal naming them -- stop and tell the user, do not look for another way to press.
- **Every call has a deadline:** every tool takes `deadlineMs`. The defaults are 10 minutes for driving tools, 30 s for `deck.status` and the registry tools, 60 s for the rest. A call past its deadline returns an error naming its last stage, and a driving tool releases the pad.

## MCP tools (Decky Plugin Studio)

MCP names use underscores (`deck_deploy`); the dotted names here mean the same tools.

| Tool | Purpose |
|------|---------|
| `deck.stopAutomation` | **KILLSWITCH.** Stop every press now and latch it off until a human re-arms |
| `deck.automationStatus` | Is the rig armed, or did somebody stop it? |
| `deck.status` | Cheap first check: tunnel, ingest, Deck reachable, bridge port (`bridgePortOpen`), and on Windows whether Big Picture is in front |
| `deck.configure` | Set `DECK_IP` and `DECK_USER` (use those exact keys); with `machine`, add or change a stand-in's registry entry |
| `deck.listMachines` | Every machine this server can drive, with kind, os, press transport, who holds its lease, and whether it is stopped |
| `deck.releaseMachine` | Release your session's driving lease on a machine; `force` evicts another session's (only when the user says it is gone) |
| `deck.getEnv` | Workspace + Deck environment snapshot |
| `deck.startTunnel` / `deck.stopTunnel` | Reverse SSH tunnel for NDJSON ingest |
| `deck.probeIngest` / `deck.tailIngest` | Debug log capture from Deck |
| `deck.readPluginLog` | Tail plugin_loader journal on Deck |
| `deck.captureScreenshot` | Composited Deck screenshot (open QAM + plugin); on a Windows stand-in, the Big Picture page |
| `deck.record` | Composited screen recording to `recordings/` |
| `deck.installCaptureHelper` | Install capture helpers on Deck |
| `deck.deploy` | Build + deploy (local SteamOS/Bazzite or remote SSH), then wait for the loader |
| `deck.reloadPlugin` | Restart plugin_loader without redeploy |
| `deck.openPlugin` | Open the QAM and your plugin's panel by driving the Deck through the bridge, with a focus read before every step; `drive: false` returns the manual checklist instead |
| `deck.readFocus` | Where the gamepad ring is, and whether a person could see it (`visibility`) |
| `deck.readPage` / `deck.waitFor` | Ask the plugin's page a question, or poll it until true. Read, do not drive |
| `deck.pressButton` | One real press through the bridge, including the triggers `LT` and `RT`; a list is a simultaneous press, not a chord |
| `deck.pressChord` | Hold one button, tap another — the real QAM toggle is hold GUIDE, tap A; `[GUIDE, A]` in `deck.pressButton` is a simultaneous press, which opens the main menu instead |
| `deck.assertFocusMove` | Press, then report whether focus moved and whether it matched |
| `deck.walkTo` | D-pad one way until the ring lands on a control with the given text; never presses A |
| `deck.runSequence` | Many presses with a check at each; fails a step a person could not see (`requireVisible` is on by default) |
| `deck.sweep` | D-pad around the pane and record every stop and its visibility, for diffing |
| `deck.listGames` | Installed games, the Recent Games shelf and the running game, with no press |
| `deck.launchGame` | Start a game by pressing buttons, from the Recent Games shelf or the Library grid; refuses a second game, an uninstalled one, or Install/Update/Buy |
| `deck.exitGame` | Exit the running game — Steam menu → Exit game → Confirm; done when `RunningApps` empties and no game process is left |
| `deck.checkReady` | Declare the state a run needs (awake, build hash, game, tab, no foreign tunnel, no modal, ring owned, machine kind, Big Picture in front) and get the diff against reality — fails at step zero with a named reason. An unknown never reads as a pass |
| `deck.focusBigPicture` | Windows stand-in only: bring Big Picture back in front (Win32 restore if minimized, then Steam's own bring-to-front and focus calls) and read the gate again; presses nothing |
| `deck.saveCheck` / `deck.replayChecks` | Save a sweep or sequence with its expected landings as a named check file; rerun them all after a deploy and diff. Timing, retries and fidelity are ignored on purpose |
| `deck.holdAwake` / `deck.restorePowerSettings` | Hold a logind sleep inhibitor for a run, then release it. Nothing on the Deck is changed, and the lock releases itself after its TTL. **Still pair every hold with a restore** |
| `deck.snapshotSettings` / `deck.restoreSettings` | Copy the plugin's settings (optionally data) directory off the Deck and put exactly that copy back |
| `plugin.detect` / `plugin.build` / `plugin.verifyZip` | Workspace validation and build |
| `plugin.diffRpc` | Compare `main.py` RPCs vs frontend `call()` sites |
| `plugin.lintFocus` | Check D-pad focus wiring from source (R13, R14 and more); static, no Deck |
| `studio.doctor` | Check Decky Plugin Studio's own setup (MCP config, versions, ports, bridge scripts, machines); `unknown` is never a pass |

## Stopping the rig

`deck.pressButton` and everything built on it drive a **real controller wired to a
real Deck** -- or, on a stand-in, a virtual controller Steam treats the same way. If
anything looks wrong -- the ring somewhere you did not expect, a sequence heading
somewhere you did not intend, a press that activated something -- call
**`deck.stopAutomation`** immediately. It presses nothing, it is idempotent, and
stopping a run that turned out to be fine costs one re-arm. `{ machine }` stops one
stand-in and leaves the others running; with no argument it stops everything, which
is the right call whenever you are not sure.

You cannot undo it. There is no arming tool, on purpose: an agent that can clear
its own killswitch does not have one. Re-arming is the user's job -- their status
bar click or the **Decky: Arm Deck Automation** command. The stop itself is theirs
too: the status bar or <kbd>ctrl+alt+.</kbd>.

When a press refuses, read *why* before reacting. "Deck automation is STOPPED"
means a human stopped you and you should stop too -- say so and wait, do not look
for another route to the same press. That is different from a bridge that is
unplugged, and the two have opposite correct responses.

A human can also stop you from outside this session entirely, so a refusal you
did not expect is not necessarily a bug.

## Subagents

| Agent | When |
|-------|------|
| **decky-debugger** | Runtime focus/layout bugs — evidence-first fixes |
| **decky-focus-architect** | Design-time focus graphs before implementation |
| **decky-ui-focus-gate** | Mandatory pre-ship D-pad focus triage for UI edits — invoke via **decky-ui-change-focus-gate** skill |

Related skills (not subagents): **decky-onboard**, **decky-dev-loop**, **decky-screenshot-ingest**, **decky-release**, **decky-focus-audit**, **decky-ui-change-focus-gate**.

Archive substantive runs in `.cursor/agents/SUBAGENT_REPORTS.md`.

## Focus patterns

Worked focus-graph patterns: [docs/focus-graph-patterns.md](docs/focus-graph-patterns.md).
