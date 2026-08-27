# Parallel bug-fix session — five lanes over the seven open ★ bugs

Written 2026-08-27. Covers the seven `Open` bugs in [ROADMAP.md](../ROADMAP.md) found 2026-08-26/27.
Run this from a fresh Opus session (orchestrator). Each lane below is a complete, self-contained
subagent prompt — paste it verbatim into an Agent call.

## Orchestrator instructions

- Spawn all five lanes at once: `Agent` tool, `model: "sonnet"`, `isolation: "worktree"`,
  background (the default). Do not fix anything yourself in phase 1 — your job is dispatch,
  diff review, and merge.
- **Acceptance bar for every lane:** a unit test that failed before the fix and passes after,
  run via the repo's existing harness (`fakeCdp` lives at
  `mcp-server/src/deck/__testutil__/fakeCdp.ts`; see `readPage.test.ts`, `walkTo.test.ts`,
  `runSequence.test.ts` for the idiom). Do not accept "fixed" without the test. Reject diffs
  that refactor beyond the bug.
- **Known merge hotspots:** `mcp-server/src/toolRegistry.ts`, `toolRegistry.test.ts`, and
  `mcp-server/src/index.ts` — lanes 1, 3, and possibly 4 all make small additive edits there
  (new option/field wiring). Conflicts will be trivial; resolve them yourself at merge, don't
  bounce them back to the agents. Merge lanes 2/4/5 (no or minimal schema changes) first,
  then 1 and 3.
- After merging all five: run the full mcp-server test suite once, then build, then stop.
  **Phase 2 (below) is serial, on-device, and human-scheduled — do not start it yourself.**

## Phase 2 — one on-device verification pass (serial, do NOT parallelize)

One Deck, one bridge COM port, one focus ring. Coordinate with bonsAI work: the killswitch
latch (`~/.config/decky-plugin-studio/automation-stop.json`) and the source-tree MCP server
are shared, so nothing else may drive the Deck during this pass.

