# Decky Plugin Studio — MCP tool reference

For installing or building the extension, see [DEVELOPMENT.md](DEVELOPMENT.md).

The server registers **43 tools**. MCP names use underscores (`deck_deploy`); this page writes
them with a dot (`deck.deploy`). Both mean the same tool. The source of truth is
`mcp-server/src/toolRegistry.ts`: each tool's own description there is what an agent sees.

The in-IDE preview was retired on 2026-10-24. The 16 `preview_*` tools are gone. UI checks now
run on the Deck, or on a stand-in.

## Shared parameters and the result stamp

- **`machine`** — every `deck.*` tool takes `machine: "<name>"` (except `deck.listMachines` and
  `deck.automationStatus`, which cover every machine). The name comes from `deck.listMachines`.
  Without it you drive the registry default, normally `deck`: the real Deck from `deck.env`.
- **The stamp** — every result carries `machine: { name, kind, os }`. `kind` is `deck` or
  `standin`. Never file a stand-in's verdict as the Deck's.
- **`deadlineMs`** — every tool takes a wall-clock limit for that one call. Defaults: 10 minutes
  for driving tools (press, walk, sweep, sequence, open, launch, exit, deploy, snapshot,
  record...), 30 s for `deck.status` and the registry and killswitch tools, 60 s for the rest.
  When it passes, the call returns an error naming the tool, the deadline and the last stage it
  reported. Child processes it started are killed. A driving tool's pad is released. The stop
  latch is **not** set.
- **One driver per machine (the lease)** — a driving call takes the machine's lease for your
  session. A second live session's driving call is refused, naming the holder, its purpose and
  when the lease frees itself. Reads, the killswitch, the restore tools and the registry tools
  never need it. A lease expires after ten minutes without a call, or when its owner process is
  dead.
- **One call at a time per machine** — two driving calls from the same session on one machine
  wait in line. A call that waited reports `waitedForPreviousCallMs`, and the wait counts against
  its deadline. Reads do not wait.

## Workspace config

Plugin repos may include [`.decky/preview.json`](../pack/.decky/preview.json). The name is left
over from the preview. Two keys are still read; any other key is ignored.

| Field | Purpose |
|-------|---------|
| `panelRootSelector` | CSS selector your panel renders at its root (e.g. `.my-plugin-scope`). Lets `deck.openPlugin` and `deck.checkReady` tell "my panel is open" from "my name is a row in Decky's plugin list" |
| `preDeployCommand` | Shell command run before `deck.deploy` |

## Machines and setup

- **deck.configure** — `{ DECK_IP?, DECK_USER? }` writes `deck.env`, the real Deck's address.
  Other keys are written to `deck.env` as they are, and nothing reads `ip` or `user`, so use the
  upper-case names. With **`machine`** it adds or changes that machine's entry in
  `~/.config/decky-plugin-studio/machines.json` instead: `kind` (`deck` | `standin`), `os`
  (`steamos` | `bazzite` | `windows`), `local`, `host`, `user`, `press` (`bridge` | `uinput` |
  `vigem` | `none`), `bridgePort`, `padPort`, `cdpPort`, `pluginsDir`, `vm`, `note`; `remove:
  true` deletes it; `makeDefault: true` makes it the machine used when a call names none.
- **deck.listMachines** — every machine this server can drive, with kind, os, local or not,
  press transport, who holds its lease and whether the killswitch stopped it. Read-only.
- **deck.releaseMachine** — `{ machine?, force? }` releases your session's lease. `force: true`
  evicts another live session's lease; do that only when the user says that session is gone.
- **deck.status** — tunnel, ingest, Deck reachable, Ollama, `automationArmed`, and the bridge as
  **`bridgePortOpen`**. That says only that the serial port opened and the firmware answered. A
  board unplugged from the Deck still reads `true`. `bridgeReady` is the same value under its old
  name, kept for bonsAI; use `bridgePortOpen`. On a Windows machine it also reports
  `bigPicture: { foreground, visibilityState, hasFocus }`. Cheap; call it first.
- **deck.getEnv** — workspace, Deck config, tunnel, plugin detect, and a remote SteamOS probe.
  The loader state is one word, or `unknown` when ssh says nothing.
