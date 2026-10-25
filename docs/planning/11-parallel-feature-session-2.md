# Parallel feature session 2 — eight lanes

Written 2026-10-22, planned by Fable 5.1 (extra-high reasoning). Replaces the eight-lane plan in
[09-parallel-feature-session.md](09-parallel-feature-session.md), which ran on 2026-09-07/08 and
is done. Same shape as plan 09: every lane is a complete subagent prompt, meant to be pasted
verbatim into an `Agent` call. Run this from a fresh orchestrator session.

## Where the work comes from

Nothing here is invented. Every lane answers a thing the consumer (bonsAI) hit on a real machine
and wrote down, or a promise this repo made and never kept:

- GitHub issues [#4](https://github.com/qd313/decky-plugin-studio/issues/4) and
  [#5](https://github.com/qd313/decky-plugin-studio/issues/5) (2026-10-11): on the Windows
  stand-in a verified press costs 20–30 s, there is no screenshot at all, and nothing checks that
  Big Picture is the front window, so the first press goes blind.
- bonsAI's DPS findings log (`Documents/bonsAI/docs/mcp-setup.md` § "DPS findings log"), which
  holds about twenty "Open, needs filing" notes against DPS tools that never reached this repo:
  a walk that hung 35 minutes, a tool that stalled 29 minutes, the server dropping mid-call, a
  lease refusal naming a holder that was the caller itself, two presses clashing on the bridge
  port, the exit tool trusting an empty `RunningApps` while the game ran at full CPU, the launcher
  unable to see anything off the Recent shelf, `deck_getEnv` reading `inactive inactive` for a
  running loader, a second snapshot refused when the driver only wanted proof.
- Promises in ROADMAP.md: `requireVisible` was to flip to fail-by-default "next release" on
  2026-08-31 and never did; *A self-check for DPS itself* was cut from plan 09 for capacity, not
  merit; the `@decky/api` shim lacks `useQuickAccessVisible`, a one-line gap that stopped bonsAI's
  panel ever mounting in the preview (finding P0-1, 2026-08-08), until bonsAI gave up on the
  preview (issue [#6](https://github.com/qd313/decky-plugin-studio/issues/6)). **The maintainer
  retired the preview on 2026-10-24**; lane G removes it rather than fixing it.

The dividing line is the same as plan 09: anything whose risk lives at the desk runs in parallel.
Anything whose hard part is "what does this hardware actually do" is in the solo season below.
New since plan 09: **the Windows stand-in `this-pc` is the maintainer's own PC**, so three lanes
(A, B, C) can be proven on a real Steam without the Deck at all. That is desk time, not Deck
time, but it still needs the person's hands off the keyboard while Big Picture is in front.

## Orchestrator instructions

- Spawn all eight lanes at once: `Agent` tool, `isolation: "worktree"`, background. Use
  `model: "opus"` for lanes D and F (they change behaviour under a lot of callers) and
  `model: "sonnet"` for the rest. **Do not implement anything yourself in phase 1.** Your job is
  dispatch, diff review, and merge.
- Each worktree needs `pnpm install` first. Tell each lane so.
- Base every lane on `main` at `43afc0b` or later. The full suite is green there: 493 tests in
  `mcp-server`, 2 in `preview-server`. Four stale local branches (`p81-walk-text`, `p89/r1`,
  `p89/r2`, `p89/r3`) hold nothing `main` lacks (`git cherry` says every commit is applied); they
  and the three leftover worktrees can be deleted before the session.
- bonsAI is checked out at `C:\Users\still\Documents\bonsAI`. Lanes may **read** it for evidence
  files and the findings log. No lane writes there.

### Acceptance bar for every lane

Unchanged from plan 09, and still not a formality:

1. **A test that fails before the change and passes after.** Show the failing output. The
   harness is `node:test` + `tsx`; the fake CDP server is `mcp-server/src/deck/__testutil__/fakeCdp.ts`.
   Read `readFocus.test.ts`, `openPluginRetry.test.ts`, `lease.test.ts`, `settingsSnapshot.test.ts`
   for the idiom. New test files must be added to the `test` script in `mcp-server/package.json`
   or they never run.
2. **The full suite green** (`pnpm -r test` at the root) and `pnpm build` clean.
3. **The honesty paragraph.** In the report: *what could this test pass while the real thing is
   broken?* If the answer is "everything", say so, and the feature is marked device-unverified.
   Four `deck_openPlugin` fixes in a row passed their fake-CEF tests and failed on the Deck this
   month. That is the bar's reason.
4. **No scope creep.** Reject diffs that refactor beyond the stated change.
5. **Plain language in results and errors.** A refusal names what was checked, what was seen, and
   what to do. No new jargon fields without a one-line description in `toolRegistry.ts`.

### Files no lane may touch

`docs/ROADMAP.md`, `CHANGELOG.md`, `docs/MCP_TOOLS.md`, `AGENTS.md`,
`extension/resources/pack/AGENTS.md`, and the `version` field in any `package.json` or
`SERVER_INFO` in `mcp-server/src/index.ts`. The orchestrator writes the docs once at the end.

### Known merge hotspots

`mcp-server/src/toolRegistry.ts` and `mcp-server/src/index.ts`. Lanes B, C, E, F, H add fields,
tools or description text there; lane D changes the dispatch seam itself. All additive except D.
`toolRegistry.test.ts` already diffs the registry against the dispatch cases both ways, so a
tool added to one and not the other fails the build.

Merge order: **A first** (no registry contact), then **G** (removals only: 16 tools and their
dispatch cases), then **E**, then **B, C, F, H** (additive
registry and dispatch cases), then **D last**, because D wraps every dispatch case and must see
them all in place. Full suite plus `pnpm build` after each merge.

### Landing

One squashed commit per lane, straight onto `main`. **No version bump**: a push that changes
`package.json` or `extension/package.json` triggers `build-vsix.yml` and publishes a Release.
The bump is a deliberate act after phase 2.

After all eight merge: full suite, `pnpm build`, `pnpm run package:vsix`, and the bundled smoke
test. Any lane that adds a file which must ship (lane C's PowerShell grab script, lane H's doctor)
gets checked against the VSIX manifest by hand. This repo has shipped three packaging omissions.

---

## Phase 2 — the on-device pass (serial, human-scheduled, do NOT start it yourself)

Two machines this time. Order it so the cheap one goes first.

**On `this-pc` (the maintainer's PC, Big Picture in front, hands off), about 30 minutes:**

1. **A** — `deck_readFocus { machine: "this-pc" }` returns in well under a second when the ring
   is on a Big Picture page, and the result names which pages timed out. A 30-press sweep that
   took ten minutes on plan 87's night takes about a minute.
2. **B** — put another window in front of Big Picture. `deck_checkReady { machine: "this-pc" }`
   fails naming the front window; `deck_walkTo` refuses instead of pressing; `deck_status` says
   Big Picture is hidden. Bring it back; all three pass. `buildMatches` reports a real verdict on
   the local `pluginsDir`, not `unknown: missing host`.
3. **C** — `deck_captureScreenshot { machine: "this-pc" }` returns a picture the model sees,
   stamped `machine: { name: "this-pc", kind: "standin", os: "windows" }`.
4. **D** — start a walk and alt-tab away mid-walk (the known stall): the call ends at its
   deadline with the stage named and the pad released, not after 35 minutes. Two presses sent at
   once land one after the other.

**On the Deck, about 45 minutes:**

5. **E** — `deck_snapshotSettings` three times with `replace: true`: three saved copies, each
   byte-identical to a fresh tar, no hold file moved by hand. `deck_getEnv` reads
   `pluginLoaderActive: "active"`. A `deck_runSequence` that lands on a covered stop fails unless
   `requireVisible: false` is passed.
6. **F** — `deck_listGames` lists the installed titles with no press. Launch a game that is
   installed but **not** on the Recent shelf, by app id. Exit it. Then the 2026-09-19 shape:
   with a game running, if `RunningApps` reads empty the exit tool still reports the process alive.
7. **H** — `studio_doctor` on this PC reports every check green, then reports the version-pin
   check red after a deliberate edit to one `package.json` (revert it).
8. **G** needs no device time.

Expect this pass to find things. First act of the Deck half: one harmless direction press.

---

## Lane A — Stop waiting for pages that never answer

```
You are fixing one performance bug in the Decky Plugin Studio MCP server, from GitHub issue #4.
Repo root is your worktree. Run `pnpm install` first, then `pnpm -r test` to see the green baseline
(493 tests in mcp-server).

## The bug
`mcp-server/src/deck/readFocus.ts`, function `readFocusAt()` (around line 986): it asks every
Steam CEF page for the focus marker at once with `Promise.all`, then walks the answers in listing
order and returns the first page that has `hasGpfocus`. `Promise.all` only resolves when the
SLOWEST page has answered or timed out. On the Windows stand-in, 18 of Steam's 24 pages belong
to the hidden desktop window and never answer, so every read lasts the full 10 s timeout even
when the Quick Access page answered in 5 ms. `assertFocusMove` reads once before a press and at
least twice after, so one verified press costs about 30 s; a 30-press sweep took ten minutes.
On the real Deck every page answers fast, so this is invisible there.

## What to build, in this order
1. Return as soon as the winner is known. Keep asking every page at once, but settle on the first
   page IN LISTING ORDER that reports `hasGpfocus`, without waiting for pages later in the list.
   Pages earlier in the list that are still pending must be waited for (listing order is the
   tie-break and must stay deterministic). Only the "nothing owns the ring" case needs every
   answer, and that case must still return every page's status.
2. Remember who froze. A page (keyed by its CDP target id, per server process) that timed out gets
   a short budget on the next read (500 ms; make it a module constant). A page that answers again
   loses the mark. This state is in-memory only; it must not leak between machines (key it by
   machine name or CDP base URL as well).
3. Report it. Add `timedOutPages: string[]` (titles) and `slowestPageMs: number` to the
   `readFocus` result in EVERY case, not only when nothing owns the ring. Describe both in one
   line each in `mcp-server/src/toolRegistry.ts` under `deck_readFocus`.
4. Optional, only if 1–3 are done and tested: on a machine whose `os` is `"windows"`
   (`currentMachine()` from `mcp-server/src/machines.ts`), ask only pages whose `/json/list`
   `url` contains `useragent=Valve%20Steam%20Gamepad`, or whose title is `Steam Big Picture Mode`,
   starts with `QuickAccess_`, `MainMenu_`, `notificationtoasts_`, or is `SharedJSContext`. If
   the filter leaves zero pages, fall back to all of them. Never filter on the Deck.

## Files you own
`mcp-server/src/deck/readFocus.ts`, `mcp-server/src/deck/readFocus.test.ts`, and the
`deck_readFocus` description in `toolRegistry.ts`. Do not touch `readPage.ts` (it evaluates one
page only and is already fast), `assertFocusMove.ts`, `walkTo.ts` or anything else.

## Tests
Use the fake CDP server in `mcp-server/src/deck/__testutil__/fakeCdp.ts`. Add a page that never
answers `Runtime.evaluate`. Prove: (a) before your change a read with the ring on the third page
takes about the timeout; after, it takes about the third page's latency; (b) a read where the ring
is on a page AFTER the frozen one still returns the right page (listing-order tie-break holds);
(c) the second read of a session gives the frozen page the short budget; (d) `timedOutPages` and
`slowestPageMs` are present and right on a successful read; (e) the no-ring case still reports
every page. Keep every existing test green.

## Report
Timings before and after from the tests. The honesty paragraph: what could these tests pass while
the real thing is broken? (At least: the fake's pages answer in an order real CEF may not.)
Do not edit ROADMAP.md, CHANGELOG.md, docs/MCP_TOOLS.md, AGENTS.md or any version field.
```

## Lane B — Do not press blind on a stand-in

```
You are closing GitHub issue #5 in the Decky Plugin Studio MCP server. Repo root is your worktree.
Run `pnpm install`, then `pnpm -r test` for the green baseline (493 tests in mcp-server).

## The bug
On the Windows stand-in (`this-pc`: Steam Big Picture plus Decky Loader for Windows, pressed
through a virtual pad), Steam only takes pad input while Big Picture is the foreground window.
Nothing in DPS checks that. With another window in front, `deck_checkReady { machine: "this-pc" }`
passed every check it was given, `deck_readFocus` read "nothing owns gamepad focus", and every
driving tool answers that reading with a blind DOWN press to place a ring (`acquireFocusIfUnowned`
in `mcp-server/src/deck/walkTo.ts`, line ~177). That press goes into whatever window is in front.
The signal is already in reach: the `Steam Big Picture Mode` CDP page reports
`document.visibilityState === "hidden"` and `document.hasFocus() === false` when it is behind.
Also in the issue: `buildMatches` in `deck_checkReady` returns `unknown: missing host (DECK_IP)`
on a `local: true` machine, so the stand-in sat a day behind the Deck with nothing to say so.

## What to build
1. A new module `mcp-server/src/deck/foreground.ts` with one function that, given a CDP base URL,
   finds the `Steam Big Picture Mode` page and returns `{ foreground: boolean, visibilityState,
   hasFocus, reason }`, using the existing evaluate helpers in `mcp-server/src/deck/cdp.ts`. If the
   page is missing or does not answer, return `foreground: "unknown"` with the reason. Never a pass
   by default.
2. `deck_checkReady` (`mcp-server/src/deck/checkReady.ts`) gains a `foreground` field. It is
   checked by default when the machine's `os` is `"windows"`, and only when asked for otherwise.
   Failing it names the fact: "Big Picture is not the foreground window (visibilityState hidden,
   hasFocus false)". `unknown` stays `unknown`.
3. `acquireFocusIfUnowned` on a machine whose `os` is `"windows"`: before its first press, call
   the foreground check. If `foreground` is false, refuse with the same sentence and press
   nothing. If `unknown`, say so and press nothing either. Every driving tool that goes through the
   helper inherits this; do not edit the callers.
4. `deck_status` on a `windows` machine reports `bigPicture: { foreground, visibilityState,
   hasFocus }`. The status is assembled in `mcp-server/src/index.ts`; keep the edit additive (one
   field) because lane D rewrites the dispatch seam and merges after you.
5. `buildMatches` on a `local: true` machine with `pluginsDir` set: hash the installed plugin
   directory directly (same manifest walk `mcp-server/src/deck/buildHash.ts` uses for the remote
   half, same exclusions for `__pycache__`), instead of asking for a host. Keep the remote path
   untouched.
6. Describe the new field and the new status member in one line each in `toolRegistry.ts`.

## Files you own
`mcp-server/src/deck/foreground.ts` (new) and its test, `checkReady.ts` and its test, the
`acquireFocusIfUnowned` function in `walkTo.ts` and its test, `buildHash.ts` and its test, and
additive lines in `index.ts` (the `deck_status` result) and `toolRegistry.ts`. Nothing else.
Lane A owns `readFocus.ts`; do not touch it.

## Tests
Fake CDP: a `Steam Big Picture Mode` page that reports hidden/unfocused, one that reports
visible/focused, and one that never answers. Prove: `checkReady` fails, passes, and reports
`unknown` respectively on a windows machine, and does not run the check on a `steamos` machine
unless asked; `acquireFocusIfUnowned` sends zero presses when hidden or unknown and the old
one press when visible; `buildMatches` on a local machine returns a real match or mismatch
against a temp `pluginsDir`; the status result carries the new member on windows only.

## Report
The honesty paragraph. What `visibilityState` and `hasFocus` could read on a real Steam that the
fake does not model (for instance, a Steam overlay page in front). Do not edit ROADMAP.md,
CHANGELOG.md, docs/MCP_TOOLS.md, AGENTS.md or any version field.
```

## Lane C — A picture from a Windows stand-in

```
You are adding screenshots on Windows stand-ins to the Decky Plugin Studio MCP server (GitHub
issue #4, part 2). Repo root is your worktree. `pnpm install`, then `pnpm -r test` (493 green).

## The gap
`deck_captureScreenshot` and `deck_record` refuse on a machine whose `os` is `"windows"`
(`mcp-server/src/tools/deck.ts` around line 174: "the capture scripts need gamescope or a Wayland
compositor"). Honest, but it leaves the stand-in blind: every stand-in evidence file from
bonsAI's plan 87 says "no screenshot was taken". Steam's CEF debugger is already open on the
machine's `cdpPort`, and Chrome's `Page.captureScreenshot` needs no compositor, no SSH, no script.

## What to build
1. `mcp-server/src/deck/cdpScreenshot.ts` (new): capture the `Steam Big Picture Mode` page over
   CDP with `Page.captureScreenshot` (PNG). If a `QuickAccess_*` page exists and answers, capture
   it too and composite is NOT required: return the Big Picture page's PNG as the picture and note
   the QAM page's presence in the result. Use the existing CDP helpers in `cdp.ts`/`ws.ts`.
2. Fallback: if CDP capture fails, run a two-line PowerShell window grab of the Big Picture
   window's rect (`System.Drawing` `Graphics.CopyFromScreen`), shipped as
   `mcp-server/scripts/standin/windows/grab-window.ps1` and copied to `dist` by
   `scripts/copy-scripts.mjs` like the capture shell scripts are. The result says which method
   produced the picture (`method: "cdp" | "window-grab"`).
3. Wire it: on a `windows` machine `deck_captureScreenshot` uses this path instead of refusing.
   `deck_record` keeps refusing on Windows with its current message. Return the picture through
   the existing `withImage()` seam in `mcp-server/src/toolContent.ts` so the model sees the pixels;
   write the file under `runs/` as today. The result carries `machine: { name, kind, os }` like
   every other tool result (the seam already stamps it; confirm, do not duplicate).
4. One line in `toolRegistry.ts` under `deck_captureScreenshot` saying Windows is now supported
   and how.

## Files you own
`cdpScreenshot.ts` (new) and test, the Windows branch in `tools/deck.ts` and
`tools/captureOrchestrator.ts`, the new `.ps1`, `scripts/copy-scripts.mjs` (one entry), and the
one description line. Do not touch `readFocus.ts` (lane A), `checkReady.ts` (lane B) or the
dispatch seam logic in `index.ts` (lane D).

## Tests
Fake CDP returning a known PNG base64 from `Page.captureScreenshot`: prove the tool returns an
image content block with those bytes and `method: "cdp"`; prove that when the fake refuses the
command the fallback path is attempted and, when the fallback is stubbed to fail, the error names
both attempts. Prove a `steamos` machine's path is untouched. Add the new script to
`verifyPackagedScripts` so packaging fails if it does not reach `dist`.

## Report
The honesty paragraph. The window grab cannot be unit-tested on a headless runner; say so and
mark it device-unverified. Do not edit ROADMAP.md, CHANGELOG.md, docs/MCP_TOOLS.md, AGENTS.md or
any version field.
```

## Lane D — Calls that cannot hang, and a server that cannot die quietly

```
You are hardening the dispatch seam of the Decky Plugin Studio MCP server. Repo root is your
worktree. `pnpm install`, then `pnpm -r test` (493 green). Read `mcp-server/src/index.ts` fully
first: every `tools/call` goes through one `switch`, the machine is resolved once at the top with
`machines.ts`'s `currentMachine()` (an AsyncLocalStorage), the lease is taken there
(`deck/lease.ts`), and results pass through `toolContent.ts`.

## The bugs, all from bonsAI's device log
- 2026-09-26: one `deck_walkTo` call hung for 35 minutes and returned nothing.
- 2026-09-26: a tool stalled about 29 minutes "with no press sent and no error surfaced until the
  next call".
- 2026-10-22 (twice) and 2026-09-19: the server's tool connection closed mid-call; the chat lost
  every DPS tool until a new chat was started. `index.ts` has no `process.on("unhandledRejection")`
  or `uncaughtException` handler, so one stray rejection ends the process.
- 2026-09-26: "two button presses sent at once clash on the controller bridge's own port." The
  lease is per SESSION, so two calls in flight from one session can both reach the board.

## What to build
1. A wall-clock deadline per call, at the seam. Defaults: 60 s for read-only tools, 10 minutes
   for driving tools (walk, sweep, sequence, open, launch, exit, deploy, snapshot, record), 30 s
   for status and registry tools. Any call may pass `deadlineMs` to change its own. When the
   deadline passes: the result is an honest error naming the tool, the deadline, and the last
   stage the tool reported if it reports stages; the lease heartbeat stops; and on a driving tool
   the pad is released through the same release path `deck_stopAutomation` uses (read
   `deck/killswitch.ts`; do NOT set the stop latch, this is a timeout, not a stop). The underlying
   promise is abandoned, not cancelled; say so in a code comment.
2. Process-level handlers. `unhandledRejection` and `uncaughtException` log the error and stack
   to stderr with the tool name in flight if one is known, and keep the process alive. If the
   error is in the stdio transport itself, exit as today. Add a test that a rejected promise
   from a fake tool does not take down a dispatcher under test.
3. One driving call at a time per machine, in-process. A second driving call on the same machine
   while one is in flight WAITS for it (queue, FIFO), up to its own deadline, rather than racing
   it to the port. Reads do not queue. The result of a call that waited says
   `waitedForPreviousCallMs`. Key the queue by machine name.
4. Describe `deadlineMs` once, in the shared parameter block of `toolRegistry.ts`, not per tool.

## Files you own
`mcp-server/src/index.ts` (the seam; you merge LAST, after every other lane's additive dispatch
cases are in), a new `mcp-server/src/callDeadline.ts` and `mcp-server/src/callQueue.ts` with
tests, and the one description block in `toolRegistry.ts`. Do not edit any tool module.

## Tests
Fake tools wired through the real dispatcher: a tool that never resolves ends at a 50 ms test
deadline with the honest error and the release hook called exactly once; a tool that resolves in
time is untouched and its result identical; two driving calls on machine X run serially and the
second reports its wait, while a read on X runs at once; a driving call on machine Y does not wait
for X; a rejected promise is logged and the dispatcher answers the next call.

## Report
The honesty paragraph: a deadline that fires in a test proves nothing about whether an abandoned
`ssh` or `python` child keeps running on the real host; say what you did about children (kill
the child process group where you can) and what you could not. Do not edit ROADMAP.md,
CHANGELOG.md, docs/MCP_TOOLS.md, AGENTS.md or any version field.
```

## Lane E — Four small honest fixes

```
You are making four small fixes in the Decky Plugin Studio MCP server. Each is independent, each
has a bug report behind it, none touches the dispatch seam. Repo root is your worktree.
`pnpm install`, then `pnpm -r test` (493 green).

## 1. `deck_getEnv` reads a running loader as "inactive inactive"
`mcp-server/src/tools/deckAutonomy.ts` around line 270 runs
`systemctl --user is-active plugin_loader.service 2>/dev/null || echo inactive`. Decky's unit is
SYSTEM scope (the deploy's own restart already uses system scope after plan 09 lane 5), so the
`--user` half prints `inactive`, exits non-zero, and the `|| echo` prints a second one. bonsAI
measured `active` by hand in the same minute (finding P2-5, 2026-08-28). Use the system-scope
query, trim to one word, and report `unknown` when ssh fails rather than a made-up `inactive`.

## 2. A second settings snapshot can only be refused
`deck_snapshotSettings` (`mcp-server/src/deck/settingsSnapshot.ts`, `snapshotLease.ts`) refuses
while an earlier snapshot is unrestored. Right rule for a run; wrong for a proof: on 2026-10-22
the driver had to move the hold file aside by hand to take three snapshots in a row. Add
`replace: true`: the earlier copy is set aside under a dated name (the module already knows how
to set a damaged old copy aside; reuse that path), the new snapshot is taken, and the result names
the file set aside. Default stays refuse. Describe the option in one line in `toolRegistry.ts`.

## 3. `requireVisible` was promised to flip and never did
`deck_runSequence` (`mcp-server/src/deck/runSequence.ts`) has `requireVisible` defaulting OFF
with a "(report-only -- pass requireVisible to fail on this)" tag, since 2026-08-31, with the note
"Next release flips it to fail-by-default". Two releases later it has not. Flip the default to ON.
`requireVisible: false` opts out, per run or per step as today. Update the summary text so a
covered stop reads as a failure with the covering selector, and the opt-out is named in the
description. Check `checks/checkRunner.ts`: a saved check replayed with the new default must not
change its `ok` for a run whose landings were all visible (it compares visibility verdicts
already); if a saved check recorded a covered landing as a pass, the replay now says so and that
is the point.

## 4. A lease refusal that named the caller itself
bonsAI, 2026-10-07: one press was refused as "being driven by another session (a process on this
desktop)" while `deck_status` a moment later showed the lease as the caller's own; a retry worked.
`mcp-server/src/deck/lease.ts` decides "mine" by `ownerPid === process.pid` and "live" by
`process.kill(pid, 0)`. Windows recycles pids quickly, and `process.kill(pid, 0)` throws EPERM for
a live pid the process may not open, which the code may read as alive or dead depending on the
branch. Add an `ownerToken` (random per server process, generated once at module load) to the
lease record. "Mine" means pid AND token match. A record whose pid is alive but whose token is
not ours is another process: live. A record whose pid is dead is free, as today. Treat EPERM from
`process.kill` as alive, explicitly, with a comment. Put the heartbeat's AGE in seconds into the
refusal message beside its timestamp. Old records without a token are read as before (no token
check) so an upgrade does not evict a live session.

## Files you own
`tools/deckAutonomy.ts` (the getEnv probe only), `settingsSnapshot.ts`, `snapshotLease.ts`,
`runSequence.ts`, `lease.ts`, their tests, and one description line each in `toolRegistry.ts`.
Do not touch `gameSession.ts` (lane F), `readFocus.ts` (lane A) or `index.ts` (lane D).

## Tests
One failing-then-passing test per fix: the doubled `inactive` is gone and `unknown` appears on
ssh failure; `replace: true` sets the old copy aside and names it, default still refuses; a
covered landing fails a sequence by default and passes with `requireVisible: false`; a lease
record with our pid and a foreign token is not "mine" and is live.

## Report
Four honesty paragraphs, one line each is fine. Fix 2 and fix 1 are device-shaped (ssh, tar);
mark them device-unverified. Do not edit ROADMAP.md, CHANGELOG.md, docs/MCP_TOOLS.md, AGENTS.md
or any version field.
```

## Lane F — Games from the Library, and an exit that checks the process

```
You are extending `deck_launchGame` and `deck_exitGame` in the Decky Plugin Studio MCP server.
Repo root is your worktree. `pnpm install`, then `pnpm -r test` (493 green). Read
`mcp-server/src/deck/gameSession.ts` (about 1,600 lines) and its test fully before changing
anything. Keep its rules: every A press follows a read that names its target; nothing launches by
script (no `steam://` URL, no `SteamClient.Apps.RunAppById`), because a game started the way no
thumb can is not evidence about what a thumb gets. The 2026-10-11 fallbacks (launch by the Home
route when the Steam button opens no menu; close with Steam's own close call when it opens no
menu) stay as they are. The close call (`SteamClient.Apps.TerminateApp`, used only when the Steam
button opens no menu) is the file's one scripted exception; keep it, keep its result honest
(`via: "steam-close-call"`, fidelity `wire-sent`), and fix the two comments it made wrong: the
header still says the CDP reads "never drive anything" (around line 58), and `budget` is still
described as "Max RIGHT presses" (line ~174, and the registry) though the Home route now walks LEFT
too.

## The bugs, from bonsAI's device log
- 2026-09-18: God of War, Hollow Knight, Black Mesa and Doom 64 were all installed and none had
  been played recently, so none was on the Recent shelf and the launcher refused all four before
  pressing anything. The launcher already reads the library over CDP to refuse an uninstalled
  game, so the installed list is known; it just cannot reach a title that is not on the shelf.
- 2026-09-19: mid-Black Mesa the screen connection dropped for minutes; when it came back
  `RunningApps` read empty while the Black Mesa process was alive at full CPU on its own menu,
  32 minutes after the last press. The exit tool trusted the empty list. The session killed the
  process over SSH by hand.
- 2026-09-25 (twice) and 2026-09-26 (twice): the exit tool stopped on Steam's Home screen after a
  plugin reload left Home in front of a game still running underneath.

## What to build
1. `deck_listGames { machine? }`: a new read-only tool that returns installed titles (name, app
   id, non-Steam shortcut or not), the Recent shelf's app ids if the Home page is readable, and
   `RunningApps`, all from `SharedJSContext` over CDP, zero presses. Reuse the reads
   `launchGame` already does; do not write a second copy. Register it in `toolRegistry.ts` and add
   its dispatch case in `index.ts` (additive; lane D merges after you).
2. Launch from the Library grid when the title is not on the shelf. Route: Steam button, walk to
   the Library entry (read its label), A, then read the grid: every tile carries its app id in its
   own `<img src>` the same way the shelf tiles do (the shelf code already parses this; reuse the
   parser). Walk the grid with bounded D-pad presses toward the tile whose app id matches, reading
   focus after every press, and refuse after a bounded count (say 40) naming the last tile seen.
   On the tile, A, then the existing app-page logic (read `Play`, refuse Install/Update/Buy and the
   rest). The shelf remains the first route; the grid is the second; the Home-route fallback stays
   third. The result says `route: "shelf" | "library" | "home"`.
3. `deck_exitGame`: before deciding "nothing is running", also ask the machine's process list
   over SSH (`pgrep -f` on the game's install folder name or the app id's `reaper`/`steam-launch-wrapper`
   line; use what is there) on `steamos`/`bazzite` machines. If `RunningApps` is empty but a
   process is alive, report `processAlive: true` with the pid and refuse to call the game exited.
   Do not kill it. On `windows` machines skip the process check and say so.
4. When the Steam menu opens on Home with a game running underneath (`RunningApps` non-empty),
   go on with the exit route from the game's own entry rather than stopping; read each stop as
   today.

## Files you own
`gameSession.ts` and `gameSession.test.ts`, one registry entry, one dispatch case. Nothing else.

## Tests
Fake CDP with a library of several titles, a shelf holding only some of them, a grid page whose
tiles carry app ids: prove `deck_listGames` returns them with zero presses; prove a title off the
shelf is reached through the grid with every A following a read, the press count bounded, and the
route reported; prove the bounded walk refuses and names the last tile; prove the exit tool with
empty `RunningApps` and a stubbed alive process reports `processAlive` and does not claim an exit;
prove Home-with-a-game-underneath continues to the exit route.

## Report
The honesty paragraph, and be hard on yourself: the grid's DOM shape (tile markup, how many per
row, whether `<img src>` carries the app id there as it does on the shelf) is measured on the
shelf only. Mark the library route device-unverified and list exactly which reads the Deck pass
must confirm. Do not edit ROADMAP.md, CHANGELOG.md, docs/MCP_TOOLS.md, AGENTS.md or any version
field.
```

## Lane G — Retire the preview

```
You are retiring the in-IDE preview from the Decky Plugin Studio repo. Repo root is your worktree.
`pnpm install`, then `pnpm -r test` (493 tests in mcp-server and 2 in preview-server, green).

## Why
The preview existed so a plugin's panel could be driven on the PC. Its only consumer, bonsAI,
removed every preview hook on 2026-10-17 (GitHub issue #6) because the preview never mounted its
panel: the `@decky/api` shim lacked one export (`useQuickAccessVisible`) since 2026-08-08, and four
more findings from that day (silent DOM truncation, a placeholder PNG stored as a screenshot, a dead
backend reporting healthy, two workspaces sharing one preview) were never fixed. The maintainer
decided on 2026-10-24 to retire it rather than fix it. A tool that reports fiction is worse than no
tool. This lane removes it cleanly and leaves a note where it was.

## What to remove
1. The 16 `preview_*` tools: their entries in `mcp-server/src/toolRegistry.ts`, their dispatch
   cases in `mcp-server/src/index.ts`, `mcp-server/src/tools/preview.ts`,
   `mcp-server/src/tools/previewHealth.ts`, and `mcp-server/src/preview/` except the one file in
   the keep list. `toolRegistry.test.ts` diffs the registry against the dispatch cases both ways,
   so a half-removal fails the build.
2. The `preview-server` workspace package: delete the folder, its line in `pnpm-workspace.yaml`,
   any root script that builds or runs it, and its staging into `extension/resources/preview-server`
   by the VSIX bundling script (read `scripts/bundle-for-vsix.mjs` and `extension/package.json`).
3. The extension's preview side: `extension/src/preview/` (manager, ipcBridge, syncRpcAllowlist,
   webviewGamepadScript), `extension/src/commands/openPreview.ts`, the "Decky: Open Preview" command
   and the `previewHttpAllow` setting in `extension/package.json` `contributes` (do NOT touch
   `version`), and their registration in `extension/src/extension.ts` and `extension/src/ui/treeProvider.ts`.
4. The preview test kit: `scripts/run-preview-suite.mjs`, `tests/preview-suite/`,
   `tests/preview-baselines/`, `templates/preview-suite/`, and `templates/test-harness/` if it exists
   only for the preview (read it first). The `decky-preview` and `decky-tier-qa` skills in every copy
   (`.cursor/skills`, `pack/.cursor/skills`, `pack/.claude/skills`, and the two copies under
   `extension/resources/pack/`), and any pack hook that calls the preview.
5. `docs/PREVIEW_LIMITATIONS.md` becomes a ten-line note at the same path: the preview was retired
   on 2026-10-24, why, and that on-device QA through the `deck_*` tools is the way. Old links still
   land somewhere.

## What to keep
- Reading `.decky/preview.json`: `deck_openPlugin` takes `panelRootSelector` from it and deploy
  runs its `preDeployCommand`; bonsAI keeps the file for exactly that. Move the reader
  (`mcp-server/src/preview/previewConfig.ts`) to `mcp-server/src/pluginConfig.ts` with the same
  behaviour and every test it has. The file name `.decky/preview.json` stays, so consumers change
  nothing.
- `plugin_lintFocus` and `mcp-server/src/lint/`: static source analysis. Its comments mention the
  preview only as the place a bug used to hide; leave them.
- Anything in `preview-server/src/focusGraph.ts` or `qamGeometry.ts` that code outside the preview
  imports (grep first). If nothing does, it goes with the package.
- The streaming RPC sidecar (`decky.emit`, `preview_tailEmit`) is preview-only and goes.

## Files you own
Everything listed above. Lane H also edits `extension/src/extension.ts` and `extension/package.json`
`contributes`; yours are removals, theirs additions, so the merge is trivial, and you merge before
them. Lane D rewrites the dispatch seam in `index.ts` and merges last; yours are removed cases only.

## Tests
`pnpm -r test` and `pnpm build` green with the package gone; `toolRegistry.test.ts` passes with 41
tools; `pnpm run package:vsix` and the bundled smoke test pass with no preview-server staged; a test
that `.decky/preview.json`'s `panelRootSelector` and `preDeployCommand` are still read. Afterwards
grep the repo for `preview_`, `previewManager`, `__deckyPreviewTestHooks`, `DECKY_PREVIEW` and
`run-preview-suite`; the only hits should be in `CHANGELOG.md`, `docs/ROADMAP.md`,
`docs/planning/` and the new note.

## Report
List every file deleted and every one kept, with the reason. The honesty paragraph: what still
reaches for the preview that a grep could miss (tool names built from strings, docs the
orchestrator writes at the end, the Init Pack's `AGENTS.md`). Do not edit ROADMAP.md,
CHANGELOG.md, docs/MCP_TOOLS.md, AGENTS.md or any version field.
```

## Lane H — A self-check for DPS itself

```
You are adding `studio_doctor` to the Decky Plugin Studio MCP server and a matching
`Decky: Doctor` command in the VS Code extension. Repo root is your worktree. `pnpm install`,
then `pnpm -r test` (493 green). This was cut from plan 09 for capacity. It needs no Deck.

## Why
Setup drift has cost the consumer real sessions: Claude Code reads `.mcp.json` not `mcp.json`;
the DPS tools pointed at a path that no longer existed; a second VS Code window killed its own MCP
server on a shared port; the stand-in ran a build a day behind the Deck with nothing to say so;
and this repo's own CHANGELOG warns that the four version pins (`package.json`,
`extension/package.json`, `mcp-server/package.json`, `SERVER_INFO` in `mcp-server/src/index.ts`)
must move together or the server reports a stale number over MCP.

## What to build
`studio_doctor { workspace? }` returns a list of checks, each `{ name, ok: true | false |
"unknown", saw, fix }`, plus `okCount`/`failCount`. Checks:
1. The MCP config the IDE will read (`.mcp.json`, `mcp.json`, `.cursor/mcp.json`, and the VS Code
   setting) points at a server entry file that exists, and that file's package `version` equals
   the extension's. Fix text names the path to change.
2. The four version pins agree with each other.
3. No second process holds the ingest port, or any other port the server listens on (read the
   configured values; `isIngestRunning()` exists in `mcp-server/src/ingest/server.ts`).
4. `bridge/tools/pad.py`, `chord.py`, `vpad.py` and the capture shell scripts resolve from the
   running build (reuse `resolveScriptsDir` / `verifyPackagedScripts` from
   `mcp-server/src/tools/`); the Python on PATH can import `serial` (for the bridge) and, on
   Windows, `vgamepad` (for the virtual pad), reporting `unknown` if Python is absent.
5. `~/.config/decky-plugin-studio/machines.json` parses and every machine has the fields its
   `press` transport needs (read `machines.ts`'s loader; do not write a second validator).
6. `deck.env` has `DECK_IP` and `DECK_USER`, or says the real Deck is unconfigured (that is
   `ok: true` with a note, not a failure, because stand-in-only setups are legitimate).
7. The killswitch latch state (`deck/killswitch.ts`): stopped or armed, and for which machines.
8. Two one-line fixes in the extension, found in the 2026-10-22 audit, in files you already own:
   `decky.showOpenPluginHint` (`extension/src/extension.ts` ~line 53) calls `deck_openPlugin {}`,
   which now DRIVES the Deck and takes the machine's lease in the extension's own process, so an
   agent's next driving call is refused for up to 10 minutes. Pass `drive: false` there (that is
   the checklist the command's name promises). And after each one-shot extension command that
   drives (`deployToDeck.ts`'s deploy and capture), call `deck_releaseMachine` so the lease does
   not outlive the command.
Every check catches its own errors and reports `unknown` with the error text. Never a pass by
default. The extension command runs the tool and shows the result in the output channel with the
failures first.

## Files you own
`mcp-server/src/tools/doctor.ts` (new) and test, one registry entry, one dispatch case in
`index.ts` (additive; lane D merges after you), `extension/src/commands/doctor.ts` (new), the
command contribution in `extension/package.json` (the `contributes` block ONLY; do not touch
`version`), `extension/src/extension.ts` (the registration line and the hint command), and
`extension/src/commands/deployToDeck.ts` (the release call only).

## Tests
Temp directories standing in for a workspace and a config dir: prove each check fails on a
planted drift (a `.mcp.json` pointing at a missing file; a version pin edited; an invalid
`machines.json`; a missing script) and passes on a clean layout; prove an exception inside one
check yields `unknown` for that check and does not stop the others.

## Report
The honesty paragraph. The port check and the Python import check depend on the runner's
machine; say what passes on CI that could still be broken on the maintainer's PC. Do not edit
ROADMAP.md, CHANGELOG.md, docs/MCP_TOOLS.md, AGENTS.md or any version field.
```

---

## Then: solo season, in this order

Everything here needs the Deck or the person, so it runs alone, one at a time.

1. **`deck_openPlugin` in the first second after a reload.** The one consumer-facing bug that four
   fixes (2026-09-02, 10-11, 10-14, 10-22) each passed at the desk and failed on the Deck. bonsAI's
   stricter test (a read after each call) read 1 of 3 on 2026-10-22, both failures 1 s after the
   reload with "debugger connection reset". This is an experiment first: measure what CEF's
   debugger does for the first five seconds after `plugin_loader` restarts (target list, which
   pages answer, when the Decky tab returns), then write the wait against that measurement. The
   fake CEF must then be taught the measured shape. Done when bonsAI's row
   P89-RIG-OPEN-AFTER-RELOAD reads 3 of 3 on the stricter set. While there: the note that tells
   `deck_openPlugin` a reload just happened (`deck/loaderRestart.ts`) lives in one server process's
   memory, so a reload done from the extension is invisible to an agent's server; make it a file
   beside the lease.
2. **Re-test the lone Steam button.** `06_trigger_rest` (triggers rest at the bottom of their axes)
   was flashed on 2026-10-24 with the Deck-side cable unplugged; `status` read back `-127` for both
   triggers. The README's four-step hand test says whether the half-pulled triggers were why the
   button stayed shut on 2026-10-11. Next time the firmware changes, put the program version in the
   `status` reply, so the server can tell `05` from `06` instead of reading the resting axes.
3. **Sleep the Deck and wake it again.** Unchanged from the previous plan; `rtcwake` is proven as
   the way back.
4. **Type text on the Deck.** bonsAI's device log shows the cost again: "the 'AI is not set up'
   answer variant could not be made by the rig (it needs A on a text box)", and a Steam keyboard
   check needed the maintainer's own controller.
5. **Run the same check through every way into the plugin.** Add bonsAI's new ask: reload only
   the screen side (Steam's Quick Access page), because a full loader restart is what triggers
   item 1.
6. **Measure colours inside a control.** After 5. Lane C gives it pictures from the stand-in.
7. **Keep a log of every run automatically.** Lane D puts a deadline and a queue at the seam; the
   ledger goes at the same seam once that has settled.
8. **Time a run the way a person sees it.** Wants lane D's queue and the lease, so a foreign
   press cannot pollute a timing run.
9. **Stand-ins, the VM lane (plan 10 L3) and Route B.** Memory Integrity off, VirtualBox
   installed, the lease's device half. After lanes A–C have made `this-pc` fast and honest, a VM
   that owns its own display is what frees the maintainer's PC during a run.

## How this lands

As plan 09: one squashed commit per lane onto `main`; no lane touches the five docs or the
version pins; every lane answers the honesty question; the version bump is a deliberate act
after phase 2. New rule: **the ROADMAP update at the end copies bonsAI's device verdicts, not the
lane's claims.** A lane's "done" means desk-verified until the findings log in
`Documents/bonsAI/docs/mcp-setup.md` or a run file under `runs/` in this repo says what the
Deck did.

---

## Docs that are wrong today (do not wait for the session)

Found by the 2026-10-22 audit against `toolRegistry.ts` (57 tools). These mislead an agent that
reads them now, so they are worth fixing before the session, in one docs commit:

- **`deck_openPlugin` is still called a checklist** in `AGENTS.md:30`, `pack/AGENTS.md:25` (and its
  copy under `extension/resources/pack/`), `docs/PREVIEW_LIMITATIONS.md:21` (lane G replaces that file), and the
  `decky-onboard` (lines 5, 35) and `decky-focus-audit` (line 46) skills in all five copies. The
  code has driven the Deck since v0.3.9; `drive: false` returns the checklist. The code's own
  checklist text still says "Deck UI cannot be automated in v1" (`tools/deckAutonomy.ts:102`).
- **`deck_holdAwake` is described as writing timeouts with lazy expiry** in `AGENTS.md:36`,
  `pack/AGENTS.md:31`, `docs/MCP_TOOLS.md:72` and `:80-84`, and `CHANGELOG.md:21`. It is a
  self-releasing logind inhibitor; nothing is written and the lock ends at its TTL. "Pair every
  hold with its restore" is still good advice; "awake indefinitely" is false.
- **`deck_configure` is documented with `{ ip, user }`** in `docs/MCP_TOOLS.md:23`, the
  `decky-debugger` agent (all copies) and the `decky-onboard` skill. Those keys are written to
  `deck.env` verbatim and read by nothing; the real keys are `DECK_IP` / `DECK_USER`.
- **Nothing outside the root `AGENTS.md` knows about `machine`**: `docs/MCP_TOOLS.md` lacks
  `deck_listMachines`, `deck_releaseMachine`, `plugin_lintFocus`, the `machine` argument, the
  machine stamp and the lease. The Init Pack's `pack/AGENTS.md` (2026-09-08) ships none of the
  "Which machine" or "Stopping the rig" guidance. No skill or agent file mentions `machine:`.
- **`docs/MCP_TOOLS.md` is behind the October fixes**: `deck_openPlugin` (retry, rail wait,
  reopen), `deck_snapshotSettings` (streamed copies, size and checksum check, 6-hour cap, damaged
  copies set aside), `deck_readFocus` (`timeoutMs`, text-line sampling with
  `visibility.sample`), LT/RT, `deck_checkReady`'s `machineKind`. Line 64 still says the run
  hygiene tools "never ran against a real Deck". The registry text itself (`toolRegistry.ts:304`
  and `:909`) is missing the rail wait, the reopen and the 6-hour cap.
- **`CHANGELOG.md` `[Unreleased]` has no entry for any of the 15 commits from 2026-10-08 to
  2026-10-22**, and its LT/RT entry says the triggers rest at 0, which `06_trigger_rest` changes
  to -127 (not yet flashed).
- **`README.md`** (last touched 2026-08-08) says "all 34 tools" (57), lists none of the bridge,
  killswitch, game, run-hygiene or stand-in work, and points Releases at
  `github.com/decky-plugin-studio/...` while `origin` is `github.com/qd313/...`.
- Smaller: `docs/DEVELOPMENT.md` names a 0.1.0 VSIX and omits `bridge/`, `scripts/standin/`,
  `pnpm stop` / `pnpm arm`; `docs/MCP_CONSUMER_SYNC.md` says to develop on a `develop` branch
  that does not exist; `docs/VSCODE_SMOKE_TEST.md` is at "v0.2"; `docs/device-qa-runbook.md`
  knows no stand-ins, lease or fallbacks; `.cursor/agents/SUBAGENT_REPORTS.md` has never had an
  entry; `settingsSnapshot.ts:34-37` still says "UNVERIFIED ON HARDWARE"; and
  `openPluginRailWait.test.ts:9` says the tool "presses nothing while the menu is open", which
  stopped being true with the reopen step.

---

## Outcome (2026-10-24)

Run the same day it was approved, from the planning session itself, with `main` at `a1a1af3`. All
eight lanes were spawned at once (Opus for D and F, Sonnet for the rest) and all eight finished
inside two hours. Merge order as planned: A, C, B, E, H, G, F, then D last. Conflicts were the
`test` script line in `mcp-server/package.json` (every lane), the `fakeCdp.ts` test helper (A and
C, auto-merged), and three files where lane G's removals met other lanes' additions
(`copy-scripts.mjs`, `index.ts`, `toolRegistry.ts`), all resolved by hand. Tests: 493 → 578 in
`mcp-server`; the `preview-server` package and its 2 tests are gone. `pnpm build`, the extension
typecheck and `pnpm run package:vsix` with the bundled smoke test are green. The VSIX is 8.04 MB
(was 32 MB). Tool count 43.

| Lane | Commit | Tests added | What its honesty paragraph said to check on a device |
|------|--------|-------------|------------------------------------------------------|
| A | `a348319` | 6 | Real CEF may reset instead of hang (not marked frozen); target ids may change between listings; the Windows title filter was never run against a real Steam. One verified press sweep on `this-pc` settles it. |
| B | `5877733` | 19 | Whether `visibilityState` and `hasFocus` really flip when Big Picture is backgrounded (one observation so far); an overlay page in front could still read as foreground. |
| C | `80727db` | 5 | Whether real Steam answers `Page.captureScreenshot` (a black frame would pass the tests); the window grab has never been executed. |
| D | `36600d3` | 19 | A timed-out call's promise is abandoned, not stopped, so a late `walkTo` could still press beside the next call; `execSync` paths cannot be interrupted; killing local `ssh` may not stop the remote command. |
| E | `3d90fc3` | 7 | `systemctl is-active plugin_loader.service` over ssh on the real unit; `replace: true` never ran `tar`; a server restart now reads its own old lease as foreign until the TTL or a forced release. |
| F | `abb8a86` | 14 | The Library grid is a model built from the shelf. Ten reads listed in the lane report must be confirmed before this is called working, starting with which Library tab opens by default. |
| G | `9d30a33` | +5, −3 | `deck_openPlugin` still picks up `panelRootSelector` end to end (only an import and a name changed). Consumers' own old pack copies still mention the preview. |
| H | `a022acb` | 13 | The real Python probe and the real port conflict never ran in tests; `studio_doctor` on the maintainer's PC read 6 ok, 0 failing, 1 unknown the same day. The extension command is compile-checked only. |

**Not pushed, on purpose.** Lanes G and H changed `extension/package.json` (a description and a
command). `build-vsix.yml` runs on any push to `main` that touches that file and publishes a GitHub
Release whenever the tag for the current version is missing, and `v0.3.11` was never tagged. A
push now would release device-unverified code as 0.3.11. The push and the bump are one deliberate
act after phase 2.

**Also that day:** firmware `06_trigger_rest` was flashed (Deck-side cable unplugged, `status`
read back the triggers at -127); the Steam-button hand test could not run because a bonsAI session
held the Deck's lease with Deep Rock Galactic: Survivor running. Six stale branches and their
worktrees were deleted; issue #2 was closed; `main`'s own `node_modules` had to be reinstalled
after it emptied while the lanes ran `pnpm install` in worktrees nested under `.claude/worktrees/`
(cause not found; worth watching next session).

**Phase 2, the `this-pc` half, ran 2026-10-25** (Big Picture in front, the maintainer alt-tabbing
once for item 2):

| Item | Verdict on `this-pc` |
|------|----------------------|
| 1 (A) | Proven. `deck_readFocus` 6 ms a read, 5 pages asked, no timeouts; a verified press about 240 ms (was 20-30 s); with Big Picture hidden a read is 4 ms. |
| 2 (B) | Proven. Covered: `checkReady` failed on `foreground` alone ("visibilityState hidden, hasFocus true"), `walkTo` pressed nothing and said why, `status` read hidden. In front: all three passed. `buildMatches` on the local `pluginsDir` gave a real hash verdict (fail: the stand-in's bonsAI, 163 files, was behind the local build, 185 files). New: with Big Picture behind, Steam drops the gamepad ring, so a `verify: true` press refuses on the focus read before the gate. Not tested on purpose: a plain press while covered (the pad would feed the front window). |
| 3 (C) | Proven. A real Big Picture home, `method: "cdp"`, 3.2 MB, image block, stamped `this-pc / standin / windows`. The window-grab fallback never ran. |
| 4 (D) | Proven for the deadline and the queue. `deadlineMs: 1` returned the honest error; two presses at once ran in order (`waitedForPreviousCallMs: 258`), a read beside them did not wait. The mid-walk stall the item wanted to time does not exist on this build. The known gap (an abandoned promise may still press) is untested. |

**Also 2026-10-25:** the maintainer asked for a way to put Big Picture in front without a hand.
Measured on the PC: Steam's `SteamClient.Window.BringToFront(1)` plus a `SetKeyFocus(false)` /
`SetKeyFocus(true)` toggle brings a covered Big Picture forward (the toggle, because `true` alone
is a no-op when Steam thinks it has focus); no Steam call restores a minimized window, one Win32
`ShowWindow(SW_RESTORE)` does. Shipped as `deck_focusBigPicture` (Windows stand-in only, presses
nothing, `ok` follows a second gate read), with `restore-window.ps1`, 8 tests, 586 total, 44 tools.
Known limit: the Windows lock screen leaves Big Picture's page reading visible and focused.
Switching Steam's UI mode by call (`SteamClient.UI.SetUIMode`, `steam://open/bigpicture`) was
located but not tried: it might drop Decky for Windows' injection on the live stand-in.

**Owed on the Deck:** the four-step Steam-button hand test, then items 5 to 7 (E, F, H).