1. First act of the session: one harmless direction press to probe the bridge (working rule
   from 2026-08-27; also the motivation for lane 1's `bridgeReady`).
2. `deck_status` with the board unplugged → `bridgeReady: false` + port name; replug → `true`.
3. `deck_getEnv` with a bogus `DECK_IP` → returns within the deadline, timeout reported as a
   finding, not a hang.
4. Open the plugin, let an Ask finish (ring unowned), then `deck_runSequence` with no manual
   pre-press → runs, does not abort with "could not read focus before the run started".
5. With the plugin panel already open, `deck_openPlugin` for the same plugin →
   `ok: true, alreadyOpen: true`.
6. `deck_waitFor` on a streaming Ask: not satisfied while the expression returns `null`;
   satisfied promptly once it returns a truthy/matching value.
7. `deck_deploy` against the bonsAI plugin (installed at `~/homebrew/plugins/bonsAI/`,
   root-owned) → deploys with correct case via temp-dir + elevated move.
8. From a **built tree** (`dist`), `deck_captureScreenshot` → produces pixels, no
   "Missing capture scripts".

---

## Lane 1 — `deckAutonomy.ts`: `deck_getEnv` hang + `deck_status` bridge health

You are working in a worktree of decky-plugin-studio (a VS Code extension + MCP server for
Steam Deck plugin development). Fix two related bugs, both in
`mcp-server/src/tools/deckAutonomy.ts`, both "a probe needs a deadline / a status needs a
probe". Touch nothing on real hardware; all verification is unit tests.

**Bug A — `deck_getEnv` hangs forever on an unreachable `DECK_IP`.** `getEnv()` calls
`probeRemoteDeck()` (defined around line 135, called around line 179) whenever a non-local
host is configured, and that SSH probe has no timeout. With a wrong IP the tool never
returns — measured at >40s before the caller gave up, against `pingDeck()`'s 1s deadline in
the same call. Fix: put a deadline on the probe (a few seconds), and when it expires return
normally with the timeout reported as a finding in the result (e.g.
`remote: { unreachable: true, reason: "ssh probe timed out after Nms" }`) — never a hang,
never a throw that hides the rest of the env report.

**Bug B — `deck_status` reports everything except the thing that actually blocks sessions.**
It reports tunnel, ingest, Deck reachability and Ollama, but not whether the ESP32 bridge
can open its COM port. In a live session the board was unplugged and nothing surfaced it
until the first press was attempted. Fix: in the status result add `bridgeReady: boolean`
plus the configured port name. Probe by attempting to open the configured serial port (or by
invoking `bridge/tools/pad.py` in a status/no-op mode — read how
`mcp-server/src/deck/pressButton.ts` locates and invokes the pad tool via `findPadTool()`
and follow the same resolution so installed-VSIX and source-checkout layouts both work).
The probe must have a short deadline and must never press a button or write to the board's
input state. If the pad tool or port is absent, `bridgeReady: false` with a reason string —
absence of hardware is a normal, reportable state, not an error.

**Requirements:** for each bug, write a unit test that fails on the current code and passes
with your fix (fake the probe/port layer; do not require hardware or network). Follow the
existing test idiom in `mcp-server/src` (`node:test` style, see `killswitch.test.ts`).
If you add fields to the `deck_status` schema in `mcp-server/src/toolRegistry.ts`, keep the
edit minimal and additive. Run the mcp-server test suite before finishing. Your final report:
what you changed, test names, and any behavior you chose that the spec above left open.

---

## Lane 2 — `deck_waitFor` reports satisfied/unsatisfied wrongly, in both directions

You are working in a worktree of decky-plugin-studio. Fix one bug in
`mcp-server/src/deck/readPage.ts` — `waitFor()` (around line 205). This tool is the
reply-finished oracle for every Ask macro on the Deck rig, so a wait that lies is the exact
false-instrument class the rig exists to remove. All verification is unit tests against the
fake CDP server (`mcp-server/src/deck/__testutil__/fakeCdp.ts`); see the existing
`readPage.test.ts` waitFor tests for the idiom.

**Observed on device, four times across two sessions on 2026-08-27:**

- *False positive:* an expression returning `null` came back
  `satisfied: true, polls: 1, waitedMs: 465` while the thing it was waiting on was still
  streaming. The tool's own description says it "stops on the first **truthy** value", and
  `null` is not truthy.
- *False negative (×3):* expressions returning a populated object
  (`value: {done: true, fences: 1}`), and separately a plain boolean `true`, came back
  `satisfied: false` after the full timeout — the condition it was asked for, sitting in the
  result it called a timeout. So "return only booleans" is not a workaround.

**Fix:** audit the truthiness test and the `equals` comparison paths in `waitFor()`. Likely
suspects: how the CDP evaluate result is unwrapped before the truthiness check (a wrapper
object around `null` is truthy; a value that needs unwrapping compares unequal), and any
difference between the poll-loop check and the final verdict. Find the actual defect — do
not just patch the four symptoms.

**Requirements:** regression tests for each direction: (1) expression yields `null` /
`undefined` / `false` → keeps polling, not satisfied; (2) expression yields a truthy object →
satisfied; (3) expression yields boolean `true` → satisfied; (4) `equals` matching still
works both ways (existing tests cover some of this — extend, don't weaken). Each new test
must fail on the current code. Keep the fix inside `readPage.ts` (plus tests) unless the
defect genuinely lives elsewhere — if so, say exactly where and why. Run the mcp-server test
suite before finishing. Final report: root cause in one paragraph, test names, files touched.

---

## Lane 3 — ring semantics: `deck_runSequence` unowned start + `deck_openPlugin` already-open

You are working in a worktree of decky-plugin-studio. Fix two sibling bugs that share one
piece of domain knowledge: on the Steam Deck, after **every** plugin open and after **every**
finished Ask, *nothing owns the focus ring* — an unowned ring is the normal resting state,
not an edge case. `mcp-server/src/deck/walkTo.ts` already handles it: its `acquireFocus`
option (see ~line 60 and the handling at ~line 180, default **on**) places the ring before
walking. Read `walkTo.ts` and `walkTo.test.ts` first; they are the reference implementation.
Never verify on hardware; use the fake CDP harness
(`mcp-server/src/deck/__testutil__/fakeCdp.ts`, idiom in `runSequence.test.ts` and
`walkTo.test.ts`).

**Bug A — `deck_runSequence` refuses to start from an unowned ring**
(`mcp-server/src/deck/runSequence.ts`). It reads focus before pressing and aborts with
`"could not read focus before the run started, so nothing was pressed"` when nothing owns
the ring — i.e. in the state every run naturally starts from. The current workaround (a bare
`deck_pressButton` first) wastes a press and puts the ring somewhere the caller did not
choose. Fix: give `runSequence` the same `acquireFocus` option as `walkTo`, **defaulted on**,
reusing walkTo's mechanism rather than duplicating it (extract/share if needed). With
`acquireFocus: false` and an unowned ring it should still refuse, with the same style of
actionable message walkTo uses. Wire the new option through `mcp-server/src/index.ts`
(`tools/deck_runSequence` case) and the `deck_runSequence` schema in
`mcp-server/src/toolRegistry.ts` — walkTo's `acquireFocus` schema entry (~line 311) is the
template. Keep registry edits minimal and additive.

**Bug B — `deck_openPlugin` fails when the panel is already open**
(`mcp-server/src/deck/openPlugin.ts`). With the target plugin's panel already on screen and
the ring inside it, the tool walks the Decky plugin list looking for the plugin's entry,
finds nothing, and reports `walked 1 control(s) without finding "<name>"` with `ok: false` —
while its own failure payload contains the evidence it needed (`deckyPluginRoot: true`, ring
on a plugin control). Fix: before (or instead of) failing, detect ring-inside-plugin-content
for the *requested* plugin and return success with `alreadyOpen: true` in the result. Be
conservative: only claim `alreadyOpen` when the focus payload actually identifies the
requested plugin's content — a different plugin's panel must still fail with the current
message.

**Requirements:** failing-then-passing unit tests for: runSequence from an unowned ring
(succeeds, acquires first), runSequence with `acquireFocus: false` (refuses with guidance),
openPlugin with panel already open (ok + `alreadyOpen: true`), openPlugin with a *different*
plugin open (still fails). Run the mcp-server test suite before finishing. Final report:
what you changed, what you shared between walkTo and runSequence, test names.

---

## Lane 4 — `deck_deploy`: wrong-case target, unwritable destination, unhelpful error

You are working in a worktree of decky-plugin-studio. Fix `deck_deploy`, which failed
against a real device with the bare message
`Error: Command failed: scp -r ... deck@…:~/homebrew/plugins/bonsai/dist` for a plugin
installed at `~/homebrew/plugins/bonsAI/`. Two defects behind one unhelpful message. The
code path: `mcp-server/src/index.ts` case `tools/deck_deploy` → `deployPlugin()` in
`mcp-server/src/tools/plugin.ts` (~line 75) → `deployRemote()` in
`mcp-server/src/tools/deck.ts` (~line 306). No hardware; unit-test with the exec layer faked.

**Defect A — the target directory name is normalized instead of read.**
`plugin.ts:83` does `String(info.name).replace(/\s+/g, "-").toLowerCase()`, so a plugin
whose `plugin.json` `name` is `bonsAI` deploys to `bonsai`. The installed directory on the
Deck is named by the manifest, case intact. Use the manifest `name` for the **remote** target
directory. Check where else the normalized name is used before changing it globally — the
local-copy path (`copyPluginToLocal`) may legitimately want normalization; if so, split the
two rather than changing both behaviors. State in your report what you decided and why.

**Defect B — the installed directory is root-owned, so plain `scp` as `deck` cannot write it
even with the right case, and the error surfaces neither fact.** Adopt the pattern the
consumer's own workaround uses (bonsAI's `build.ps1`): upload to a temp dir on the Deck as
`deck`, then move into place elevated (the codebase already runs elevated helpers on the
Deck — see how `installCaptureHelperOnDeck` / the capture orchestrator push files, and
follow the existing ssh/scp helper conventions in `deck.ts` / `captureOrchestrator.ts`).
When the destination still is not writable, the error must say *that* — target path, owner
problem, what to do — instead of echoing the failed scp command line.

**Requirements:** unit tests (exec layer faked) proving: remote target preserves manifest
case; deploy goes via temp-dir + elevated move; a permission failure produces the diagnostic
message, not a raw command echo. Tests must fail on current code. Do not change
`deck_reloadPlugin` behavior. Run the mcp-server test suite before finishing. Final report:
decisions on name normalization, the exact remote command sequence you emit, test names.

---

## Lane 5 — capture scripts never reach `dist`, killing `deck_captureScreenshot` from a source checkout

You are working in a worktree of decky-plugin-studio. Fix a packaging-class defect: running
the MCP server from the source tree (the configuration this repo's own `mcp.json` warning
pushes consumers toward), `deck_captureScreenshot` dies with
`Missing capture scripts: …/mcp-server/dist/scripts/deck/studio-capture-common.sh or
studio-capture.sh`. The resolution happens in `bundleDeckScript()` in
`mcp-server/src/tools/captureOrchestrator.ts` (~line 81), which throws at ~line 86. The
build compiles TypeScript into `dist` but never copies `scripts/` there. Consequence in live
rig sessions: walks produce JSON evidence but no pixels — the biggest evidence-quality gap
in on-device QA today.

**Fix, both halves:**

1. Make the mcp-server build copy the capture scripts into `dist` (find where the scripts
   actually live in the source tree and how the build is defined in `mcp-server/package.json`
   before deciding the mechanism; keep it cross-platform — this repo is developed on
   Windows, so no bare `cp` in an npm script). As a belt-and-braces fallback, if
   `bundleDeckScript()` finds `dist/scripts/...` missing, let it resolve the same files from
   the source tree relative to the package root before throwing — and when it does throw,
   name both locations it tried.
2. **A smoke test that catches the class, not the instance.** This is the third
   packaging-omission of this kind (VSIX missed MCP `node_modules`; VSIX missed
   `bridge/tools/`; now this). Precedent: `extension/scripts/smoke-mcp-bundle.mjs` starts
   the bundled server exactly as the installed extension does and fails packaging unless it
   answers `initialize`. Add the equivalent for this class: after a build, a check that
   *calls* the capture path far enough to prove the scripts resolve from `dist` (it must not
   need a Deck — resolving and reading the script files is enough; a unit test on
   `bundleDeckScript()` pointed at a real built `dist` is acceptable if it runs in the build
   or test pipeline, not just when someone remembers).

**Requirements:** the resolution test must fail on the current build output and pass after.
Verify by actually running the build and the mcp-server test suite. Do not touch the VSIX
bundling scripts except where this fix genuinely overlaps. Final report: where the scripts
live, what the build now does, what the smoke check covers, test names.