- **studio.doctor** — `{ workspace?, extensionVersion? }` checks DPS itself for setup drift,
  without touching a Deck: the MCP config files point at a server that exists and matches the
  extension's version; the version pins agree; nothing else holds the ingest port; the bridge
  scripts and capture scripts resolve and Python can import `serial` (and `vgamepad` on
  Windows); `machines.json` parses; `deck.env` has `DECK_IP` and `DECK_USER`; the killswitch
  state. Each check is `ok: true | false | "unknown"` with `saw` and `fix`. A check that could
  not run is `unknown`, never a pass. The extension's **Decky: Doctor** command runs it.
  Desk-verified only.

## Killswitch

- **deck.stopAutomation** — `{ reason?, port?, machine? }`. Releases every held button, aborts
  runs in flight, cuts the tunnels, and refuses every later press until a human re-arms. With
  `machine` it stops one machine only. Always safe: it presses nothing.
- **deck.automationStatus** — armed or stopped, when and by whom, and which tunnels are live.
  Check this when a press refuses: a stopped rig and a broken bridge look the same from one
  failed press.

There is no arming tool. Re-arming is the user's: the status bar, **Decky: Arm Deck
Automation**, or `pnpm arm`.

## Tunnel, ingest, logs

- **deck.startTunnel** / **deck.stopTunnel** — reverse SSH tunnel so the Deck can push debug logs.
- **deck.probeIngest** / **deck.tailIngest** — `{ since?, lines?, hypothesisId? }`.
- **deck.readPluginLog** — `{ lines?, filter? }` tails the `plugin_loader` journal.

The ingest port is `DEBUG_INGEST_PORT` in the server's environment (default 7682).

## Capture

