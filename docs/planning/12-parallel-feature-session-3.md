# Plan 12 — parallel feature session 3

Drafted 2026-11-02 from `main` at `2b221ab` (0.3.11, 590 tests, 44 tools). **Not started**: the
maintainer says "go".

## Where things stand

Plan 11's eight lanes landed on 2026-10-24 and ran on both machines on 2026-10-25. After that pass:

- **Proven and closed:** the lone Steam button (firmware `06_trigger_rest`), lanes A–D on `this-pc`,
  `getEnv`'s loader word, `snapshotSettings { replace }`, `studio_doctor`, `deck_listGames`,
  `deck_exitGame`'s process check with nothing running, `deck_focusBigPicture` (all three cases).
  Issues #4 and #5 are closed.
- **Still open, device-owed:** the Library grid's DOWN step (lane F stalled after one row), the
  `requireVisible` flip on a real covered stop, the lease owner token under two live servers, and
  lane D's abandoned-promise gap (a timed-out walk may still press beside the next call).
- **The one consumer-facing bug:** `deck_openPlugin` in the first second after a reload ([issue
  #3](https://github.com/qd313/decky-plugin-studio/issues/3)); four fixes, each passed at the desk
  and failed on the Deck. bonsAI's stricter set read 1 of 3 on 2026-10-22, both failures 1 s after
  the reload with a "debugger connection reset". Nothing has measured what CEF does in that window.
- **New from bonsAI's log since 2026-10-24** (`Documents/bonsAI/docs/mcp-setup.md` § DPS findings
  log): `deck_replayChecks` with no names replayed all 100 saved walks, 25 minutes of presses on a
  Deck in a random state, and changed a setting; the launch tool cannot pick a non-Steam shortcut
  from the shelf (no app id in the tile image); run files land in the repo's folders by default.
- **Still nobody can type on the Deck**, every Ask test routes through pinned chips.
- **About twenty findings sit in bonsAI's log marked "needs filing"** with no issue here.
- The docs are behind the 2026-10-25 verdicts: the Open bugs section still says "stays open until
  its device pass" for lanes D, E, F and H, and the `preview.test.ts` entry outlived the preview.

## The split

Same rule as plans 09 and 11. Work whose risk lives at the desk runs in parallel in worktrees; work
whose hard part is "what does the hardware do" is built with seams, marked device-unverified, and
measured in phase 2. Eight lanes, one squashed commit each, no lane touches the five docs, no
version bump until phase 2 has run.

| Lane | What | Model | Risk | Proven where (owed) |
|------|------|-------|------|---------------------|
| **A — The reload window, measured** | A probe that records what CEF's debugger does for 30 s after a `plugin_loader` restart; the restart note moves from memory to a file so the extension's reload is visible to the agent's server; a connection reset inside the window is "rebuilding", not failure; a first-run dialog that took the ring is named | opus | ★★★ | Deck, 15 min |
| **B — A press after the deadline refuses** | Closes lane D's gap: the per-call deadline reaches the press seam; `deck_replayChecks` refuses to run everything by accident; run files go where the caller says | sonnet | ★★ | `this-pc`, 5 min |
| **C — A ledger of every run** | At the dispatch seam: one NDJSON line per `deck_*` call; `saveAs` on evidence-writing tools; `deck_runReport` emits the markdown a testing row expects | sonnet | ★★ | PC, 5 min |
| **D — Type text, the honest fallback** | `deck_typeText` over CDP `Input.insertText`, fidelity `injected`, refuses unless the ring is on a text field, reads the value back | sonnet | ★ | Deck, 5 min |
| **E — Shortcuts on the shelf, and a grid that explains itself** | Pick a shelf tile by title or position (non-Steam shortcuts); the grid walk records the whole tile layout at every stop so the next Deck run says why DOWN failed; a RIGHT-then-DOWN fallback behind a read | opus | ★★★ | Deck, 20 min |
| **F — Studio issue intake** | `studio_reportIssue` and **Decky: Report Studio Issue**: redacted bundle, preview, then `gh issue create` or a prefilled URL; issue templates and labels | sonnet | ★★ | PC, 5 min |
| **G — Sleep the Deck and wake it again** | `deck_sleepAndWake { seconds }`: refuses until `rtcwake` has armed and read back, refuses with a game running or on a stand-in, suspends by the measured path, waits for SSH, reads focus without touching the panel | opus | ★★★ | Deck, 10 min |
| **H — The firmware says which program it runs** | `07_version`: the board's status reply carries its program name; `deck_status` and the reflash refusals read it instead of guessing from the resting axes | sonnet | ★ | Deck, 5 min (needs a flash) |

Deferred to the next session, on purpose: *Time a run the way a person sees it* (wants lane C's
ledger first), *Run the same check through every way into the plugin* (wants lane A's measurement
and lane G's suspend path), the bridge keyboard (lane D's fallback buys time to design it with
lane G's wake option 1), the VM stand-in lane.

## Lane briefs

Every brief carries the common header below. The honesty paragraph is not optional.

> **Common header.** You are one lane of plan 12 in `docs/planning/12-parallel-feature-session-3.md`.
> Read `AGENTS.md` and the section of `docs/ROADMAP.md` your lane names. Work only in your worktree.
> Do not touch `docs/ROADMAP.md`, `CHANGELOG.md`, `docs/MCP_TOOLS.md`, `AGENTS.md`, the `pack/` copy
> or any version field. Add your tests to the `test` script line in `mcp-server/package.json`
> (expect a merge conflict there; it is fine). Run `pnpm -r test` and `pnpm build` before you
> report. Do not run any `deck_*` tool against a machine; this is a desk lane. Your report ends with
> one paragraph headed **What could pass my tests while the real thing is broken**, and a list of
> exactly which reads the device pass must confirm.

### Lane A — The reload window, measured

**Read:** ROADMAP § Open bugs, first entry; `mcp-server/src/deck/loaderRestart.ts`,
`openPlugin.ts`, `openPluginRetry.ts`, `cdp.ts`, `tools/deckAutonomy.ts` (reload), issue #3.

**Build, in this order:**

1. **The restart note becomes a file.** `loaderRestart.ts` keeps "a restart just happened" in one
   server process's memory, so a reload done from the extension is invisible to an agent's server
   (found 2026-10-22). Write it beside the lease file (`lease.ts`'s `leaseDir()`), one file per
   machine, atomic write, same 120 s window, read by `msSinceLoaderRestart`. The memory map stays as
   a cache. Both the reload tool and `deck_deploy`'s loader wait write it.
2. **`deck_probeDebugger { seconds?, afterReload? }`**, read-only, no lease. Every 250 ms for up to
   `seconds` (default 30) it lists CDP targets, opens a socket to `SharedJSContext` and to the Quick
   Access page and runs a trivial `Runtime.evaluate`, and records per sample: targets listed (ids
   and titles), each connect's outcome (ok / ECONNRESET / "socket hang up" / timeout / HTTP error),
   whether Decky's tab is on the rail, and the ms since the restart note. With `afterReload: true`
   it issues the reload itself first (through the existing reload code, which takes the lease) and
   starts sampling at once. Writes `runs/probe-debugger_<ts>.json` and returns a compact timeline
   plus `firstReadableQuickAccessMs`, `firstDeckyTabMs`, `resetsSeen`. This is the measurement the
   solo season's item 1 asks for, made one call.
3. **A reset inside the window is "rebuilding".** In `openPlugin`'s reads and target enumeration,
   when `msSinceLoaderRestart` is non-null and the failure is a connection reset, a hang-up, a
   refused connect or an empty target list, retry with backoff until the window closes instead of
   failing the call. Outside the window the old behaviour stands. Teach the fake CEP in
   `__testutil__` to reset connections for N ms after a "restart" so this is tested, and say in the
   report that the real shape is still unmeasured.
4. **Name the dialog.** On `this-pc` (2026-10-08) `deck_openPlugin` said "the panel did not mount"
   when bonsAI's first-run dialog held the ring. When the mount check fails and a read shows a
   modal or a dialog owning the ring, the failure names it and its focused control.

**Do not** change the chord, the rail walk or the reopen step from 2026-10-22; they are proven.

**Files you own:** `deck/loaderRestart.ts`, `deck/openPlugin*.ts`, `deck/cdp.ts` (additive),
`tools/deckAutonomy.ts` (reload + probe), `toolRegistry.ts` (one tool), `deck/__testutil__/*`.

**Phase 2 (Deck):** `deck_probeDebugger { afterReload: true }` three times; then bonsAI's stricter
set (reload, open at once, read, three rounds). Done when P89-RIG-OPEN-AFTER-RELOAD reads 3 of 3.
If it does not, the probe's timeline is the next fix's spec, which is still a win.

### Lane B — A press after the deadline refuses

**Read:** ROADMAP § Open bugs ("A tool call can hang…"), plan 11 lane D's honesty paragraph;
`callDeadline.ts`, `callQueue.ts`, `index.ts` dispatch seam, `deck/pressButton.ts`,
`checks/checkRunner.ts`, `deck/gameSession.ts` (run file paths).

**Build:**

1. **The deadline reaches the press.** The dispatch seam already knows the deadline; carry it in the
   same AsyncLocalStorage that carries the machine (or a sibling). `pressButton`, `pressChord` and
   the pad client check it before writing to the port or the socket, and refuse with the stage named
   when it has passed. A timed-out `walkTo` therefore cannot press beside the next call, which is
   the gap lane D left open. Test: a fake pad records zero writes from a call whose deadline passed
   mid-walk while a second call runs.
2. **`deck_replayChecks` with no names refuses** when the checks directory holds more than
   `maxChecks` (default 10), naming the count and asking for `names` or `all: true`. bonsAI ran 100
   walks for 25 minutes by accident on 2026-10-24.
3. **Run files go where the caller says.** Every tool that writes under `runs/` or `screenshots/`
   honours an optional `outDir` (absolute, or relative to the workspace), and `deck_getEnv` reports
   the defaults. Default behaviour unchanged.

**Files you own:** `callDeadline.ts`, `callQueue.ts`, `deck/pressButton.ts`, `deck/padClient.ts`,
`checks/checkRunner.ts`, the `outDir` plumbing in tools that write run files. In `index.ts` only the
seam line that stores the deadline (lane C also edits the seam; keep yours to one block).

**Phase 2 (`this-pc`):** a `deck_walkTo` with `deadlineMs: 300` beside a `deck_pressButton`; the
walk's error names its stage and the pad daemon's log shows no write after the error.

### Lane C — A ledger of every run

**Read:** ROADMAP § Planned, *Keep a log of every run automatically*; `index.ts` dispatch seam
(`runWithMachine`, `withImage`, the stamp), `deck/sweep.ts` and `deck/runSequence.ts` evidence
naming, `checks/checkFile.ts` name sanitising.

**Build:**

1. **`ledger.ts`** at the seam, not inside tools: after every `deck_*` and `plugin_*` call, append
   one JSON line to `runs/ledger/<session>.ndjson` (session = server start time + pid): ts, tool,
   machine `{ name, kind, os }`, `ok`, `durationMs`, `presses` and `fidelity` when the result has
   them, `evidenceFile` when it has one, `buildHash` and `runningGame` when a recent read knows
   them (cache the last `checkReady` / `listGames` answer per machine; never read the Deck to fill
   a ledger line), `rowId` when given, and the error's first line on failure. Errors and deadline
   expiries are logged too. Writing the ledger can never fail a call.
2. **`rowId` and `saveAs`** become accepted on every tool that writes evidence (sweep, runSequence,
   assertFocusMove, walkTo, launch/exit, snapshot, capture, record): `saveAs` names the evidence
   file (sanitised, no path escape), `rowId` is copied into the file and the ledger line.
3. **`deck_runReport { session?, rowId?, since? }`** reads the ledger and returns the markdown block
   a bonsAI testing row expects (tool, machine, build, verdict, evidence path) plus a totals line.
   Read-only.
4. `studio_doctor` gains one check: the ledger directory is writable.

**Files you own:** new `ledger.ts` + test, `tools/runReport.ts`, the `saveAs`/`rowId` plumbing in
the evidence-writing tools, `toolRegistry.ts` (one tool), one block in `index.ts`.

**Phase 2 (PC):** a session of five calls on `this-pc` produces five lines and `deck_runReport`
renders them; one call with `saveAs` names its file.

### Lane D — Type text, the honest fallback

**Read:** ROADMAP § Planned, *Type text on the Deck* (the fallback paragraph); `deck/fidelity.ts`,
`deck/readFocus.ts`, `deck/readPage.ts`, `deck/cdp.ts`.

**Build:**

1. `Fidelity` gains `"injected"`, ranked below `"wire-sent"`: the input bypassed the controller
   and Steam's on-screen keyboard and proves nothing about that path. The docs string on the tool
   says so in its first sentence.
2. **`deck_typeText { text, submit?, clear? }`**, a driving tool (takes the lease, obeys the
   killswitch, deadline default 60 s). Reads focus first and refuses unless the focused element is
   an `<input>`, `<textarea>` or `contenteditable` in the plugin's page, naming what it found
   instead. Focuses it with DOM `focus()` only when `gpfocus` already sits on it (never to move the
   ring), optionally clears it, sends `Input.insertText` on that page's CDP target, reads the
   element's value back and reports `valueAfter`, `matched`. `submit: true` dispatches
   `Input.dispatchKeyEvent` Enter and says so; it never presses A for the caller.
3. Refuses on a page that is not the plugin's panel (Steam's own text fields are not ours to fill
   by injection).

**Files you own:** `deck/fidelity.ts` (additive), new `deck/typeText.ts` + test,
`toolRegistry.ts`, `tools/deck.ts`.

**Phase 2 (Deck):** with bonsAI's Ask field under the ring, type a question, `submit: false`, read
the value; then press A through the bridge and confirm the reply arrives. The first Ask test with
no pinned chip.

### Lane E — Shortcuts on the shelf, and a grid that explains itself

**Read:** plan 11 lane F and its outcome, bonsAI `runs/p11-phase2-laneF-launch.json` (the
`find-grid-tile` stage), bonsAI's 2026-10-24 finding on non-Steam shortcuts; `deck/gameSession.ts`
(`gridStep`, the tile read, the shelf walk).

**What the Deck said on 2026-10-25:** the Library opened on the grid with real tiles (app ids from
the tile images, first ring on "ARC Raiders"), and after one row DOWN did not move the ring; the
tool refused with the last tile named and never pressed A. Three shortcuts on the shelf have no app
id in their image, so the shelf walk reached "View more in your Library" without seeing them.

**Build:**

1. **Shelf tiles by title and by position.** `deck_launchGame` takes `title` (the tile's visible
   text or aria label, exact first, then unique contains) and `shelfIndex`; a non-Steam shortcut
   resolved by `deck_listGames` (`nonSteam: true`) is matched by title on the shelf. The A press is
   still gated on a read naming the tile, and on the app page the button must read exactly `Play`.
2. **The grid read becomes evidence.** At every grid stop the run file records the full tile
   layout (every tile's app id and box, grouped into rows by `y`), the focused tile, the scroll
   position of the grid container and the page's route. A refusal's `reason` includes the row
   count seen and which row the ring was on. This is what makes the next Deck run a measurement.
3. **A read-gated fallback for the stalled DOWN.** When DOWN does not move the ring and the layout
   shows a row below, try one RIGHT (to the row's end) then DOWN, then one LEFT then DOWN, each
   gated on a read, before refusing. Mark it unmeasured in the code comment, as `gridStep`'s
   assumptions are.
4. Keep every refusal from plan 07 (Install / Update / Buy etc., a second game, ambiguity).

**Files you own:** `deck/gameSession.ts` + test, `toolRegistry.ts` (arguments only).

**Phase 2 (Deck):** launch Vampire Survivors (1794680, not on the shelf) and read the grid layout
from the run file whatever happens; launch Doom 64: Retribution by title from the shelf; exit each
with the process check. Three reads to confirm are the grid's row structure, whether the grid
container scrolls or paginates, and what DOWN does from the last tile of a row.

### Lane F — Studio issue intake

**Read:** ROADMAP § Planned, *Studio issue intake*; plan 01 § Part B; `tools/doctor.ts`,
`extension/src/commands/*`, `extension/src/extension.ts`.

**Build:**

1. **`studio_reportIssue { title, body, surface?, dryRun? }`.** Collects a diagnostic bundle:
   versions (root, extension, server, `SERVER_INFO`), `studio_doctor`'s result, the machine list
   with kinds (no hosts, no users), the last 20 ledger lines if lane C's ledger exists else the
   server's own in-memory ring of recent calls (tool, ok, duration, first error line), the latch
   state. **Redaction** removes IPs, usernames, home paths and anything matching `deck.env` values.
   Returns the rendered issue (markdown) with `dryRun: true` or by default; posts only with
   `dryRun: false`, via `gh issue create` when `gh` is authenticated, else returns a prefilled
   `https://github.com/qd313/decky-plugin-studio/issues/new?...` URL. Never posts without the
   rendered body having been returned to the caller once (a `confirmToken` from the dry run).
2. **Decky: Report Studio Issue** command in the extension: runs the dry run, opens the markdown in
   an editor, and a second step posts or opens the URL.
3. `.github/ISSUE_TEMPLATE/bug.yml` and `finding.yml`; labels `surface:deck`, `surface:standin`,
   `surface:extension`, `surface:server`, `source:agent`, `source:human` documented in the template.
4. Failed tool errors carry a `reportId` (short hash of tool + ts) so a filed issue can quote one.

**Files you own:** new `tools/reportIssue.ts` + test, `toolRegistry.ts`, the extension command
and its `package.json` contribution (a command entry only; no version change), `.github/ISSUE_TEMPLATE/`.

**Phase 2 (PC):** one dry run from the bonsAI checkout, the maintainer reads the bundle for anything
that should have been redacted, then one real post of the oldest "needs filing" finding.

### Lane G — Sleep the Deck and wake it again

**Read:** ROADMAP § Planned, *Sleep the Deck and wake it again* (all of it, including the measured
`rtcwake` timings); `deck/holdAwake.ts` (the inhibitor and the measured `SuspendPC` path);
`deck/killswitch.ts`; `deck/gameSession.ts` (the running-game read).

**Build `deck_sleepAndWake { seconds, via? }`**, a driving tool, steamos/bazzite only, refusing on
every stand-in and on Windows by kind before anything else:

1. **Refuse** with a game running (read `RunningApps` and the process list), with a `deck_holdAwake`
   inhibitor held by anyone (logind would refuse the suspend; say so and name the tool that releases
   it), and when `seconds` is under 45 or over 600.
2. **Arm the way back first.** `sudo rtcwake -m no -s <seconds>` over SSH, then read
   `/sys/class/rtc/rtc0/wakealarm` back and compare to the expected epoch within a tolerance. If the
   read-back fails, refuse without sleeping. (This is the proven, cheapest way back; 2026-09-08.)
3. **Record before.** Focus read, route, the killswitch file's mtime, `uptime -s`, written to
   `runs/sleep-wake_<ts>.json` before the suspend.
4. **Suspend by the measured path:** `SteamClient.System.SuspendPC()` in `SharedJSContext` over CDP,
   reported as `via: "steam-suspend-call"`, fidelity `null` (not a press). The power-menu route is
   `via: "power-menu"` and is **not built this lane**; the argument accepts it and refuses with
   "not implemented" so the shape is fixed.
5. **Wait for the Deck to be gone, then back.** Poll SSH: it must stop answering within 30 s (if
   it never does, report `suspended: false` and clear the alarm with `rtcwake -m disable`), then
   answer again within `seconds + 60`. Reconnect CDP (the tunnel code handles this), read focus
   **without pressing anything and without opening the panel**, and record after: focus, route,
   `visibility`, whether the killswitch file survived with the same content, uptime, the journal's
   suspend and resume lines if readable.
6. **Report plainly** when focus came back somewhere unexpected; never press on to "fix" it.
7. Clear the alarm at the end whether or not it fired.

**Files you own:** new `deck/sleepWake.ts` + test (seams for ssh, cdp, clock, as `holdAwake` does),
`toolRegistry.ts`, `tools/deckAutonomy.ts`.

**Phase 2 (Deck):** one run with `seconds: 90`, nothing running, bonsAI's panel open; the
maintainer present the first time. Done when the run file shows the before/after focus and the
Deck is back on the network inside the window. This is the one lane whose failure can strand the
Deck; the armed alarm is the safety net, and the maintainer's thumb on the power button is the
second.

### Lane H — The firmware says which program it runs

**Read:** `bridge/README.md`, `bridge/firmware/deck_bridge/deck_bridge.ino` (the `status` reply),
`bridge/tools/pad.py`, `deck/bridgeTools.ts`, `tools/deckAutonomy.ts` (the status fields), the
roadmap's "program version in the status reply" notes under the Steam-button bug.

**Build:**

1. Firmware `07_version`: a `#define FW_PROGRAM "07_version"` and the `status` reply (and the boot
   banner) carry `"fw": "07_version"`. No other behaviour change; the trigger rest stays at -127.
   Bump the README's firmware table and the flash notes.
2. `pad.py status` passes the field through; `deck_status` reports `bridgeFirmware` (the string, or
   `"unknown (pre-07)"` when absent, never a guess from the axes). The LT/RT reflash refusal names
   the running program when known.
3. `studio_doctor` reports the firmware when the port is free and `unknown` when it is not.

**Files you own:** `bridge/firmware/deck_bridge/deck_bridge.ino`, `bridge/README.md`,
`bridge/tools/pad.py`, `deck/bridgeTools.ts`, `tools/deckAutonomy.ts` (status fields),
`tools/doctor.ts` (one check).

**Phase 2 (Deck):** the maintainer flashes with the Deck-side cable unplugged, as for `06`;
`deck_status` reads `bridgeFirmware: "07_version"`, triggers rest at -127, one lone GUIDE opens the
menu and B closes it.

## How this lands

- **Worktrees as siblings, not nested.** Plan 11's lanes ran `pnpm install` in worktrees under
  `.claude/worktrees/` and `main`'s own `node_modules` emptied (cause not found). This time:
  `git worktree add ../dps-lanes/<lane> -b p12/<lane>`, each lane runs `pnpm install
  --frozen-lockfile` once in its own tree, and `main`'s `node_modules` is checked before the first
  merge. A hung test process blocked a worktree removal last time: lanes must not leave `node
  --test` or `tsx` running.
- **Merge order:** H, D, F, C, B, E, G, then A last (A touches the most shared code). One squashed
  commit per lane, `git revert`-able.
- **Expected conflicts:** the `test` script line (every lane), `toolRegistry.ts` (A, C, D, F, G,
  H), `index.ts` (B and C), `tools/deckAutonomy.ts` (A, G, H). Resolved by hand at merge.
- **Docs are written once at the end**, from the lane reports and then again from phase 2's
  verdicts: ROADMAP (close the 2026-10-25 verdicts in Open bugs, retire the `preview.test.ts`
  entry, move the eight features), CHANGELOG, MCP_TOOLS, AGENTS, the pack copy, the bundled server
  manifest. Tool count after the session: 44 + 5 (probeDebugger, runReport, typeText,
  reportIssue, sleepAndWake) = 49.
- **No version bump until after phase 2.** Then 0.3.12: fold `[Unreleased]` into `## [0.3.11]`
  and `## [0.3.12]`, bump root, extension, server and `SERVER_INFO` together, push, let
  `build-vsix.yml` cut the release. The 0.3.11 release on GitHub still holds the 2026-10-06 build.
- **Issue #6** (bonsAI no longer uses the preview) is closed by the retirement and is the
  maintainer's to close; **issue #3** closes only on a 3-of-3 Deck verdict.

## Phase 2 — the device pass

| # | Lane | Machine | What settles it |
|---|------|---------|-----------------|
| 1 | H | Deck | Flash `07_version`; `deck_status` names it; GUIDE opens the menu, B closes it |
| 2 | B | `this-pc` | A deadline-expired walk beside a press writes nothing to the pad |
| 3 | C, F | PC | Five ledger lines and a report; one dry-run issue bundle read for leaks, one real post |
| 4 | A | Deck | Three probes after reload; then the stricter three-round open test |
| 5 | D | Deck | Type into bonsAI's Ask field, A through the bridge, reply arrives |
| 6 | E | Deck | Vampire Survivors from the grid (read the layout either way); Doom 64 by title |
| 7 | G | Deck | One 90 s sleep with the maintainer present; before/after focus in the run file |

Item 7 runs last and alone. Items 4 to 6 need the Deck's lease free of bonsAI sessions, as on
2026-10-25.

## Outcome (2026-11-02)

Run the same day it was approved, from the planning session itself, with `main` at `df90060`
(the plan commit). All eight lanes were spawned at once (Opus for A, E and G, Sonnet for the
rest) into sibling worktrees `../dps-lanes/<lane>` on branches `p12/<lane>`; every lane ran
`pnpm install --frozen-lockfile` in its own tree and `main` was untouched by it (the 2026-10-24
"node_modules emptied" reading was most likely `ls` without `-a` on a pnpm root that holds only
dot-entries). Lanes finished between 8 and 25 minutes after spawn; merges went in the order the
lanes reported, which was H, B, D, F, C, G, E, A, one squashed commit each. Conflicts: the `test`
script line (every lane but E), `index.ts` at the dispatch seam (B's `outDir` check, D's per-tool
default deadline, F's call ring, C's ledger wrapper, G's sleep deadline, A's `callClassOf(tool,
params)`), `tools/deckAutonomy.ts` imports and the function boundary between H's
`readBridgeFirmware` and G's `sleepAndWakeFromParams`, `tools/doctor.ts` (H's and C's checks),
`tools/deck.ts` and the three evidence writers (B's `outDir` beside C's `saveAs`; the signatures
now take `saveAs` then `outDir`), and the `deck_openPlugin` / `studio_doctor` descriptions in the
registry. All resolved by hand with a small Python script per merge. Tests: 590 → 850 in
`mcp-server`. `pnpm build`, the extension typecheck and `pnpm run package:vsix` with the bundled
smoke test are green; the VSIX is 8.2 MB (2785 files). Tool count 49.

| Lane | Commit | Tests added | What its honesty paragraph said to check on a device |
|------|--------|-------------|------------------------------------------------------|
| A | `4bd0436` | 38 | The fake CEF's restart is a guess (a clean block of resets, hang-ups or empty lists, then health). The real one may refuse only the Quick Access socket while the list answers, 404 stale ids on upgrade (an `http-error`, deliberately not retried), stall into timeouts (not retried), or flap past 120 s. A reload done by hand or by Decky writes no note. `wait-rebuilding` can cost up to 120 s inside the window, unmeasured. Only `ModalDialogOverlay` has been read for the dialog naming. Three `deck_probeDebugger { afterReload: true }` runs settle the shape; the stricter 3-round open test settles issue #3. |
| B | `633cda5` | 19 | The headline test uses a loopback vpad, never the serial `pad.py` path, where the fence is a check just before `spawn`; a `pad.py` already spawned and acked before the deadline is unaffected. AsyncLocalStorage was proven across timers, sockets and the walk's sleep, not across a real SSH tunnel acquire. Reads can still run after the deadline; only presses are fenced. `outDir` on screenshot and record is untested end to end. |
| C | `d268552` | 61 | The seam is covered by a source-text check plus one private smoke run of registry tools; no driving tool's result has gone through it. `presses` and `fidelity` are copied by field name from fixtures, never from a recorded Deck result. `buildHash` appears only when `deck_checkReady { buildMatches: true }` ran in the same server process within 30 min. Cross-process append on Windows is untested. The markdown shape is read from testing.md's prose, not confirmed with bonsAI. |
| D | `aa3938d` | 40 | The fake DOM is the lane's own model of Chromium and React. Nothing shows Steam's CEF accepts `Input.insertText` in gamepad-UI mode, that the `input` event reaches bonsAI's React state, or that the ring sits on the `<input>` itself rather than a Focusable wrapper (in which case the tool refuses every time). Enter as a synthetic key event may not submit. |
| E | `a7061de` | 20 | The fake's grid (row-major, equal tops, a stall a neighbour's DOWN gets past) is invented; the real cause of the 2026-10-25 stall is unknown, so the fallback may be 3 to 6 wasted presses. `gridTiles` dedupes by app id and keeps the first `<img>`, so hero art elsewhere on the page would displace a tile's box and could invent a "row below". A grid that scrolls by transform or paginates reads `scroll: null`. The title match trusts the ring's own label; the one shelf read that saw shortcuts does not say whether the label or the text carried the name. "Any app in RunningApps" would accept a launcher starting. |
| F | `9b2a533` | 29 | Every post test uses a fake `gh`: the `--body-file -` stdin path on Windows, `--label`, and the stderr wording the label-missing regex matches are unproven. Whether GitHub keeps `title`, `body` and `labels` on `issues/new` when issue forms exist, and whether a 7000-character URL survives, is untested. Redaction catches the values it was told about and nothing else: plugin names, hostname aliases not in `machines.json`, SSH key paths outside home, pass through. The extension command is typechecked only. |
| G | `2814256` | 33 | Every seam is faked to the 2026-09-08 timings. Unproven: that a deferred `SuspendPC()` suspends; that SSH goes quiet inside 30 s and two failed fresh probes are not a Wi-Fi blip; that wakealarm reads back on the Deck's clock within 5 s (an RTC in local time refuses, the safe side); that the kernel empties wakealarm after it fires (`alarmFired` depends on it); that `sudo -n rtcwake -m disable` exits 0 with no alarm; that CEF answers within 30 s of SSH returning; that the journal grep catches the real lines. Needs NOPASSWD sudo for `rtcwake` (the `setup-dev.ps1` sudoers rule covers it). |
| H | `ba0b771` | 20 | Everything is injected or source-text. The `.ino` compiles clean (`arduino-cli`, 373 KB) but the status reply's real bytes are unseen; a printf slip in `reply()` could drop `ax` and break the LT/RT refusal logic. `parseStatusFirmware` has seen hand-written lines, not a live port with CRLF and banner noise. Flashing is untested. |

**Decisions made at merge time, for the maintainer to veto:** lane C does not log `deck_status`,
`deck_automationStatus` or `deck_runReport` (the extension polls status every 30 s); lane F's
`confirmToken` is bound to the stored render, not a fresh one (a re-render would never match,
since the bundle carries timestamps); lane H's doctor reads a board that answers without a name as
`ok` with "flash deck_bridge" in `saw`, reserving `unknown` for not asked, leased or unreached;
lane G takes the machine's lease at the seam before its own kind check refuses on a stand-in;
lane D's default deadline is 60 s through a per-tool table at the seam.

**Open after the session, owed to phase 2** (the table at the top of this file): all of it.
Nothing has run on a device. The push and the 0.3.12 bump wait for the pass, as the plan says.

## Phase 2 outcome (2026-11-03)

Run from the same session the next morning, after a usage cut-off overnight. The session's own
MCP tools were the pre-merge server, so the pass drove the freshly built `mcp-server/dist` over
stdio from a 90-line client (`drive.mjs`, one server process per invocation, `DRIVE_PARALLEL=1`
to fire two calls into one process), with bonsAI as the workspace. The Deck was idle on its
screensaver, bonsAI's panel shut, no lease held, the rig armed; bonsAI's own test runner was busy
on the PC but did not touch the Deck.

| # | Item | Verdict |
|---|------|---------|
| 1 | H | Not flashed (the maintainer's hand). The negative read passed on the real board: `bridgeFirmware: "unknown (pre-07)"`, and the doctor check says to flash. The stand-in's pad daemon answers `"vpad"`. |
| 2 | B | Could not run on `this-pc`: `deck_focusBigPicture` switched Steam to Big Picture and asked for the front, the gate stayed hidden, `checkReady` failed, nothing pressed. Run on the Deck instead: a walk with `deadlineMs: 300` beside a press in one server returned the deadline error naming "press DOWN" with the pad release acked; the press waited 506 ms and ran steam-routed; a sweep with `outDir` and `saveAs` landed in the scratch folder. The late press's refusal is only on the server's stderr and was not captured. |
| 3 | C, F | 9 of 9 doctor checks. Ledger lines per call, `deck_runReport {}` and `{ rowId }` across sessions. Dry-run bundle clean of addresses, user names and home paths; `gh` authenticated; nothing posted (the real post is the maintainer's call). |
| 4 | A | Three probes: the window is about 7 s (old pages to 0.75 s, resets to 3 s, partial list to 6 s). Three rounds of no-wait reload then open from a new process: **3 of 3 first-try opens**. The second probe's restart hung for seven minutes; see below. |
| 5 | D | Acceptance row passed: clear and type matched on the Ask `<input>` itself, an append matched, four D-pad presses to "Ask", A steam-routed, the field cleared, the reply arrived. |
| 6 | E | Doom 64: Retribution launched by title from the shelf and exited with the game running. Vampire Survivors from the grid stalled at row 5 with the layout recorded (five tiles a row, a scrolling container, four rows below that DOWN would not enter; RIGHT moved and scrolled the container a row). |
| 7 | G | Not run; waits for the maintainer to be present. |

**Found and fixed during the pass.** `sshRestartLoader` ran its `ssh` through `execSync` with
`stdio: "inherit"` and no timeout. Probe 2's restart child sat seven minutes with no TCP socket
and nothing in the Deck's journal, and because `execSync` blocks the event loop the call's deadline
never fired; the chain was killed by hand. The fix (`-n`, BatchMode, a 10 s connect timeout,
captured output, a 60 s exec timeout) made the next three restarts take 0.6 s. The copy steps in
the same file still use the old shape.

**Also seen:** the first open from the screensaver fails on the chord and the retry inside the same
call opens the panel; the grid refusal's reason text has mojibake where the run file does not;
bonsAI's panel still had the Hollow Knight chat open, so the typed question was answered about
Hollow Knight with "No game" running.

**Left for the maintainer:** the `07_version` flash and its hand test; the first
`deck_sleepAndWake { seconds: 90 }` with a thumb on the power button; one real
`studio_reportIssue` post; an alt-tab to Big Picture on `this-pc` if the stand-in half of lane B is
wanted; bonsAI's row P89-RIG-OPEN-AFTER-RELOAD from their own session; then the push and the
0.3.12 bump.