- **deck.captureScreenshot** — `{ mode?: "auto"|"game"|"desktop", allowNonPluginUi? }`. Returns
  `{ path, bytes, mode, method }` **and an MCP `image` block**, so a model can see the picture.
  Big images are scaled down, not dropped; the text says if one was dropped anyway. On the Deck,
  composited methods are preferred (`gamescope-atom`, `grim`); open the QAM and your plugin first.
  **On a Windows stand-in** it captures the Big Picture page over Steam's debugger (`method:
  "cdp"`), falling back to a PowerShell window grab (`"window-grab"`). The Quick Access menu is not
  composited in there. The Windows path is desk-verified only.
- **deck.record** — `{ seconds?, mode?, quality?: "compressed"|"full", allowNonPluginUi? }`.
  Writes to `<workspace>/recordings/`. Still refuses on Windows.
- **deck.installCaptureHelper** — `{ which?: "record"|"capture"|"both" }` installs
  `studio-record` / `studio-capture` into `~/.local/bin` on the Deck.

## Plugin lifecycle

- **deck.deploy** — `{ mode?: "auto"|"local"|"remote", waitForLoader?, loaderTimeoutMs? }`. Builds,
  copies, restarts the loader, and by default waits (30 s bound) until the loader is active and
  Steam lists its pages. `loader.ready: false` means the wait ran out.
- **deck.reloadPlugin** — same arguments. Restarts the loader without a redeploy, with the same
  wait.
- **deck.openPlugin** — `{ pluginName?, drive?, rootSelector?, tabBudget?, listBudget?, port?,
  cdpUrl? }`. **Drives the Deck** through the bridge to open your panel, checking every stage
  against a focus read. It uses only the D-pad while searching and presses A only on a control
  labelled with the plugin's name. **`drive: false`** returns the manual checklist and presses
  nothing. Set `rootSelector` (or `panelRootSelector`) so "already open" is decided by your own
  markup. The open chord is a toggle, so it is sent only when the Quick Access page itself says
  the menu is shut. Waits it makes:
  - After `deck.reloadPlugin`, up to 45 s for the Quick Access page to come back before the first
    read (stage `wait-qam-after-restart`).
  - After the chord, it re-reads every 300 ms for up to 3 s before calling the open a failure.
  - When the menu is open but Decky's tab is missing from the rail, it presses no D-pad button
    and waits up to 120 s (stage `wait-decky-tab`). Every 10 s it closes and reopens the menu,
    checking each step with a read (stage `reopen-qam`).
  - A first try that failed with nothing pressed, or only the chord, is tried once more inside
    the same call. The result then has `retried`, and stages are prefixed `try1:` / `try2:`.

  **On the Deck after a reload it is still not reliable**: on 2026-10-22 it opened the panel 3 of 3
  on a first set and 1 of 3 on a stricter set (two failed 1 s after the reload with a debugger
  connection reset).

## Focus rig (bridge board + CDP)

Every focus read answers two questions: **where is the ring** (`gpfocus`) and **could a person
see it** (`visibility`).

- **deck.readFocus** — `{ cdpUrl?, timeoutMs? }` → `{ ok, gpfocus, visibility, scrollPane,
  gpfocusWithin, activeElement, agree, quickAccessTab, visibleQuickAccessTab, timedOutPages,
  slowestPageMs, … }`.
  - Every Steam page is asked at once. `timeoutMs` (default 10000) is the budget per page, so a
    frozen page costs one timeout, not one per page. The read returns as soon as the ring's page
    is known. A page that timed out gets a 500 ms budget on the next read. `timedOutPages` names
    the pages that did not answer; `slowestPageMs` is the slowest wait. On a Windows machine only
    Big Picture's pages are asked.
  - `visibility` — `{ verdict: "visible"|"partial"|"covered"|"offscreen", visiblePercent,
    coveredBy, clippedBy, points, sample }`. A control with words is sampled along its text
    lines (`sample: "text"`), three points per line, cut to what its clipping boxes let through,
    so a folded section line with an ellipsis reads whole. A control with no text is sampled on a
    3x3 grid over its box (`sample: "box"`). It is a DOM hit test, not eyes: colours and
    compositing still need a screenshot. The text-line sampler passed on the Deck 2026-10-22.
  - `scrollPane` — the nearest scrolling ancestor's `{ selector, scrollTop, scrollHeight,
    clientHeight }`, or `null`.
- **deck.readPage** — `{ expression, target?, timeoutMs?, cdpUrl? }` evaluates an expression in
  the plugin's page and returns JSON. Read, do not drive.
- **deck.waitFor** — `{ expression, equals?, waitMs?, intervalMs?, target?, cdpUrl? }` polls an
  expression until it is truthy (or equals `equals`). A timeout is a finding, not an error.
- **deck.pressButton** — `{ buttons, holdMs?, port?, verify?, cdpUrl? }`. A real press through the
  bridge. Buttons: `UP DOWN LEFT RIGHT A B X Y LB RB SELECT START GUIDE L3 R3 LT RT`. **`LT` and
  `RT` are the triggers** (L2 and R2, pulled all the way); they need firmware `05_triggers` or
  later. A list is a **simultaneous** press, not a chord: `[GUIDE, A]` opens the main menu. Use
  `deck.pressChord` for hold-then-tap. Retries once, after 350 ms, only when another opener holds
  the serial port.

  **Fidelity is earned.** A plain press reports `fidelity: "wire-sent"`: the firmware acked, and
  that is all. `verify: true` reads focus before and after and reports `"steam-routed"` only
  when focus moved. Multi-press tools report the weakest press in the run.
- **deck.pressChord** — `{ hold, tap, port? }`. Hold one button, tap another, release. `hold:
  "GUIDE", tap: "A"` is the Quick Access Menu toggle. Prefer `deck.openPlugin` when you want the
  panel.
- **deck.assertFocusMove** — `{ press, expect?, holdMs?, settleTimeoutMs?, port?, cdpUrl? }`.
  Press, read until focus settles, report `moved` and `matched` apart.
- **deck.walkTo** — `{ direction, text, exact?, budget?, stallLimit?, acquireFocus?, port?,
  cdpUrl? }`. Direction presses only, never A/B/START. Returns `found`, `matched`, `seen`,
  `stalled`, `overshot` and `visibility` for the stop it ended on.
- **deck.runSequence** — `{ steps: [{ press, expect?, label?, requireVisible?, holdMs?,
  settleTimeoutMs? }], requireVisible?, stopOnFailure?, mustReachText?, runName?,
  writeEvidence?, acquireFocus?, port?, cdpUrl? }`. One tunnel, cycle detection, evidence under
  `runs/`. **`requireVisible` now defaults to on**: a step whose landing spot a person could not
  see fails, the way a wrong `expect` does. Pass `false` for the run, or per step, to only
  measure and report it.
- **deck.sweep** — `{ direction?, returnTrip?, lanes?, laneButton?, budget?, stallLimit?,
  acquireFocus?, runName?, writeEvidence?, port?, cdpUrl? }`. Walks one way until the ring stops
  or cycles, walks back, and can repeat per carousel lane with LB/RB. Records label, selector,
  rect, `scrollTop` and visibility at every stop, into a `runs/` file built for diffing. Read
  `totals.stopsFocusedButNotVisible` first.

## Games

- **deck.listGames** — `{ cdpUrl? }`. Presses nothing. Installed titles (`name`, `appid`,
  `nonSteam`), the Recent Games shelf's app ids (only when Home is up with the ring on a shelf
  tile; otherwise `null` with `recentShelfReason`), `RunningApps`, and `notInstalledCount`. The
  shelf read is device-unverified.
- **deck.launchGame** — `{ name? | appid?, budget?, waitMs?, runName?, writeEvidence?, port?,
  cdpUrl? }`. Starts a game by pressing what a thumb would, with a read before every A. It never
  drives by script. Refuses before pressing when: neither or both of `name`/`appid`; a different
  game is running; the name is ambiguous; the game is not installed; the app page shows Install /
  Update / Buy / Pre-load / Pre-purchase / Purchase / Add to Cart / Download. `alreadyRunning:
  true` costs no presses. Routes, reported as **`launchRoute`**:
  - `shelf` — Steam button, Home, the Recent Games shelf, A on the tile, A on Play.
  - `library` — a game not on the shelf is looked for in the Library grid: Steam button, the menu
    entry "Library", then a D-pad walk to the tile whose image carries the app id. **Never run on
    a Deck yet.**
  - `home` — when the Steam button opens no menu (the maintainer's Deck since 2026-10-10), the
    QAM is closed with the GUIDE+A chord and the shelf on the Home screen is walked RIGHT, then
    LEFT. Anywhere but Home is a refusal, because the only way Home without the menu is B, which
    it never presses.

  `via` says `"steam-menu"` or `"home-screen"`. Writes `runs/launch-game_<ts>.json`.
- **deck.exitGame** — `{ waitMs?, runName?, writeEvidence?, port?, cdpUrl? }`. Steam button,
  RIGHT, DOWN to "Exit game", A, then A on "Confirm" only when a read shows the ring on it. Done
  when the app id leaves `RunningApps`. An empty `RunningApps` is not believed alone: on
  steamos/bazzite it also asks the process list (`pgrep` for Steam's launch line). A live process
  refuses with `processAlive: true` and its `pid`; nothing is pressed or killed. Windows skips the
  check and says so (`processAlive: null`, `processCheck`). When the menu opens on Home with a
  game underneath, it walks UP to the game's entry. When the Steam button opens no menu at all,
  it asks Steam to close the game (`SteamClient.Apps.TerminateApp`): `via: "steam-close-call"`,
  summary "closed without the Steam menu", fidelity stays `wire-sent`. The process check and the
  walk UP are desk-verified only. Writes `runs/exit-game_<ts>.json`.

Both leave the ring where Steam puts it; `deck.openPlugin` gets the panel back, even over a
running game.

## Run hygiene (set up a run, prove it is worth starting, replay it)

- **deck.checkReady** — `{ awake?, buildMatches?, runningAppId?, pluginOpen?, noForeignCdpTunnel?,
  modalOnScreen?, focusRingOwned?, machineKind?, foreground?, pluginRoot?, pluginName?,
  rootSelector?, cdpUrl?, targetsSettleMs?, timeoutMs? }`. Takes a **declared** state and returns
  the diff against the real one, so a run fails at step zero with a named reason. Every field is
  optional; an absent field is not checked. Each check is `pass`, `fail` or `unknown`, and
  **unknown is never a pass**. `machineKind: "deck"` fails at once on a stand-in. `foreground`
  checks that Big Picture is the window in front; it is checked by default on a Windows machine,
  where Steam only takes pad input while Big Picture is in front. On Windows, a walk will not
  place the ring with a blind press while Big Picture is behind. `foreground` is desk-verified
  only. `modalOnScreen` only sees a modal that has taken the focus ring.
- **deck.saveCheck** / **deck.replayChecks** — save a `deck.sweep` or `deck.runSequence` result
  with its expected landings as a named check file, then rerun every saved check after a deploy
  and diff. Timing, retries, fidelity and generated prose are ignored on purpose. Each check
  records the build hash it passed against.
- **deck.holdAwake** — `{ ttlMinutes?: 30, note? }`. Holds a systemd-logind **block inhibitor**
  on sleep, so Steam's suspend is refused. Nothing on the Deck is changed. The lock is read back
  from `systemd-inhibit --list` and returned as `evidence`; if it is not there, the call says the
  Deck can still sleep. The lock **releases itself** after `ttlMinutes` (1 to 480).
- **deck.restorePowerSettings** — releases that lock, and checks it is gone. A clean no-op when
  nothing is held. **Pair every hold with a restore**; the TTL is a safety net, not the plan.
- **deck.snapshotSettings** — `{ includeData?, ttlMinutes?: 30, note?, replace? }`. Copies the
  plugin's settings folder (optionally its data folder) off the Deck into a checksummed run file.
  - A big folder is streamed straight to a file. `method` says `"buffered"` or `"streamed"`.
  - A streamed copy is checked against the size and checksum the Deck computed. A bad copy is
    taken once more; a second bad copy is an error naming both sizes.
  - An earlier snapshot that expired is put back first, but only if it is younger than 6 hours.
    An older one is set aside, not restored, and the summary says so. A damaged earlier copy is
    set aside too.
  - A second snapshot over an unrestored one is refused. **`replace: true`** sets the earlier run
    file aside under a dated name instead, and names it.
  - Passed on the Deck 2026-10-22 (236 MB settings folder). `replace` is desk-verified only.
- **deck.restoreSettings** — puts exactly that copy back. It checks the archive first and stages
  then swaps, so the live folder is never half-written. A clean no-op when nothing was taken.

## Plugin source

- **plugin.detect** / **plugin.build** / **plugin.verifyZip**
- **plugin.diffRpc** — `{ backendOnly, frontendOnly, matched }` from `main.py` against the
  frontend's `call()` sites.
- **plugin.lintFocus** — `{ pluginRoot? }` checks D-pad focus wiring from source: one-way moves,
  unreachable controls, controls with no A action, banned patterns (R13: D-pad through DOM
  `keydown`; R14: `instanceof Element`/`Node` across documents). Static only.

## Capture environment

| Variable | Purpose |
|----------|---------|
| `DECKY_STUDIO_WORKSPACE` | Plugin workspace root (artifacts, cwd) |
| `DEBUG_INGEST_PORT` | Port the debug-ingest server listens on (default 7682) |
| `DECKY_STUDIO_ALLOW_STEAMOS_RW` | Set `0` to skip optional pacman/steamos-readonly on Deck |
| `BONSAI_ALLOW_STEAMOS_RW` | Legacy alias (still read) |

## Skills and agents (Init Pack)

| Skill / agent | MCP tools used |
|---------------|----------------|
| **decky-onboard** | `deck.configure`, `plugin.detect`, `plugin.lintFocus`, `plugin.build`, `deck.deploy`, `deck.openPlugin` |
| **decky-release** | `plugin.build`, `plugin.verifyZip`, `plugin.diffRpc`, `deck.deploy` |
| **decky-focus-audit** | `plugin.lintFocus`, `deck.openPlugin`, `deck.readFocus`, `deck.assertFocusMove`, `deck.captureScreenshot` |
| **decky-debugger** | `deck.tailIngest`, `deck.readPluginLog`, `deck.reloadPlugin` |
| **decky-focus-architect** | design-time; validates with `plugin.lintFocus` and on-device QA |
