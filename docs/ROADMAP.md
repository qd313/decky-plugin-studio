# Decky Plugin Studio — roadmap (deferred)

Star ratings follow bonsAI [roadmap](https://github.com/cantcurecancer/bonsAI) legend (effort/risk, 1 = lowest).

Last full check against the code and against bonsAI's device log: **2026-10-22** (`main` at `43afc0b`,
version 0.3.11, 493 + 2 tests green). **2026-10-24: parallel feature session 2 ran and all eight lanes landed on `main`** (`a348319` to `0526765`, 578 tests, 43 tools, VSIX packaged). **2026-10-25: phase 2 ran on both machines.** Lanes A, B, C and D are proven on the Windows stand-in; on the Deck the lone Steam button opens the menu again (the 2026-10-10 bug is closed), lane E's snapshot `replace` and loader word passed, lane H's doctor is green, and lane F's Library-grid route ran for the first time and stalled on DOWN after one row (open). A new `deck_focusBigPicture` tool (44 tools, 590 tests) opens Big Picture from the desktop client and brings it in front without a hand. Issues #4 and #5 closed. **The in-IDE preview is retired** (lane G, `9d30a33`). **Correction 2026-10-25:** the push hold was built on a wrong premise. Tag `v0.3.11` has existed on GitHub since the bump on 2026-10-06 (with its auto-published release), the workflow skips the release when the tag exists, and `main` was in fact pushed at `47f569e` on 2026-10-24 (the run built the VSIX and uploaded it as an artifact only). `main` is pushed again at the 2026-10-25 commits; the workflow does not even run for them, since none touches `extension/package.json`. What is still true: the 0.3.11 GitHub release holds the 2026-10-06 build, so everything since lives only in `main` until a 0.3.12 bump, and `CHANGELOG.md` still files the 0.3.11 entries under Unreleased. bonsAI's own record of what each DPS tool did on the real Deck is
`Documents/bonsAI/docs/mcp-setup.md` § "DPS findings log"; device verdicts below come from there, not
from commit messages.

- [Deferred / shelved](#deferred--shelved) — out of scope for now, with reasons
- [In progress](#in-progress) — partially shipped
- [Session plan](#session-plan) — parallel feature session 2 (eight lanes), and the solo order after it
- [Planned features](#planned-features) — not yet built
- [Open bugs](#open-bugs) — known issues, not yet fixed
- [Fixed bugs](#fixed-bugs) — grouped by fix date, newest first
- [Shipped releases](#shipped-in-0311-installed-2026-10-06-not-released) — 0.3.11, v0.3.x and v0.2.0

---

## Deferred / shelved

### The in-IDE preview, and everything that was deferred inside it
**Retired 2026-10-24** (the maintainer's call; removed the same day, `9d30a33`). Lane G in [plan 11](planning/11-parallel-feature-session-2.md) removed the 16 `preview_*` tools, the `preview-server` package, the extension's preview panel and the preview test kit, and leaves a short note at `docs/PREVIEW_LIMITATIONS.md`. Reading `.decky/preview.json` stays, because `deck_openPlugin` takes `panelRootSelector` from it.
- **Why:** the only consumer stopped using it on 2026-10-17 ([issue #6](https://github.com/qd313/decky-plugin-studio/issues/6)) because it never mounted their panel, and five findings from 2026-08-08 about it reporting fiction were never fixed. On-device QA through the `deck_*` tools is the way.
- **Retired with it:** *Native Steam Input / HID bridge in preview* (★★★★★★), *Gamescope / QAM compositing in preview* (★★★★★★), *Pixel-perfect `@decky/ui` mocks* (★★★★), the separate-frame half of *Make the preview behave more like Steam*, and *One D-pad test, two runners* (★★★★). The lint rules R13 and R14 stay; they are source-only.

### Deck UI automation (`deck.openPlugin`, hard mode)
★★★★ · **No longer deferred — shipped.** Kept here only because older docs still point at this entry.
- **What it was:** Fully automated navigation to open a plugin from anywhere in the Steam UI. v1 (to v0.3.8) returned a checklist for a human.
- **What is true now:** since v0.3.9 (2026-08-28) `deck_openPlugin` drives the Deck itself: it reads focus, opens the Quick Access menu with the real chord, waits for Decky's tab, walks the rail, enters the Decky pane, finds the plugin and activates it, checking a read before every press. `drive: false` returns the old checklist. On a stand-in it has opened bonsAI too (2026-10-08).
- **What is still open:** the first try after a plugin reload or deploy, which has failed on the Deck after four fixes. See [Open bugs](#open-bugs).

### Auto `.env` → `config.ts` on deploy
★★★ · Plugin-specific
- **What:** Automatically generate `config.ts` from `.env` on deploy.
- **Note:** Use `.decky/preview.json`'s `preDeployCommand` instead — this is specific to each plugin, not something Studio should own generically.

### Parallel VM QA farm for bonsAI
★★★★★★ · Shelved 2026-09-05 — **unshelved 2026-09-23:** now [*Drive several Decks at once*](#drive-several-decks-at-once-stand-in-decks-for-bonsai) under Planned features. Kept here as the record of why it was shelved.
- **What:** Several SteamOS VMs running in parallel, each drained by a subagent, to speed up QA.
- **Why shelved:** A VM has to behave exactly like a real Deck, including Gaming Mode — but Gaming Mode won't start without a logged-in Steam client, and no Steam login may ever touch a VM. That's a contradiction as scoped.
- **Details:** host budget (3 VMs comfortable on an i7-12700K / 32GB), a model-mix sketch, and two cheaper alternate shapes (★★★★★ with one golden login; ★★★ for Ask/backend-only rows in plain Linux VMs) are in [planning/08](planning/08-parallel-vm-qa-farm.md).

### Spam-left escape chain (plugin → plugin list → QAM → game)
★★★★★ · Deferred
- **What:** Let repeated D-pad-left presses back out of a plugin, through the plugin list and QAM, to the game.
- **Why deferred:** Verified on hardware 2026-08-14 — D-pad left at the plugin's leftmost stop moves focus to Steam's own QAM icon rail, then Steam consumes every further left press. This isn't a plugin gap, it's a Steam behavior. Getting past it means patching Steam's own QAM UI: fragile across Steam updates, and it changes behavior system-wide.
- **Cheaper option:** A narrower version — left at the plugin edge pops back to the Decky plugin list — might be ★★★ if the press can be intercepted before Steam takes it. Unverified.

---

## In progress

### Visibility oracle + free-play sweep
★★ · Parts A + B shipped 2026-08-31 — sampler rebuilt twice since (2026-10-03, 2026-10-22) and proven on the Deck — fail-by-default flip still pending
- **Why it exists:** every focus tool could answer "where is the ring?" but none could answer "can a person actually see it?" Proven twice in two days on bonsAI: a control focused behind a bottom-pinned dock passed every automated check (`walkTo`, `runSequence`, `readFocus`), and a human found the problem in 30 seconds of free play.
- **What shipped:**
  - A `visibility` verdict (visible/partial/covered/offscreen + percent + covering selector) on every focus read.
  - A `stopsFocusedButNotVisible` counter and `requireVisible` option on `runSequence` (report-only for now).
  - `deck_sweep`: spams D-pad direction presses only (never A/B) across a pane, recording label/rect/scroll/visibility at every stop into a diffable `runs/` report.
- **Verification:** matched a manual `elementFromPoint` probe exactly on bonsAI's Main tab. Two corrections made along the way: the visibility sample inset needed to be a quarter of the short side (2–12px), not a flat 2px, or visible rounded-corner buttons misread as `partial`; and the sweep needed the COM7 press-retry fix below, or it died around press 10–22.
- **First real finding:** the sweep's first run found 4 chips that are focused but not visible (expected was 0), reproduced byte-for-byte across two runs. Reported to bonsAI as a consumer bug.
- **Since then, the sampler learned to read where the words are.** The 3×3 box grid read two bonsAI controls as 78–89 % "partial" because a corner icon overlapped their box while their words were clear. Since 2026-10-03 a control with text is sampled along its text lines (`visibility.sample: "text"`), the box grid stays for icons and toggles. On 2026-10-22 the line boxes were further cut down to what the clipping boxes between the control and the text actually show, after every folded section line on bonsAI's Settings tab read 92 % "clipped" under a plain ellipsis. **Proven on the Deck 2026-10-22** (bonsAI row P97-X2-SAMPLER: folded sections 100 %, "text", no clip).
- **The flip landed 2026-10-24** (plan 11 lane E, `3d90fc3`): `requireVisible` defaults to ON; `requireVisible: false` opts out per run or per step. A saved check that recorded the old default replays with it. Device-unverified: no sequence with a covered landing has run against the Deck since.
- **Honest limit:** this is a DOM hit-test, not real eyes — wrong colors or compositing artifacts still need screenshots or a human. It only guarantees that focused-but-occluded and focused-but-offscreen can't pass silently anymore.
- **Full design:** [06-visibility-oracle-and-free-play-sweep.md](planning/06-visibility-oracle-and-free-play-sweep.md)

---

## Session plan

Rewritten 2026-10-22. The first version of this section (2026-09-07) planned the eight-lane
session in [plan 09](planning/09-parallel-feature-session.md). That session ran on 2026-09-07 and
08 and is done; its results are under [Fixed 2026-09-07](#fixed-2026-09-07-plan-09--eight-parallel-lanes)
and [Fixed 2026-09-08](#fixed-2026-09-08). [Plan 10](planning/10-stand-in-decks.md) (stand-in
Decks) landed on 2026-10-05, made its first press on 2026-10-07 and swept bonsAI on a stand-in on
2026-10-08. From 2026-10-11 to 2026-10-22 every commit was a fix driven by bonsAI's device nights
(its plans 89, 93 and 97), and none of them touched this file. This rewrite catches it up.

The split is the same as before. There is one Deck, one bridge board, one COM port and one focus
ring. Work whose risk lives at the desk runs in parallel. Work whose hard part is "what does this
hardware actually do" runs alone, as an experiment before it is a feature. One thing is new: the
Windows stand-in `this-pc` is the maintainer's own PC, so a lane can now be proven on a real Steam
client without the Deck, as long as Big Picture is in front and nobody touches the keyboard.

### Done 2026-10-24: parallel feature session 2 — eight lanes landed; device pass run on both machines 2026-10-25

Ran in one afternoon from this session. Each lane was one subagent in its own worktree; all eight
landed on `main` as one squashed commit each (A `a348319`, C `80727db`, B `5877733`, E `3d90fc3`,
H `a022acb`, G `9d30a33`, F `abb8a86`, D `36600d3`), 493 tests became 578, the VSIX packaged with
the bundled smoke test green. **Nothing has run on the Deck or the stand-in yet**; phase 2 of the
plan is the next device session. Outcomes per lane are at the end of the plan.

**Full plan, with the verbatim lane prompts:** [11-parallel-feature-session-2.md](planning/11-parallel-feature-session-2.md)

| Lane | What it covers | Where it is proven (owed) |
|------|----------------|--------------------|
| **A — Stop waiting for frozen pages** | [Issue #4](https://github.com/qd313/decky-plugin-studio/issues/4), part 1. A focus read returns as soon as the first page with the ring has answered, remembers pages that froze, and reports `timedOutPages`. On the stand-in a verified press costs 20–30 s today. | `this-pc`, ~10 min |
| **B — Do not press blind on a stand-in** | [Issue #5](https://github.com/qd313/decky-plugin-studio/issues/5). `deck_checkReady` and the focus-acquire press refuse when Big Picture is not the front window; `deck_status` says so; `buildMatches` works on a local machine. | `this-pc`, ~10 min |
| **C — A picture from a Windows stand-in** | Issue #4, part 2. `deck_captureScreenshot` through CDP `Page.captureScreenshot` on Windows, a window grab as fallback, the image block the model can see. | `this-pc`, ~5 min |
| **D — Calls that cannot hang** | A wall-clock deadline per call at the dispatch seam; process-level error handlers so one rejection cannot kill the server; one driving call at a time per machine. From bonsAI's log: a 35-minute hang, a 29-minute stall, the server dropping mid-call twice, two presses clashing on the port. | `this-pc`, ~5 min |
| **E — Four small honest fixes** | `deck_getEnv`'s `inactive inactive`; `replace: true` for a second settings snapshot; the `requireVisible` flip; an owner token on the lease so a reused pid cannot look like another session. | Deck, ~15 min |
| **F — Games from the Library** | `deck_listGames` (zero presses), a launch route through the Library grid for titles not on the Recent shelf, and an exit that checks the process list when `RunningApps` reads empty. The riskiest lane: the grid's DOM shape is unmeasured. | Deck, ~20 min |
| **G — Retire the preview** | Decided 2026-10-24. Remove the 16 `preview_*` tools, the `preview-server` package, the extension's preview panel and the test kit; keep reading `.decky/preview.json` for `deck_openPlugin`; leave a note where the docs were. | none |
| **H — A self-check for DPS itself** | `studio_doctor`: config path, version pins, shared ports, scripts, `machines.json`, latch state. Cut from plan 09 for capacity. Plus two one-liners: the extension's "hint" command stops driving, and one-shot extension commands release their lease. | PC, ~5 min |

**Decided 2026-10-24: retire the preview** (lane G, done). **One call still open for the maintainer:**

- **Lane F shipped device-unverified.** The Library grid has never been read by a tool; the lane
  specifies every read the Deck pass must confirm. If that is too much risk for one lane, drop the
  grid route and keep `deck_listGames` and the exit-tool process check.

**Not a lane, on purpose:** the one open consumer-facing bug, `deck_openPlugin` failing in the first
second after a reload, is an experiment (measure what CEF's debugger does for five seconds after
`plugin_loader` restarts) and is first in the solo season. The bridge firmware was flashed on
2026-10-24; its hand test is the maintainer's.

### Then: solo season, in this order

1. **`deck_openPlugin` in the first second after a reload.** Four fixes (2026-09-02, 10-11, 10-14,
   10-22) each passed at the desk and failed on the Deck. bonsAI's stricter test read 1 of 3 on
   2026-10-22, both failures 1 s after the reload with a debugger connection reset. Measure first,
   then write the wait against the measurement, then teach the fake CEF the measured shape. Done
   when bonsAI's row P89-RIG-OPEN-AFTER-RELOAD reads 3 of 3 on the stricter set.
2. **Re-test the lone Steam button** now that `06_trigger_rest` is flashed (2026-10-24): the README's
   four-step hand test. Next time the firmware changes, put the program version in the board's status
   reply, so the server can tell which firmware runs instead of guessing from the resting axes.
3. **Sleep the Deck and wake it again.** `rtcwake` is proven as the way back.
4. **Type text on the Deck.** Shares the bridge keyboard work with item 3's wake option 1. bonsAI's
   log keeps paying for its absence: a Steam-keyboard check needed the maintainer's own controller,
   and an answer variant "could not be made by the rig (it needs A on a text box)".
5. **Run the same check through every way into the plugin.** Plus bonsAI's new ask: reload only
   the screen side (Steam's Quick Access page), since a full loader restart is what triggers item 1.
6. **Measure colours inside a control.** Lane C gives it pictures from the stand-in; L8 (2026-09-07)
   gave it the image block.
7. **Keep a log of every run automatically.** At the dispatch seam, after lane D has settled it.
8. **Time a run the way a person sees it.** Wants lane D's queue and the lease.
9. **Stand-ins: the VM lane (plan 10 L3) and Route B.** A VM that owns its own display is what frees
   the maintainer's PC during a run; lanes A–C make `this-pc` fast and honest first.

Waiting on work above rather than on scheduling: *Automated issue triage agent* (needs *Studio
issue intake*), *Pluckable studio*.

### How this lands

Lane work happens in per-lane worktrees, then merges to `main` as **one squashed commit per
lane**, so a bad feature backs out with a single `git revert` instead of an archaeology session.
Four rules keep that safe:

- **No lane touches `ROADMAP.md`, `CHANGELOG.md`, `MCP_TOOLS.md`, `AGENTS.md` or the pack copy.**
  Those are written once at the end. Hand-resolved doc merges are a known recurring cost.
- **No version bump until after the on-device pass.** A push to `main` only triggers
  [build-vsix.yml](../.github/workflows/build-vsix.yml) when `extension/package.json` or
  `package.json` changes — and when it does, it auto-publishes a GitHub Release. Leaving the
  version alone is what makes landing unverified features on `main` harmless.
- **Every lane answers one question in its report:** what could this test pass while the real
  thing is broken? If the honest answer is "everything," the feature is marked device-unverified
  rather than counted as done.
- **New: the roadmap copies bonsAI's device verdicts, not the lane's claims.** A lane's "done" is
  desk-verified until bonsAI's findings log or a run file under `runs/` says what the Deck did.
  This month's `deck_openPlugin` history is why.

---

## Planned features

### Hold the Deck awake for a test run, then put the setting back
> **Shipped 2026-09-08 and verified on the Deck.** Second implementation: a logind block
> inhibitor, replacing v1's two settings that held nothing. See
> [Fixed bugs](#fixed-2026-09-08). The spike that found the mechanism is preserved below.
> Held for a full 480-minute lease on 2026-09-23 and again through bonsAI's plan 97 night
> (2026-10-22). The lock self-releases at its TTL; nothing is written, so nothing can leak.

★★ · Planned — asked 2026-09-07, re-scoped to ★★★★ 2026-09-08, **back to ★★ the same day once the spike answered it**
- **Problem:** QA runs involve a lot of waiting (slow replies, game launches, a person reading results), and the Deck falls asleep mid-run. Presses land on a sleeping machine and get lost; reads come back empty — costing real time working out "did the Deck sleep" versus "did the thing under test break."
- **What the spike established, in order:**
  1. **Steam suspends through logind, not around it.** The Deck's own overnight sleep at 01:23 and its 18:06 sleep both logged `systemd-logind: The system will suspend now!`, with `steam[2103]` making a D-Bus call at that instant and NetworkManager, rtkit, UPower and cecd each running their `sleep` *delay* inhibitors. Nothing writes `/sys/power/state` behind logind's back.
  2. **The call is `SteamClient.System.SuspendPC()`**, reachable over CDP in `SharedJSContext` — so the exact path Steam's idle timer takes can be triggered on demand instead of waited for.
  3. **A `block`-mode `sleep` inhibitor refuses it.** With one held, `SuspendPC()` was called and the Deck stayed up; Steam logged the refusal itself: `Error org.freedesktop.DBus.Error.AccessDenied: Access denied due to active block inhibitor`. Zero suspends afterwards. Releasing the inhibitor restores normal sleeping.
  4. **The idle timer looks like 60 minutes** — woke 17:06:56, slept 18:06:58, to the second.
- **The detail that decides whether this works at all: the inhibitor must be held in SYSTEM scope.** `/etc/systemd/logind.conf.d/killuserprocesses.conf` sets `KillUserProcesses=True`, so anything started from an SSH session — including a `setsid`-detached process, which escapes the controlling terminal but *not* the session scope — is killed the moment that SSH session ends. The first run of this spike did exactly that, the inhibitor was dead before the suspend, the Deck slept, and it read as a clean negative. Hold it with `systemd-run` instead:
  ```sh
  # hold
  sudo systemd-run --unit=dps-hold-awake --service-type=simple \
    systemd-inhibit --what=sleep --mode=block --why="DPS: <run name>" sleep <ttlSeconds>
  # release
  sudo systemctl stop dps-hold-awake
  ```
- **Why this retires the whole v1 bug class rather than fixing one instance of it:** it is a *lease*, not a setting. Nothing is read, nothing is written, so there is nothing to restore and nothing to leak — the "absent versus 0" confusion that made v1's restore corrupt `logind.conf` cannot arise, because no config file is touched. If the unit dies, the host crashes, or the TTL expires, the inhibitor is released and the Deck sleeps again: every failure falls toward the safe state on its own.
- **And it can be verified rather than asserted**, which is the actual fix for v1's dishonesty: `systemd-inhibit --list` shows the hold, so `deck_holdAwake` can *prove* it took one before reporting success, and report an honest failure when it did not.
- **Honest limit:** the spike drove `SuspendPC()` directly rather than waiting out the 60-minute idle timer. Both produce the identical logind message from the identical Steam process, so they are almost certainly the same path — but "almost certainly" is not "watched", and the first unattended run longer than an hour is what settles it. **Narrowed 2026-09-23, reported by the bonsAI plan-64 session rather than measured here:** a 480-minute hold was taken and read back as `sleep 28800`, and held for the run — so the TTL reaches the Deck correctly at the top of its clamp, and a hold survives far longer than the 60-minute idle timer in practice. That is a long-run report from a consumer, not a controlled test of the idle path, so the limit is smaller but not gone.
- **Acceptance:** an unattended run of 60+ minutes with no input completes with no lost press and no empty read, with `systemd-inhibit --list` showing the hold throughout; afterwards the Deck's configuration is byte-identical to before (trivially — nothing was written), and the Deck sleeps normally again.

### Sleep the Deck and wake it again
★★★ · Planned — asked 2026-09-05
- **Why it matters:** a bonsAI bug was first seen after the Deck slept and woke — focus landed on an invisible button. Every other way of forcing a redraw (closing a dialog, reopening the menu, restarting the plugin loader) came back clean, so the fix shipped without ever testing the one path that actually showed the bug.
- **Why it's hard:** presses go through a controller, and a sleeping Deck ignores its controller. Sleeping is easy (power menu, or over the network); waking is the problem — the power button is physical, so a sleep with no way back strands the Deck and ends the session.
- **Three candidate wake methods, in try-order** (from maintainer experience 2026-09-05 — a keyboard press has woken this Deck before, and SteamOS has a setting to let some controllers wake it, maybe Bluetooth-only):
  1. **Add a keyboard interface to the bridge board** (alongside its existing gamepad interface) and press a key. Same path known to work on this hardware. Needs two checks first: the extra interface doesn't disturb Steam's view of the controller, and the Deck is configured to allow that USB device to wake it.
  2. **Sleep with a wake alarm already armed**, so the Deck wakes itself after N seconds. No hardware needed, and doubles as a safety net for option 1 — a failed wake then costs a minute, not the whole session. **PROVEN on this Deck 2026-09-08**, as the safety net for the inhibitor spike above: `sudo rtcwake -m no -s <seconds>` arms the alarm without suspending (`/sys/class/rtc/rtc0/wakealarm` reads back the epoch), `sudo rtcwake -m disable` clears it, and when a suspend did happen the Deck woke itself unattended and was back on the network ~7s later — measured suspend 18:44:01, resume 18:45:36, SSH answering 18:45:43. **Try this first when building that tool; it is already the cheapest way back.**
  3. **Wake over the network** (magic packet, or Steam's own Remote Play wake). Least certain, but needs no hardware — worth testing alongside option 2.
- **Shape of the tool:** one call — sleep, then come back after N seconds. It refuses to sleep until it has proven a way back on this machine (armed and read back the alarm, or confirmed the board's wake permission), refuses while a game is running, and logs what it saw before/after to a run file. It must not touch the panel on the way back, so the very next read shows exactly where focus landed. Prefer sleeping through the real power menu (truer to what a person does), falling back to the network method when the menu isn't reachable, and report which path was used.
- **Also needs:** confirming the stop-control (killswitch file) survives a sleep, and reporting plainly — not silently pressing on — if focus comes back somewhere unexpected on wake.
- **Acceptance:** the bonsAI suspend/resume test can run unattended and report where the focus ring landed on wake.
- **Related:** wake option 1's bridge keyboard is the same hardware *Type text on the Deck* below needs; build it once.

### Save and restore the plugin's settings around a test run
> **Shipped 2026-09-07 (plan 09, lane 1). Failed on the Deck three times, fixed three times,
> passed on 2026-10-22.** 2026-09-15: crashed with ENOBUFS on a 75 MB folder (fixed 2026-10-11,
> streamed copy). 2026-10-12: the third copy came back 102,400 bytes short (fixed 2026-10-14, size
> and checksum from the Deck). Morning of 2026-10-22: 0 of 3, because a damaged ten-day-old earlier
> copy was put back first every time (fixed the same night: damaged copies set aside, auto-restore
> only under 6 hours old). **Later on 2026-10-22: 3 of 3 snapshots of the 236 MB folder, each
> byte-identical to a fresh tar** (bonsAI row P89-RIG-SNAPSHOT). Left: a second snapshot taken for
> proof is refused until the first is restored; the driver moved the hold file aside by hand. Lane E
> in plan 11 adds `replace: true`.

★★ · Planned — asked 2026-09-07
- **Problem:** every device session ends with someone putting the Deck back by hand — settings, pinned test questions, which tab was open. bonsAI's plan 31 lists what each round will change and restore, the plan 32 log ends with a paragraph doing it manually, and a `settings.json.bak-preQA` sits on the Deck because nothing tooled does this.
- **What to build:** two paired calls. One copies the plugin's settings directory (and optionally its data directory) over SSH into a run file. The other puts exactly that copy back. Refuse to take a new snapshot while an old one was never restored, and make the restore safe to call when nothing changed — the same safety rules as *Hold the Deck awake* above.
- **Also unlocks:** the "clean install" test rows bonsAI's plan 23 lists as permanently manual become partly mechanical.
- **Acceptance:** a device round that changes five settings and pins three test chips ends with the plugin's files byte-identical to the snapshot, with no hand edits.

### Check the Deck is ready before a run starts
> **Shipped 2026-09-07 (plan 09, lane 2).** `unknown`-never-passes verified on the Deck
> 2026-09-08; the build-match check passed against a real Deck for the first time on 2026-09-23
> (reported by bonsAI). **Open:** on a Windows stand-in it passes with Big Picture behind another
> window, so the first press goes blind ([issue #5](https://github.com/qd313/decky-plugin-studio/issues/5),
> 2026-10-11), and `buildMatches` cannot run on a `local: true` machine ("missing host"). Both are
> lane B in plan 11.

★★★ · Planned — asked 2026-09-07
- **Problem:** runs start blind. bonsAI's plan 23 names "is the Deck in the state I think it is" as the one bucket worth investing in, and the log shows why: a sleeping Deck, a stale build proven only by a manual `md5sum`, a foreign tunnel, a game running when none was expected, and a Steam dialog nobody knew was on screen. Each one costs a run plus the time to work out it wasn't the thing under test.
- **What to build:** one call that takes a declared state and returns the diff: awake, deployed build hash equals the local build, running game is X or none, plugin open on tab Y, no foreign CDP tunnel, nothing modal on screen, focus ring owned. Any mismatch fails the run at step zero with a named reason.
- **Cheap first half:** `deck_deploy` already knows every file it shipped, so "is the right build installed" is a hash compare and nothing more. bonsAI's own `build.ps1` already does this for 57 files.
- **Acceptance:** a run against a Deck that fell asleep, or that still has last night's build, stops before the first press and says which precondition failed.

### Save a passing check and replay it after every deploy
> **Shipped 2026-09-07 (plan 09, lane 3).** Round trip verified on the Deck 2026-09-08. Could not
> replay across a deploy until 2026-09-23 (see Fixed); **proven 2026-09-26 by bonsAI:** a 31-step
> saved Settings walk replayed against a newer build with zero differing landings.

★★ · Planned — asked 2026-09-07
- **Problem:** bonsAI reruns the same sweeps by hand after every build (plan 32: two regression sweeps at 03:50 on build 4), and its key metric is "bugs fixed more than once" — but nothing counts that. Its M4 milestone is exactly "a D-pad bug locked by a check that fails without the fix," reached once by hand.
- **What to build:** a way to save a `deck_runSequence` or `deck_sweep` result, with its expected landings, as a named check file in the consumer repo. A replay call reruns every saved check after a deploy and diffs against the saved result. Sweep reports already reproduce byte-for-byte across runs, so this is a file format plus a loop.
- **Acceptance:** after a deploy, one call replays every pinned check and names the ones whose landings changed.

### Run the same check through every way into the plugin
★★★ · Planned — asked 2026-09-07
- **Problem:** the same bug appears on one entry path and not another. bonsAI measured four fresh mounts, a QAM close-and-reopen, a chord reopen, a modal close, a loader restart and a suspend-and-resume, each landing focus somewhere different for the same bug (`6fb7104`, `1c7e6ac`, `d86b694`). The plan 32 sweeps were clean only because no game was running, so no words were highlighted — and the highlighted words were the trap (`4183f6f`).
- **What to build:** a tool that reaches the plugin by a named path (`fresh`, `qam-toggle`, `chord`, `modal-close`, `loader-restart`, later `suspend-resume`), plus an option on sweep and runSequence that repeats the check across every drivable path and reports each separately. A second axis for "game running / none" belongs here too.
- **New ask from bonsAI (2026-10-14):** a reload of only the screen side (Steam's Quick Access page), because a full `plugin_loader` restart is what breaks `deck_openPlugin`'s first try, and because it cannot reproduce "a kept offer is remembered across a screen-only reload" any other way.
- **Depends on:** *Sleep the Deck and wake it again* for the suspend path; the other paths exist today.
- **Acceptance:** one call runs a check five ways and reports per path, so "passes fresh, fails after loader restart" is a single line rather than a night's work.

### Only one driver at a time
> **Shipped 2026-10-05 (plan 10, lane L2), host half.** A lease per machine in `mcp-server/src/deck/lease.ts`
> (owner, purpose, heartbeat, expiry), taken at the dispatch seam by every driving tool and renewed by each call;
> a second session's press refuses naming the holder; `deck_releaseMachine` releases or, with `force`, evicts;
> `deck_status` stays off the serial port while another session holds the lease. Verified with two server
> processes the same day. **Not built:** the copy of the lease *on the device*; the file lives on the host only,
> so two hosts driving one Deck would not see each other. **Seen since:** on 2026-10-07 bonsAI had one press
> refused naming a holder that turned out to be the caller itself; a retry worked. "Mine" is decided by pid and
> host, and Windows recycles pids quickly. Lane E in plan 11 adds an owner token. Also found 2026-10-22: the
> extension's own commands (deploy, capture, the "show open plugin hint" command, which now drives the Deck)
> take the lease in the extension's process and keep it for up to 10 minutes, during which an agent's presses
> are refused. Lane H.

★★★ · Planned — asked 2026-09-07
- **Problem:** bonsAI's plan 31 states it plainly: the bridge registers CDP tunnels but not presses, and has no lock, so "nobody is looking" does not mean "nobody is pressing." Two chat sessions drove the same Deck in one evening, one pinned chips the other had to restore, and every press batch starts with a manual check for a foreign tunnel.
- **What to build:** a lease with owner, purpose, expiry and heartbeat, held in a file on the host and on the device. Presses, deploys and reloads refuse without it, or when another live holder exists. The extension's 30 s status poll honours it too.
- **Fixes at the root:** the *status poll opens COM7* bug — the poll simply doesn't touch the port while a lease is held. Done 2026-10-05; see Fixed.
- **Acceptance:** a second session that tries to press while the first holds the lease gets a refusal naming the holder, and the status poll never opens the serial port during a leased run.

### Time a run the way a person sees it
★★★ · Planned — asked 2026-09-07
- **Problem:** speed checks that lie. bonsAI's newest commit (`fdfa91a`) is a budget probe that prints PASS at 23–38 ms while a real Ask on the same Deck, minutes apart, costs over a second for the same step — the probe warms itself inside one process, a real question pays every time. Its testing doc now says "ask a throwaway question before timing anything."
- **What to build:** wrap a sequence and a `deck_waitFor` with wall-clock stamps at each stage (press sent, first DOM change, first streamed token via the ingest tail, reply done), repeat N times cold and warm, and report the spread rather than one number. It measures only what the UI shows, so a warm in-process cache can't fool it.
- **Honest limit:** it can't see inside the backend. It answers "how long did the person wait," which is the number the budget is actually about.
- **Acceptance:** three consecutive Asks on the Deck report three separate durations with the per-stage split, and a probe-style false PASS is impossible by construction.

### Make the preview behave more like Steam (retired 2026-10-24; the lint rules stay)
> **Partly shipped 2026-09-07 (plan 09, lane 4).** Lint rules R13 (D-pad via DOM `keydown`) and R14
> (cross-realm `instanceof Element`/`Node`) landed, and the preview shim now swallows direction keys on
> the capture phase so a `keydown` D-pad handler stops working there as it does on device. **Still open:**
> rendering the plugin in a separate frame, so cross-realm brand checks fail in the preview too — see
> `preview-server/src/sandbox-host.tsx`'s `mount()`, where the plugin still shares a document with the shim.
> **Retired 2026-10-24.** The only consumer stopped using the preview on 2026-10-17
> ([issue #6](https://github.com/qd313/decky-plugin-studio/issues/6)) because it never mounted its panel (a missing
> `useQuickAccessVisible` in the `@decky/api` shim, known since 2026-08-08). The maintainer chose to retire the
> preview; lane G in plan 11 removes it. The two lint rules stay. Parts (1) and (2) below are not going to happen.

★★★ · Planned — asked 2026-09-07
- **Problem:** fixes pass on the PC and do nothing on the Deck, repeatedly. The spoiler-fence keydown intercept was "dead code on hardware and alive under vitest, which is the recurrence engine" (`31423e7`) — Steam never dispatches DOM keyboard events into a plugin. The hidden-tab trap's `instanceof Element` check was false for every node because the QAM document is a different realm (`d86b694`), and jsdom shares realms so the test couldn't reproduce it.
- **What to build, in three parts:** (1) the preview stops sending DOM keydown for D-pad and fires only Focusable nav props, as Steam does; (2) the plugin renders in a separate frame so a brand check that fails on the Deck fails in the preview too; (3) the focus linter gains rules against D-pad routing via keydown and against `instanceof Element` / `Node` on nodes from another document.
- **Cheapest slice:** the two lint rules alone are ★ and would have caught both multi-fix bugs before deploy.
- **Concrete first step for:** *One D-pad test, two runners* below — this is what makes the preview runner worth having.
- **Acceptance:** a D-pad handler written on keydown, or a brand-checked node, fails in the preview and the linter, not only on the Deck.

### Find and launch games from the library, not the Recent shelf
> **Lane F in plan 11.** Two things changed since this was written. `deck_launchGame` already reads the
> installed library and `RunningApps` over CDP to refuse an uninstalled title, so the list is known; it just
> cannot reach a tile that is not on the shelf. And the Home-screen route (2026-10-11) walks the shelf RIGHT
> then LEFT on one budget. bonsAI hit the shelf limit again on 2026-09-18: four installed games, none played
> recently, all refused before a press.

★★★ · Planned — asked 2026-09-07
- **Problem:** `deck_launchGame` walks the Home screen's Recent Games shelf in one direction. bonsAI's round 34 hit both limits in one night: Black Mesa was installed but not on the shelf, so the launcher refused it, and "the launcher only walks right, so a ring parked at the end of the shelf makes a present game look absent" (`4183f6f`). bonsAI also read the Steam library over SSH by hand twice to plan test titles.
- **What to build:** a `deck_listGames` that reads installed titles, non-Steam shortcuts and running apps from `SharedJSContext` with no presses, and a launch path that reaches the game through the Library grid (reading each tile's app id from its own image, as the shelf code does) and presses A on Play, with the shelf walk first and the Home route last.
- **Acceptance:** any installed title, including a non-Steam shortcut, launches by app id whether or not it is on the Recent shelf.

### Measure colours inside a control
★★★★ · Planned — asked 2026-09-07
- **Problem:** screenshots are being used as rulers. bonsAI sampled nine points by hand to explain why a corner icon read as 89 % visible on a two-line bubble and 67 % on a one-line one (`48c8c08`), and "measured and pictured" two colour fixes on device (`b8ed222`). The visibility oracle is a DOM hit-test and admits it can't see colour.
- **What to build:** given a selector or the focused element, capture the screen, sample N points inside its rect, return the colours and a cropped PNG, and compare against a saved baseline (`preview.compareScreenshot` does this for the preview only).
- **Why four stars:** needs the capture helper (sudo, gamescope) on every read, and colour thresholds are easy to get wrong in both directions.
- **Acceptance:** "is the focus ring the right colour and uncovered" is a number with a crop attached, reproducible across two runs on the same build.
- **Was blocked on:** L8 in plan 09, which shipped 2026-09-07 and was verified from a packaged build on 2026-09-08: a returned PNG now reaches the model as an `image` content block. Lane C in plan 11 adds the same picture from a Windows stand-in.

### Type text on the Deck
★★★★ · Planned — asked 2026-09-07
- **Problem:** nothing can type on the Deck. bonsAI built "frozen test chips" (`b278f7b`) and pins test questions into `settings.json` over SSH with the panel closed, purely because a question can't be entered from a tool. Every Ask test is routed through that workaround. Still true on 2026-10-22: a Steam-keyboard check needed the maintainer's own controller, and an answer variant "could not be made by the rig (it needs A on a text box)".
- **What to build:** a keyboard interface on the bridge board alongside the gamepad, and a `deck_typeText` that uses it. Shares the firmware work and the "does the extra interface disturb Steam's view of the controller" check with option 1 of *Sleep the Deck and wake it again*.
- **Fallback:** CDP `Input.insertText` is ★ and works today, but must be fidelity-tagged as injected, never `steam-routed` — it bypasses Steam's on-screen keyboard and proves nothing about the real path.
- **Acceptance:** a test types a question into the plugin's Ask field through the bridge and the reply arrives, with no pinned chip involved.

### Keep a log of every run automatically
★★ · Planned — asked 2026-09-07
- **Problem:** bonsAI's `runs/` folder holds 457 hand-named evidence files, `roadmap.md` changed 290 times in a month, and a whole subagent lane exists for "desk paperwork" during device rounds. Each device row means saving a tool result under a name, flipping a testing row, and moving a roadmap entry — three merges were resolved by hand in three days.
- **What to build:** every `deck_*` tool appends a line to a per-session ledger (row id, build hash, running game, verdict, evidence path), tools accept a `rowId` / `saveAs` so evidence files name themselves, and a report call emits the markdown block a testing row expects.
- **Where:** at the dispatch seam in `index.ts`, where the machine, the lease and (after lane D) the deadline already live, not inside each tool.
- **Out of scope:** flipping rows in the consumer's own docs — that convention is theirs.
- **Acceptance:** a night's device round produces a ledger and named evidence files with no hand-typed filenames.

### A self-check for DPS itself
> **Lane H in plan 11.** Cut from plan 09 for capacity. Two more drifts since it was asked: the stand-in ran a
> build a day behind the Deck with nothing to say so (2026-10-11), and this repo's four version pins must move
> together by hand.

★ · Planned — asked 2026-09-07
- **Problem:** three bonsAI commits went to DPS setup drift: Claude Code reads `.mcp.json` not `mcp.json` (`6322f64`), the DPS tools pointed at a path that no longer existed (`d98a97a`), and a second VS Code window killed its own MCP server (`127a743`). bonsAI is now building a connection doctor for Ollama; DPS has none for itself.
- **What to build:** a `studio_doctor` call and IDE command that checks the MCP config points at a live server path, no second workspace shares the preview or sidecar ports, and the bridge, tunnel script and capture helper are present — and prints the fix for each miss.
- **Acceptance:** each of the three drifts above is reported by name with its fix, instead of surfacing as a silent dead tool.

### Studio issue intake
★★ · Planned
- **What:** An MCP tool (`studio.reportIssue`) plus a **Decky: Report Studio Issue** IDE command and tree entry, so an agent that hits a bug can file it without leaving the IDE.
- **Details:** auto-captures a redacted diagnostic bundle (version, Deck env, preview state, recent tool calls), stamps a `reportId` into failed-tool errors, and submits via `gh` or a prefilled issue URL — always previews before posting. Needs `.github/ISSUE_TEMPLATE/` and `surface:*` / `source:*` labels.
- **Evidence it is needed:** bonsAI's findings log holds about twenty DPS-side observations marked "Open, needs filing" that never became issues here.
- **Plan:** [01-dpad-focus-oracle-and-issue-intake.md](planning/01-dpad-focus-oracle-and-issue-intake.md) § Part B

### Pluckable studio
★★★ · Planned
- **What:** Split the all-or-nothing Init Pack into separately installable modules: (1) build/deploy/dev scripts, (2) hooks, (3) MCP tools, (4) subagents + skills, (5) Deck capture and recording, (6) D-pad focus linter — each documented and installable on its own. (The preview module was retired 2026-10-24.)
- **Catch:** the modules aren't actually independent yet — subagent instructions assume the MCP tools exist and hooks assume the scripts exist. Untangling those dependencies is the real work, not the packaging. The linter is source-only, so module 6 stands alone.

### One D-pad test, two runners
★★★★ · **Retired 2026-10-24 with the preview** — requested 2026-08-27
- **What:** write a focus/D-pad test once, run it against both the in-IDE preview (fast, free, CI-friendly) and a real Deck through the bridge (slow, truthful).
- **Honest framing:** this gives a shared test *definition*, not a shared *verdict* — the preview has no access to Steam's real navigation graph, so it can never confirm Deck focus behavior. The win is that the preview catches cheap failures early (a control that stopped rendering, a changed label), while the device run stays the only source of truth for "did the ring actually move."
- **Evidence it's needed:** a real bonsAI navigation bug (Down never reaching a masked spoiler fence) was reproduced twice on-device, but a preview run of the same steps would have reported it as fine, since the preview doesn't model Steam's routing at all.
- **Must-have to avoid making things worse:** label the preview result as a smoke check only, never merge it into the device verdict — a green preview must never be mistakable for a green device result.
- **Concrete first step:** *Make the preview behave more like Steam* above — until the preview stops dispatching keydown and shares a realm with the plugin, its green means less than it looks.
- **Since 2026-10-17:** no consumer uses the preview runner (issue #6). Retired with the preview on 2026-10-24; the device runner is the only runner.

### Automated issue triage agent
★★★ · Planned
- **What:** a GitHub agent with two tiers. Tier 1 (automatic, read-only): classify the issue's surface, dedupe it, check it against `main`, comment with a `file:line` confirmation, label `agent-triaged`. Tier 2 (only when a maintainer adds `agent-fix`): branch, fix, test, open a draft PR — never touches `main`, never releases.
- **Guardrails:** issue text is untrusted public input; anything needing hardware to confirm (`needs-hardware`) must stop and ask rather than guess. Depends on the issue-intake feature above for good signal.
- **Plan:** [01-dpad-focus-oracle-and-issue-intake.md](planning/01-dpad-focus-oracle-and-issue-intake.md) § Part C

### Drive several Decks at once: stand-in Decks for bonsAI
> **In progress since 2026-10-05 ([plan 10](planning/10-stand-in-decks.md)).** Built and unit-tested the same
> day: the machine registry (`machines.json`, `machine` on every `deck_*` tool, `deck_listMachines`, every result
> stamped `machine: { name, kind, os }`, `machineKind` in `deck_checkReady`), the lease above, the virtual gamepad
> (`bridge/tools/vpad.py`, uinput on Linux and ViGEm on Windows, same protocol as the board), per-machine
> killswitch with the virtual controller shown and released from the VS Code status bar, and the host/guest
> scripts under `scripts/standin/`. **Verified on the maintainer's PC as stand-in `this-pc`** (Route A″: Decky
> Loader for Windows in this PC's Steam, bonsAI deployed, CEF read with no tunnel, pad seen by Windows, a second
> session's press refused). **First press done 2026-10-07 (plan 10 § 13):** the virtual pad opened the QAM
> and walked its tabs with a person watching. **2026-10-08: bonsAI opened and swept on `this-pc`** with upstream
> loader v3.2.10 (6 controls, every stop visible); the v3.2.10 exes live in `homebrew\services`, so the Startup
> shortcut and `deck_deploy` start the right loader. **2026-10-09/10, bonsAI's plan 87 night, the first real use:**
> a 30-press sweep took ten minutes, presses landed "about 10 s late", and every stand-in evidence file says
> "no screenshot was taken". Filed 2026-10-11 as [issue #4](https://github.com/qd313/decky-plugin-studio/issues/4)
> (every focus read waits out 18 frozen desktop pages; no capture on Windows) and
> [issue #5](https://github.com/qd313/decky-plugin-studio/issues/5) (nothing checks that Big Picture is the
> front window, so the first press goes blind). Both are lanes A–C in plan 11. **Still open after those:**
> `openPlugin` naming a first-run dialog that takes the ring; the VM lane (Memory Integrity off, VirtualBox
> installed); Route B; the lease's device half.

★★★★★ · Planned — unshelved 2026-09-23 (shelved 2026-09-05 as *Parallel VM QA farm for bonsAI*)
- **What:** up to four virtual Decks (Bazzite) on the maintainer's PC, each driven by its own AI session at the same time, so bonsAI's test rows stop queuing for the one real Deck.
- **Why it's unshelved:** both halves of the old blocker were relaxed on 2026-09-23. One Steam account may sign in once per stand-in and then stay offline. And a stand-in no longer has to pass everything a Deck passes: hardware, game-running and timing rows stay on the real Deck.
- **What DPS has to build:** a list of machines with their addresses, with every call naming which one it drives; a way to tell a stand-in from the real Deck; a virtual gamepad inside each stand-in, because the one bridge board can only press buttons on one machine; and *Only one driver at a time* above, per machine.
- **Plans:** [planning/08](planning/08-parallel-vm-qa-farm.md) (the 2026-09-05 discovery, now with a § 7 on what changed) and bonsAI's plan 67, `docs/planning/67-stand-in-decks.md` in the bonsAI repo (phases, decisions, the machine's measured budget). bonsAI's Phase 0 (can one stand-in run game mode at all) comes before any DPS work.

#### Use the PC while this-pc is being driven (asked 2026-10-07)
★★★ · Planned — a stand-in on the maintainer's own desktop takes the desktop with it, and that should stop being true. **The cheap half is lane B in plan 11** (issue #5, filed 2026-10-11 with the numbers: Big Picture's own page reports `visibilityState: "hidden"` and `hasFocus: false` when it is behind, and nothing reads it).
- **What is true now:** Steam Big Picture only takes pad input while it is the foreground window, and a mouse crossing it moves the focus ring. So on `this-pc` the maintainer cannot type or click anywhere during a run, on any monitor: a run with Big Picture in the background stalls (presses go nowhere, or into whatever is focused if Steam Input's desktop layout is on), and a run with Big Picture in front is disturbed by every keystroke. Moving the window to another monitor changes neither.
- **What fixes it for real:** a stand-in that owns its own display and input. That is the VM lane (plan 10 L3, a Bazzite VM has its own screen and its own virtual pad) and Route B. The `this-pc` stand-in stays the quick one for a watched run and for "does bonsAI load on this Steam build at all".
- **Added 2026-10-25: `deck_focusBigPicture`.** The gate (lane B) is proven, and the other half of the ask -- not needing a hand to open Big Picture and put it in front before a run -- has a tool: if Steam is in the desktop client (UI mode 7, no Big Picture page listed), `SteamClient.UI.SetUIMode(4)` and a wait for the page; Win32 `ShowWindow(SW_RESTORE)` if Steam says the window is minimized (no Steam call restores it; measured); then Steam's own `BringToFront(1)` and a `SetKeyFocus` off/on toggle; then the gate read again. Measured on the PC through the tool for all three cases (desktop mode 0.9 s with Decky's loader and Quick Access tab intact afterwards; minimized 1.4 s; covered 0.7 s). Known limit: the Windows lock screen leaves Big Picture's page reading visible and focused. Still true: a mouse crossing the window moves the ring, and a keystroke lands in Big Picture, so the maintainer's hands are still off during a run; what is gone is opening Big Picture and the alt-tab before it.
- **What DPS can add cheaply on `this-pc`:** a *foreground* gate: `deck_checkReady { machine: "this-pc" }` fails unless Big Picture is the foreground window, and a walk pauses (does not press) the moment it is not, then resumes when it is back, so a stray alt-tab costs a retry instead of a mis-landed press. A second Windows session (another user signed in, Steam running there) is worth measuring as a middle route: separate input focus, same hardware, no VM.

---

## Open bugs

### `deck_openPlugin` still fails on the first try after a plugin reload or deploy
★★★ · Open since 2026-08-30 ([issue #3](https://github.com/qd313/decky-plugin-studio/issues/3)) — fixed four times, failed on the Deck after each
- **The history, as bonsAI's device log records it.** 2026-09-02: retry target enumeration, gate the chord on the pane being closed (issue #3's asks). 2026-09-26: one failed open then a working retry, three times in one night, once four tries. 2026-10-01: failed three times before the fourth. 2026-10-11: wait for the Quick Access page after a reload, keep reading 3 s after the chord; on the Deck 2026-10-12, 0 of 3 first tries. 2026-10-14: try once more inside the same call; on the Deck the morning of 2026-10-22, failed both counted rounds. 2026-10-22: wait for Decky's tab on the rail, close and reopen the menu when it is missing; on the Deck later that day, **3 of 3 on a first set, 1 of 3 on a stricter set** with a read after each call — both failures 1 s after the reload with a "debugger connection reset".
- **What is known now.** Two faults were tangled. One is fixed: after a reload Decky's tab can be gone from the rail for over 100 s, and waiting does not bring it back, closing and reopening the menu does (the 2026-10-22 reopen step did that by itself in about 25 s, 3 of 3). The other is not: in the first second or two after `plugin_loader` restarts, CEF's debugger resets connections, and a call that starts inside that window fails. Nothing has measured what the debugger does in those seconds; every fix so far was written against a fake CEF that does not reset.
- **Also found 2026-10-22:** the "a reload just happened" note that makes the tool wait lives in one server process's memory (`deck/loaderRestart.ts`), so a reload done from the extension is invisible to an agent's server.
- **Next:** item 1 of the solo season. Measure first. Done when bonsAI's row P89-RIG-OPEN-AFTER-RELOAD reads 3 of 3 on the stricter set.
- The older entry *"intermittently fails to open the QAM"* (2026-08-28, chord delivered before the client could act on it) is this bug's first sighting and is folded in here.

### Windows stand-in: every focus read waits out the frozen desktop pages, and there is no screenshot
★★ · **Fixed, proven on `this-pc` 2026-10-25** — [issue #4](https://github.com/qd313/decky-plugin-studio/issues/4), 2026-10-11 — fixes landed 2026-10-24 (plan 11 lanes A and C); on the stand-in a read is 6 ms and asks 5 pages, a verified press about 240 ms, and `deck_captureScreenshot` returns the real Big Picture home over CDP. The GitHub issue is still open for the maintainer to close.
- **Slow:** Steam on Windows lists 24 pages on its debug port; 18 belong to the hidden desktop window and never answer `Runtime.evaluate`. Since 2026-10-08 the read asks all pages at once, but `Promise.all` waits for the slowest, so every read lasts the full 10 s timeout even when the Quick Access page answered in 5 ms. A verified press is three reads: 20–30 s. A 30-press sweep took ten minutes. The 10 s cost is invisible when a page owns the ring (`ok: true`, no timing field).
- **Blind:** `deck_captureScreenshot` and `deck_record` refuse on `os: "windows"` because the capture scripts need gamescope. Honest, but every stand-in evidence file says "no screenshot was taken". CDP `Page.captureScreenshot` on the Big Picture page needs no compositor.
- **Fix:** return on the first page with the ring (listing order kept), give a page that froze a short budget next time, report `timedOutPages`; capture through CDP with a window grab as fallback, stamped with the machine.

### Windows stand-in: nothing checks that Big Picture is the front window
★★ · **Fixed, proven on `this-pc` 2026-10-25** — [issue #5](https://github.com/qd313/decky-plugin-studio/issues/5), 2026-10-11 — fix landed 2026-10-24 (plan 11 lane B); covered, `deck_checkReady` failed naming the reason, `deck_walkTo` pressed nothing, `deck_status` read hidden, and `buildMatches` gave a real hash verdict; in front, all passed. Also measured: with Big Picture behind, Steam drops the gamepad ring, so a verified press refuses on the focus read first. The GitHub issue is still open for the maintainer to close.
- **Problem:** with the Claude window in front of Big Picture, `deck_checkReady { machine: "this-pc" }` passed every check it was given, `deck_readFocus` read "nothing currently owns gamepad focus", and that is the reading every driving tool answers with a blind DOWN press into whatever window is in front. Big Picture's own page reported `visibilityState: "hidden"`, `hasFocus: false`; nothing reads it.
- **Also:** `buildMatches` on a `local: true` machine returns `unknown: missing host`, so the stand-in sat a day behind the Deck (00:50 vs 17:19 builds) with nothing to say so.
- **Fix:** a foreground check in `checkReady` (default on for Windows), a refusal instead of a blind press, the state in `deck_status`, and a local hash for `buildMatches`.

### A lone Steam-button press reached the Deck and opened no menu, until a replug
★★ · **Fixed 2026-10-25** — cause was the triggers resting half pulled (`05_triggers` rested them at 0); firmware `06_trigger_rest` (rests at -127) flashed 2026-10-24, and on 2026-10-25 two lone GUIDE presses each opened the main menu (ring on "Home" in `MainMenu`, steam-routed), B closed it, an LT press between them changed nothing. `deck_launchGame` took the menu route the same night.
- **Seen:** bonsAI's plan 89, Deck blocks 1 and 2. The Deck's input system received one key down and one up (code 316) with nothing extra, and Steam's menu stayed shut; the chord with A still opened the Quick Access menu. After the maintainer unplugged and re-plugged the board's Deck-side cable a lone press opened the menu, and still did after an LT press, so the "triggers rest half pulled" idea (`05_triggers` rests both at 0, the middle of the axis) did not reproduce.
- **Shipped around it:** `deck_launchGame` falls back to the Home-screen route and `deck_exitGame` to Steam's own close call when the Steam button opens no menu (Fixed 2026-10-11), and firmware `06_trigger_rest` rests the triggers at -127. The board's status reply carries no program version; today the resting axes are the only tell (`06` rests the triggers at -127, `05` at 0).
- **2026-10-24:** `06_trigger_rest` flashed with the Deck-side cable unplugged; the board's `status` read back the triggers resting at -127 on the fresh boot. **2026-10-25:** the four-step hand test passed (GUIDE → menu, B, LT, GUIDE → menu, B). Closed. Still owed: the program version in the status reply, with the next firmware change.

### A tool call can hang for half an hour, and the server can drop mid-call
★★ · Open — reported 2026-09-19, 2026-09-26 (twice) and 2026-10-22 (twice) — fix landed 2026-10-24 (plan 11 lane D), stays open until its device pass
- **Seen:** one `deck_walkTo` hung for 35 minutes and returned nothing. A tool stalled about 29 minutes with no press sent and no error until the next call; by then the screensaver had changed the screen and the session ended early. On 2026-10-22 the tool connection closed mid-call twice, and the chat lost every DPS tool until a new chat was started (the Claude desktop app cannot restart a project's tool server mid-session). On 2026-09-19 the screen connection stopped answering for several minutes while SSH still worked.
- **Why it can happen:** `index.ts` has no wall-clock deadline per call and no `unhandledRejection` / `uncaughtException` handler, so a stuck read waits forever and one stray rejection ends the process.
- **Fix:** a deadline per call at the dispatch seam that ends the call with the stage named and the pad released; process-level handlers that log and keep the server up.

### Two presses sent at once clash on the bridge's own port
★ · Open — 2026-09-26 — fix landed 2026-10-24 (plan 11 lane D), stays open until its device pass
- The lease is per session, so two calls in flight from one session can both reach the board. bonsAI's driver rule since then: one press at a time. The fix is a queue per machine in the server, so the second driving call waits instead of racing.

### A lease refusal named a holder that was the caller itself
★ · Open — 2026-10-07 — fix landed 2026-10-24 (plan 11 lane E), stays open until its device pass
- One press was refused as "being driven by another session (a process on this desktop)"; `deck_status` a moment later showed the lease as the caller's own; a retry worked. Only one session drove the Deck that night. "Mine" is decided by pid and host (`lease.ts:140`), and Windows recycles pids quickly. Fix: an owner token per server process in the lease record.

### `deck_exitGame` trusts an empty `RunningApps`, and stops on Home with a game underneath
★★ · Open — 2026-09-19, 2026-09-25 (twice), 2026-09-26 (twice) — fix landed 2026-10-24 (plan 11 lane F), stays open until its device pass
- Mid-Black Mesa the screen connection dropped; when it came back `RunningApps` read empty while the Black Mesa process ran at full CPU on its own menu, 32 minutes after the last press. The tool believed the list; the session killed the process over SSH by hand. Separately, after a plugin reload left Steam's Home in front of a running game, the exit tool stopped on Home four times and the driver exited by hand. Fix: check the process list over SSH before declaring nothing running; continue the exit route when `RunningApps` says a game is underneath.

### `deck_getEnv` reports `pluginLoaderActive: "inactive inactive"` while the loader runs
★ · Open since 2026-08-28 (bonsAI finding P2-5) — fix landed 2026-10-24 (plan 11 lane E), stays open until its device pass
- `tools/deckAutonomy.ts:270` runs `systemctl --user is-active plugin_loader.service || echo inactive`. The unit is system scope, so the `--user` half prints `inactive`, exits non-zero, and the `|| echo` prints a second one. It is the first field anyone reads when a deploy or an open fails, and it points away from the cause.

### A second settings snapshot taken for proof is refused until the first is restored
★ · Open — 2026-10-22 — fix landed 2026-10-24 (plan 11 lane E), stays open until its device pass
- The refuse-while-unrestored rule is right for a run and wrong for a proof: to take three snapshots in a row the driver moved the hold file aside by hand. Fix: `replace: true` sets the earlier copy aside under a dated name and says so; the default stays refuse.

### The extension's "Show open plugin hint" command presses buttons and keeps the lease
★ · Found 2026-10-22 in this audit — fix landed 2026-10-24 (plan 11 lane H), stays open until its device pass
- `decky.showOpenPluginHint` (`extension/src/extension.ts:53`) calls `deck_openPlugin {}`, which has driven the Deck by default since v0.3.9, and reads a `checklist` field that only exists on failure. It also takes the machine's lease in the extension's own process, as do the Deploy and Capture commands, and keeps it for up to 10 minutes, during which an agent session's presses are refused naming "another session". The extension's request timeout is 120 s; a worst-case open (45 s restart wait plus a 120 s tab wait plus a retry) runs longer. Fix: `drive: false` in the hint command; release the lease at the end of each one-shot command.

### The preview reports fiction: five findings from 2026-08-08, never fixed
★★ · **Closed 2026-10-24 by retirement** — the preview was removed (`9d30a33`); the only consumer had stopped using it on 2026-10-17 ([issue #6](https://github.com/qd313/decky-plugin-studio/issues/6)). Kept here as the record of why.
- **P0-1, blocking:** the `@decky/api` shim lacks `useQuickAccessVisible`. A plugin that imports it throws before `mount()` registers its listener, so every IPC command times out at 120 s with the real error only in the iframe console. This is why bonsAI's panel never mounted. One line of shim. Still missing on 2026-10-22 (`preview-server/src/shim/api.ts`).
- **D1:** `snapshotDom` cuts at 8,000 bytes with no marker (`sandbox-host.tsx:54`), and a plugin's injected `<style>` can be the whole snapshot.
- **D4:** `preview_captureScreenshot` can return a flat placeholder PNG reading "Decky preview snapshot (placeholder)" (`sandbox-host.tsx:91`) under the name of a screenshot; consumers archived it as evidence.
- **P2-3:** `isOpen()` (`extension/src/preview/manager.ts:151`) checks the VS Code panel object, not the backend, so a dead Vite child leaves the preview "healthy" while every command times out.
- **P1-4:** two workspaces with DPS installed silently share one preview (global state file, global ports).
- bonsAI keeps `.decky/preview.json` only because `deck_openPlugin` reads `panelRootSelector` from it.

### `preview.test.ts` fails intermittently under the full suite
★ · Open — found 2026-09-23; did not reproduce in the 2026-10-22 full run (495 pass)
- **Problem:** *"previewStart reports running:true only once the configured URL actually answers"* failed once in a full `pnpm -r test` run, then passed 5/5 when the file was run on its own, and passed on the next full run. Timing- or port-sensitive under parallel load rather than a real regression.
- **Why it is worth an entry rather than a shrug:** this repo has already paid for this once. `npm test` failing on a clean checkout for an incidental reason cost four of the eight parallel lanes real time in plan 09, and the note written then still applies — a check that goes red for a reason unrelated to the code teaches people to read red as noise, which is the same disease as a check that goes green when it should not.
- **Fix idea:** bind the probe to an ephemeral port chosen at test time rather than a fixed one, and assert on the observed transition instead of a timeout window.

### Reported once by bonsAI, not reproduced, not yet filed
Kept so a repeat is not a surprise. All from bonsAI's device log unless dated otherwise.
- The game launcher read an empty ring on Steam's Home screen and failed once; the exit tool refused once because the menu had opened on Settings; both worked on retry (2026-09-26).
- `deck_walkTo` sometimes reports the chat row absent in a full sweep from the tab bar, while a single DOWN lands on it fine (2026-09-26).
- An RB press was swallowed once right after a folded turn was reopened (2026-09-26). The first LB press on the chat row was ignored once (2026-09-26).
- The rig's own screenshot chord (Steam + R1) took no picture, twice (2026-09-26).
- After a plugin reload with a game running, Decky's loader restarted `steamwebhelper` and Steam's screens never came back; the maintainer restarted Steam (2026-09-26). A Decky Loader behaviour, possibly triggered by a reload right after a launch.
- A press was refused with "controller bridge is not available … could not open port", then worked (2026-09-26, before the lease fix). `deck_openPlugin` on `this-pc` reported "the panel did not mount" when bonsAI's first-run dialog had taken the ring; it should name the dialog (2026-10-08, plan 10 § 13).

---

## Fixed bugs

### Landed 2026-10-24 (plan 11, eight parallel lanes) — device pass run 2026-10-25 on `this-pc` (A to D) and the Deck (E, F, H)

> Per this file's rule, these are "landed", not "fixed", until a device says so. On 2026-10-25 phase 2
> ran from this repo on both machines (verdicts below, per lane). What a lane left unproven is named. The honesty paragraphs from the lane reports are in
> [plan 11 § Outcome](planning/11-parallel-feature-session-2.md#outcome-2026-10-24).

- **A** `a348319` — `deck_readFocus` returns on the first page with the ring, gives a page that froze a 500 ms budget next time, reports `timedOutPages` / `slowestPageMs`, and on Windows asks only Big Picture's pages. Fake-CDP timings: a third-page read 2000 ms → 150 ms. **`this-pc` 2026-10-25: proven** — 6 ms a read, 5 pages asked, no timeouts; a verified press about 240 ms (was 20-30 s); hidden reads 4 ms.
- **B** `5877733` — `deck_checkReady` gains `foreground` (default on for Windows), the focus-acquire press refuses when Big Picture is hidden, `deck_status` reports `bigPicture`, and `buildMatches` hashes a local `pluginsDir`. **`this-pc` 2026-10-25: proven** — covered: `checkReady` failed on `foreground` alone, `walkTo` pressed nothing, `status` read hidden; `buildMatches` gave a real hash verdict (the stand-in's bonsAI was behind the local build); in front: all passed. Not tested on purpose: a plain unverified `pressButton` while covered, because the virtual pad would feed whatever window is in front.
- **C** `80727db` — `deck_captureScreenshot` on Windows captures the Big Picture page over CDP (`method: "cdp"`) with a PowerShell window grab as fallback; `verifyPackagedScripts` checks the new script ships. **`this-pc` 2026-10-25: proven** — a real Big Picture home (game shelf visible), 3.2 MB PNG, image block returned. The window-grab fallback has still never run.
- **D** `36600d3` — a wall-clock deadline on every call (`deadlineMs`; 10 min driving, 60 s reads, 30 s status), children killed and the pad released on timeout, process-level crash guards that keep the server up, and one driving call at a time per machine (`waitedForPreviousCallMs`). Known gap: an abandoned call's promise is not stopped, so it could still press after its deadline. **`this-pc` 2026-10-25: proven for the deadline and the queue** — a 1 ms `deadlineMs` returned the honest error naming the call; two presses sent at once ran one after the other (`waitedForPreviousCallMs: 258`) and a read beside them did not wait. The alt-tab-mid-walk stall no longer exists to time (hidden reads return in 4 ms). The known gap is untested.
- **E** `3d90fc3` — `deck_getEnv` reads the loader at system scope (`inactive inactive` gone); `deck_snapshotSettings { replace: true }` sets an unrestored earlier copy aside instead of refusing; `requireVisible` defaults to ON; the lease carries an `ownerToken` so a reused pid cannot look like another session, and a failed lease write no longer leaves a `.tmp` file (five were found on the PC). **Deck 2026-10-25:** `getEnv` reads `pluginLoaderActive: "active"`; three `replace: true` snapshots in a row (231 MB, ~6 s each, Deck-side checksums matching) set the earlier holds aside and left byte-identical archives; restore clean. The `requireVisible` flip is still unexercised: bonsAI's panel has no covered stop any more (sweep: 12 controls, all visible). The lease token was not tested apart.
- **F** `abb8a86` — `deck_listGames` (zero presses), a Library-grid launch route (`launchRoute: "shelf" | "library" | "home"`), `deck_exitGame` checks `pgrep` for the game's process when `RunningApps` reads empty (`processAlive`), and continues the exit route when the menu opens on Home over a running game. The grid's DOM shape is a model from the shelf, never measured; ten reads to confirm are listed in the plan. **Deck 2026-10-25:** `listGames` read 273 installed titles with zero presses (shelf honestly "not read", ring off the tiles); `launchGame` by app id took the menu route, walked the shelf to its end, opened the Library grid for the first time on hardware (real tiles, app ids read from their images: ARC Raiders, Deep Rock Galactic, ... Grim Dawn), and after one row DOWN did not move the ring, so it refused with the last tile named and never pressed A -- **the grid walk's DOWN step is the open question**; `exitGame` with nothing running agreed with the process list. The with-a-game-running shape did not run.
- **G** `9d30a33` — the in-IDE preview retired: 16 tools, the `preview-server` package, the extension panel, the test kit and two skills removed; `.decky/preview.json` still read for `panelRootSelector` and `preDeployCommand`. VSIX 32 MB → 8 MB.
- **H** `a022acb` — `studio_doctor` and the "Decky: Doctor" command (seven checks; six passed on the maintainer's PC the same day, one `unknown`); the extension's hint command passes `drive: false`; its one-shot commands release the lease. **PC 2026-10-25:** `studio_doctor` from the bonsAI checkout: 7 ok, 0 unknown. The deliberate version-pin break was not tried.

### Fixed 2026-10-22 (bonsAI's plan 97 night; branch `bonsai-p97`, merge `43afc0b`)

> **Device verdicts the same day**, from bonsAI's log (Deck build `15565346`): the settings snapshot
> **passed** (3 of 3 byte-identical copies of a 236 MB folder), the sampler **passed** (row
> P97-X2-SAMPLER), and the open-after-reload fix passed 3 of 3 on a first set and **failed 1 of 3 on a
> stricter set**. Two of three are closed; the third stays in [Open bugs](#open-bugs). These fixes load
> only in a chat started after the rebuild (about 02:30), because the Claude desktop app cannot restart a
> project's tool server mid-session.

**After a reload, Decky's tab was gone from the rail for over 100 s, and `deck_openPlugin` walked a rail without it** · ★★ (`ca6a71f`, `0527dfa`)
- **Problem:** the 2026-10-14 fix waited for the Quick Access page but not for the plugin's own tab. On the Deck the morning of 2026-10-22 (build `73738058`) the first try failed in both counted rounds; waiting 90 s with the menu open did not bring the tab back, closing and reopening the menu did.
- **Fix:** `probeQuickAccess` reports whether Decky's pane is mounted. Before walking the rail the tool polls once a second for up to 120 s, pressing nothing; every 10 s inside that wait it sends the chord to close the menu, checks it shut, sends it again to open, and checks it opened. If the menu does not shut it stops and sends nothing more.
- **Device:** the reopen step fixed the missing-tab case by itself in about 25 s, 3 of 3. The failures that remain happen 1 s after the reload, before any of this runs; see Open bugs.

**A damaged, ten-day-old earlier settings copy was put back first, every time** · ★★ (`d62d2a5`, `49d6bac`)
- **Problem:** on the Deck the morning of 2026-10-22, 0 of 3 snapshots: each began by restoring a 12 October copy that was itself damaged ("tar: Skipping to next header") and failed there. The live settings were untouched (same checksum and folder dates).
- **Fix:** the saved archive's tar headers are checked on the PC before anything is sent (`deck/tarCheck.ts`, no tar program needed); a damaged copy is set aside as `settings-hold.unrestorable-<ts>.json` and no longer blocks new snapshots. An earlier copy is put back by itself only when it is under 6 hours old (`MAX_AUTO_RESTORE_AGE_MS`); older ones are set aside as `.stale-<ts>.json` and can still be restored by hand with `deck_restoreSettings`.
- **Device, later the same day: passed.** Three snapshots, each equal file by file to a fresh tar of the live folder; the first set the old copy aside. Left: calls 2 and 3 were refused until call 1 was restored (Open bugs).

**A folded section line read 92 percent visible while its words were whole** · ★ (`1a5e8fe`)
- **Problem:** the text-line sampler (2026-10-03, below) counted summary text that runs 32 to 78 px past the panel edge under an ellipsis, so every folded section on bonsAI's Settings and Developer tabs read "partial, clipped by a container".
- **Fix:** each text line's box is first cut down to what the clipping boxes between the control and the text actually show (`narrowClip`); a sample point outside the control's own box that lands on an ancestor is not counted; if no point is left the 3×3 box sample is used.
- **Device: passed** (folded sections read 100 percent, "text", no clip).

### Fixed 2026-10-14 (bonsAI's plan 93, lane R; branch `p93-rig`)

**The first `deck_openPlugin` after a reload reads again and tries once more inside the same call** · ★ (`be3f88a`)
- One more try after 2.5 s, only when the first try pressed nothing or only the open chord; never after a stopped run or a failed tab wait. A connection reset inside the wait counts as "not up yet". Stages are prefixed `try1:` / `try2:`. **Device: failed** the morning of 2026-10-22, both counted rounds. Superseded by the 2026-10-22 fix above; the fault that remains is in Open bugs.

**A settings snapshot that comes back short or damaged is an error, checked against the Deck's own size and checksum** · ★ (`b2b2bf0`)
- Found because on 2026-10-12 the third saved copy came back 102,400 bytes short and could not be restored. The Deck-side script now tees the tar through size and sha256 counters and prints them on stderr; the PC rejects a missing line, a wrong size or a wrong checksum, deletes the partial file, takes the copy once more, and then fails naming both sizes. The small buffered path is still unchecked. **Device:** exercised by the 2026-10-22 pass above.

### Fixed 2026-10-11 (bonsAI's plan 89; branches `p89/r1`–`r3`)

**`deck_openPlugin` waits for the Quick Access page after a reload, and keeps reading for 3 s after the chord** · ★ (`59d1698`, `28e7325`)
- `deck_reloadPlugin` leaves a note (per machine, in memory, 120 s); while it is fresh the open call waits up to 45 s for the Quick Access page before any read or press. After the chord it re-reads every 300 ms for 3 s and never resends the chord. **Device 2026-10-12 (build `d553a5b4`): did not cure it**, 0 of 3 first tries. The note lives in one process, so a reload from the extension is invisible to an agent's server.

**`deck_snapshotSettings` failed with ENOBUFS on a real settings folder** · ★★ (`642dc28`, `d3c0dd3`) — reported 2026-09-15 and 2026-09-28
- **Cause:** one `execSync` of a base64 tar through a 64 MB buffer. **Fix:** the buffered copy has a 16 MB buffer; when it overflows, ssh is spawned and its stdout written straight to the archive file and hashed as it goes; the result says `method: "streamed"`. **Device 2026-10-12:** the error was gone; the third copy came back short (fixed 2026-10-14 above).

**`deck_launchGame` and `deck_exitGame` work when the Steam button opens no menu** · ★★ (`33c4335`, `bbc0454`)
- **Why:** the lone-Steam-button failure above (2026-10-11). **launchGame:** if the Quick Access menu is open it closes it with the chord and checks; then requires the route `/library/home` and the ring on a tile whose own image names an app (anything else is refused, because reaching Home would need B, which it never presses); walks the shelf RIGHT then LEFT on one budget; reports `via: "home-screen"`. **exitGame:** when GUIDE opens no menu at all, it calls `SteamClient.Apps.TerminateApp` in SharedJSContext, the one scripted path in that file, reported as `via: "steam-close-call"` with fidelity `wire-sent` and a summary starting "closed without the Steam menu".
- **Device:** unit-tested only; the Deck check is owed. bonsAI closed its own row after the replug restored the button.

**Firmware `06_trigger_rest`: the triggers rest at the bottom of their axes** · ★ (`59b74b8`) — **flashed 2026-10-24**
- `05_triggers` rested both triggers at 0, the middle of the axis. Compiled (373,350 bytes) and flashed on 2026-10-24 with the Deck-side cable unplugged, per the README's rule; `status` read back `ax:[0,0,-127,-127,0,0]` on the fresh boot. Whether this was the cause of the shut Steam menu is still the hand test's to say (Open bugs). No unit test exists for the firmware.

### Fixed 2026-10-08

**A focus read asked Steam's pages one at a time, 10 s each** · ★ (`32dbe03`, plan 10 § 13)
- On the Windows stand-in Steam lists its hidden desktop window's pages beside Big Picture's, and they never answer, so a read took 2.5 minutes and `deck_openPlugin` timed out. Now every page is asked at once and the answers are read back in listing order, so the first page with the marker still wins: 12 s measured. `deck_readFocus` gained `timeoutMs`. **Residue:** the read still waits for the slowest page before answering (issue #4, lane A).

**The board had no triggers** · feature (`971556b`)
- LT and RT as the Z and Rz axes, in firmware `05_triggers`, `pad.py` and `vpad.py`; every press tool takes the names; a board on an older program refuses them by name. **Measured on the Deck the same night:** one TRIGGER_LEFT, one TRIGGER_RIGHT, ring unmoved. 438 tests.

### Fixed 2026-10-05 (plan 10)

**The extension's 30 s status poll opened COM7 during a run** · ★ (found 2026-08-31, mitigated 2026-08-31, root fix in `abdc5f2`)
- **Problem:** the extension polls `deck_status` every 30 s ([extension.ts](../extension/src/extension.ts) `pollStatus`), which opened the same serial port a live press was using. Early `deck_sweep` runs died around press 10–22 with `PermissionError: could not open port 'COM7'`.
- **Root fix:** `deck_status` stays off the serial port while another process holds the machine's lease ("not probed: the status poll stays off a leased serial port", `index.ts:208`). The lease is taken by the first driving call and kept for 10 minutes after the last.
- **Residue:** a status call from the same process that holds the lease still probes; a probe already running when a run starts can collide once; the skip branch has no unit test of its own. The 2026-08-31 mitigation stays: `pressButton` retries once, 350 ms later, on exactly this error and reports `retried: true`. Not separately verified on device; bonsAI has reported no COM7 collision since.

**`bridge/tools/chord.py` ignored `--port`** · ★
- It opened `COM7` unconditionally, so a board on any other port could press but not chord. Found while giving each machine its own bridge port.

### Fixed 2026-10-03

**The walk check called a stop "partial" when a corner icon only overlapped its box** · ★★ (`cde1c0e`; found by bonsAI's plan 63 and 79 sessions)
- **Problem:** the visibility check sampled nine points across the focused control's box. Two bonsAI controls (Retry and Copy) are built so their box overlaps a floating corner icon while their words stay clear, so every walk read them 78 % and 89 % "partial" with nothing wrong, and a real cover on some other stop had to be told apart by hand.
- **Fix:** a control that has words is sampled where its words are: three points along the middle of each text line box. A line hit by a different element is covered; a point in the box's padding or line spacing is not sampled. A control with no text keeps the box sample. `visibility.sample` says `"text"` or `"box"`; `visiblePercent` is out of the points actually sampled.
- **Device:** the 2026-10-22 sampler row passed on top of this and the 2026-10-22 refinement.

### Fixed 2026-09-23

**A saved check could never replay after a deploy, which is the only moment replay is for** · ★★ (found by the bonsAI plan-64 session)
- **Problem, as reported:** `deck_replayChecks` refused to replay a check saved earlier the same evening, saying it was saved against a different build fingerprint — and the fingerprint included the plugin's `__pycache__` files, which change on every deploy.
- **Confirmed, and it is two bugs, not one.** `py_modules` is in `DEPLOY_COPY_ENTRIES` and the fingerprint walk recurses, so every `__pycache__` entry was hashed. A `.pyc` embeds the source's mtime and size in its header, so it is rewritten whenever the `.py` is rewritten — even when the source is byte identical. The hash therefore moved on every build with no source change at all. That also broke this module's own stated rule, which says mtimes must not move the hash: a `.pyc` is an mtime wearing a content disguise.
- **The second bug is worse and was not visible from the outside.** `diffCheck` returned early on any hash mismatch with `diffs: []` — but `replayChecks` has already run the sweep or sequence by then. The presses were sent and the time on hardware was spent, and then the answer was thrown away. The reporting session re-pressed the same twelve buttons by hand to recover what the tool had just computed and discarded. And since a replay is *for* the moment after a deploy, and a deploy is exactly when the build has legitimately changed, "refuse whenever the build differs" refuses always: the feature could not meet its own acceptance line.
- **Fixed both ways.** Derived Python artifacts (`__pycache__/`, `*.pyc`, `*.pyo`) are excluded from the fingerprint, and the comparison is now always computed and always reported.
- **The exclusion had to be applied remotely too**, and that is load-bearing rather than tidy: Python writes `__pycache__` on the Deck at import time, so skipping it locally while still hashing it over SSH would have produced a `deck_checkReady` build mismatch that no redeploy could ever clear. `remoteHashCommand`'s `find` prunes the same set.
- **`ok` deliberately did not change.** It still requires the build to match AND no landing to differ, so anything keying on it behaves exactly as before; the summary now says plainly that a difference may be the change you just made rather than a regression. Labelling uncertainty rather than withholding the measurement is the same call `deck_checkReady` makes when it reports `unknown` instead of refusing to answer.
- **Proven on the Deck 2026-09-26** (bonsAI plan 70 flow 0): a 31-step saved walk replayed against a newer build, ran to the end with no refusal, zero differing landings.
- **Not changed:** `deck_deploy` still *ships* `__pycache__` to the Deck (`copyEntry` copies directories wholesale). Harmless — Python regenerates bytecode when the source is newer — but it is wasted transfer, and worth cleaning up the next time the deploy manifest is touched.

### Fixed 2026-09-08

> **Reported by the bonsAI plan-64 session, 2026-09-23 (not measured here).** `deck_checkReady`'s
> build-match check **passed against a real Deck for the first time** — the first device confirmation
> of the unified fingerprint below, whose remote half (`deck/buildHash.ts`, hashing the deployed tree
> over SSH) had until then only ever been exercised at the desk or seen reporting a mismatch. Same
> session: `deck_holdAwake` held for a full 480-minute lease, read back as `sleep 28800`.

**`deck_holdAwake` held nothing, and its restore changed the Deck** · ★★★ (opened on the plan-09 phase-2 device pass, rebuilt and verified 2026-09-08)
- **Problem:** the tool reported `ok: true`, "screen/suspend timeouts disabled" and `restored: true`, and controlled nothing. `xset q` on this Deck's Xwayland answers *"Server does not have the DPMS Extension"*, so that half was a no-op on every call, and Game Mode sleep is not governed by logind's idle action, so `IdleActionSec` was the wrong knob even when written successfully. Both reads also collapsed "could not read" into `0` — which is *also* the value meaning "disabled" — so an **absent** `IdleActionSec` was recorded as `previous: 0` and the restore wrote back an explicit `IdleActionSec=0` that was never removed. It reported success while leaving the machine changed.
- **Replaced, not patched.** `deck_holdAwake` now holds a systemd-logind **block-mode `sleep` inhibitor** and `deck_restorePowerSettings` releases it. Steam suspends *through* logind (`SteamClient.System.SuspendPC()`), so the lock refuses it outright — Steam logs the refusal itself: `Error org.freedesktop.DBus.Error.AccessDenied: Access denied due to active block inhibitor`.
- **Why that retires the bug class rather than fixing an instance of it:** an inhibitor is a *lease*. Nothing is read and nothing is written, so there is no previous value to capture, no file to restore, and no "absent versus 0" to get wrong. Every failure falls toward the safe state on its own — the unit dies, the host crashes, or the TTL lapses, and the Deck sleeps again. The snapshot state machine is gone from this feature entirely (`settingsSnapshot.ts` still uses `snapshotLease.ts`, which is the right tool for something that genuinely does have old values to put back).
- **The hold is verified, not asserted** — the actual repair for what made v1 dishonest. `systemd-inhibit --list` is read back and the matching line is returned as `evidence`; `held: true` means a lock was *seen*. When the lock does not appear the tool reports `ok: false` and says the Deck can still sleep, rather than claiming a hold it never took. The release is symmetrical: a lock still listed after the stop is a failure, because a Deck that cannot sleep is a battery problem somebody needs to hear about.
- **The detail the whole thing turns on:** the lock is taken with `systemd-run --unit=`, in **system scope**. SteamOS sets `KillUserProcesses=True`, so anything started from an SSH session dies with that session — including a `setsid`-detached process, which escapes the controlling terminal but not the systemd session scope. The first spike run did exactly that, the lock was already dead when the suspend arrived, the Deck slept, and it read as a clean negative. A unit test pins this so it cannot regress to a background process.
- **A v1 run file left on disk is reported and cleared, and its values are deliberately NOT pushed back:** v1 recorded an absent `IdleActionSec` as `0`, so replaying its snapshot is precisely how Decks ended up carrying an `IdleActionSec=0` they never had. The warning names `/etc/systemd/logind.conf` so a human can check.
- **Verified on the Deck 2026-09-08**, end to end: `deck_holdAwake` returned `held: true` with the real lock line quoted; `SuspendPC()` was then called and the Deck stayed up, with Steam logging the refusal; `deck_restorePowerSettings` reported `released: true`; a second release was a clean no-op (`wasHeld: false`); and the Deck came back to exactly its four stock inhibitors with `logind.conf` untouched. 21 unit tests, 390 in the suite.

**Six tools still claimed `fidelity: "steam-routed"` from a press count** · ★★ (opened by lane 6, 2026-09-07)
- **Problem:** lane 6 made `deck_pressButton` honest, and six callers kept the lie one level up. `assertFocusMove.ts`, `walkTo.ts`, `sweep.ts`, `openPlugin.ts`, `runSequence.ts` and `gameSession.ts` each hardcoded `fidelity: "steam-routed"` from `presses > 0` — or, in `runSequence`'s case, from `results.some(r => r.ok)`, which let a single passing step license the claim for every other step in the run. None read the field `pressButton` had started returning, so a whole sweep reported `steam-routed` down a physically dead wire exactly as a single press used to.
- **The worst of them was the leaf.** `assertFocusMove` computes `moved` from its own before/after focus reads and then returned `"steam-routed"` on *every* path — including the branch whose own diagnosis reads *"press routed, focus did not move"*. It asserted routing while its own evidence denied it, and `walkTo`, `sweep` and `runSequence` all inherited through it.
- **Fixed by** one shared module, `deck/fidelity.ts`, rather than six local folds — the same mistake that produced two incompatible build hashes a day earlier. `weakestFidelity()` reports the weakest claim any press in a run earned, because a run is exactly as trustworthy as its least-verified press: nineteen presses that moved focus establish nothing about a twentieth that did not, and the twentieth is the one worth knowing about.
- **Most of them earn it for free.** `assertFocusMove` and `walkTo` already read focus either side of every press for their own reasons (a settle check and a stall check), so the evidence `verify: true` pays a CDP round trip for was already on the table — `earnedFidelity(moved)` just stops throwing it away. `sweep` and `runSequence` fold what `assertFocusMove` now returns. `openPlugin` and `gameSession` never check focus per press, so they use `confirmedFidelity()` on the end state instead: an open plugin panel, or an app id that has appeared in Steam's own `RunningApps`, is not reachable by presses that never got to Steam, so a confirmed one earns the stronger value honestly and an unconfirmed run reports the floor.
- **Pinned by 11 new tests** (379 total). The strongest is in `walkTo.test.ts`: its fake press reports `steam-routed` at the wire while one press in the walk moves nothing, and the walk must report `wire-sent` — which passes only if `walkTo` earns the value from its own reads rather than passing `pressButton`'s through.
- **Verified on the Deck, 2026-09-08**, with the bridge board's Deck-side USB lead physically unplugged and the board still enumerated on COM7 -- the one condition that makes this bug reproducible. Same `deck_walkTo` call either side of the disconnect: lead in, 4 presses, every one moved focus, `steam-routed`; lead out, 3 presses, none moved, **`wire-sent`** and `stalled: true`. `deck_runSequence` and `deck_sweep` both reported `wire-sent` down the dead wire, a plain `deck_pressButton` reported `wire-sent` while the board still acked (`{"ok":true,"t":"press"...}` -- the ack is real, the routing is not), and `verify: true` refused outright, naming the fault: *"Check that the board's USB lead is plugged into the Deck, not just this PC."* Reconnecting restored `steam-routed` on the identical call. `deck_openPlugin` and `deck_gameSession` were not exercised (the first needs a plugin workspace to run from, the second would launch a game on a live consumer Deck), so their `confirmedFidelity` path remains unit-tested only.

**Two different "build hash" implementations, both called the build hash** · ★★ (found in the plan 09 merge review)
- **Problem:** lanes 2 and 3 each needed to fingerprint "the files `deck_deploy` would ship", and each built its own. `deck/buildHash.ts` (lane 2) hashed every file, then hashed the sorted `path:sha256` lines; `checks/buildHash.ts` (lane 3) hashed `rel\0content\0` concatenated in one pass. Both read the same `listDeploySources()` manifest and **both were correct** — they simply produced different values for the same tree. Measured on `example-plugin`: `sha256:2f4ef12a…` against `b70fcb14…`. So `deck_checkReady` reported "the deployed build matches" against one number while `deck_saveCheck` stamped the other into a check file, and those two facts — at their most useful together — could not be compared at all.
- **Kept lane 2's, for a structural reason rather than a stylistic one.** Its two-stage shape is the only one that can also be computed *on the Deck*, where `sha256sum` hands back one digest per file and nothing can stream every file's bytes through a single hasher without shipping a script. Lane 3's one-pass stream could never answer "is the build on the Deck the one on my PC", so unifying the other way would have cost the remote comparison outright. `checks/buildHash.ts` is now a thin adapter over `deck/buildHash.ts`, keeping the two things worth keeping from its own side: the `sha256:` prefix, so a value sitting in a check file says what it is, and the input list, so a post-mortem can say what was fingerprinted.
- **The migration is the part that made this a decision and not a cleanup.** The number a check file stores changed, so `CHECK_FORMAT_VERSION` went 1 → 2 in the same commit, and a version 1 file is now refused by name with advice to re-save it. The alternative was a saved check reporting a build mismatch for a build that never changed — precisely the false alarm the fingerprint exists to prevent.
- **Preserved rather than dropped:** lane 3's hash tolerated an entry that vanished between listing and hashing, where lane 2's threw. That tolerance moved into `listFiles()`, because `checkRunner` fingerprints through it from two unguarded call sites.
- **Not done here:** lane 2 keeps per-file digests, so a replay could name *which* file drifted. Today a mismatch still only says "different build".

### Fixed 2026-09-07 (plan 09 — eight parallel lanes)

> **Phase-2 device pass, 2026-09-08.** Verified on hardware: `bridgePortOpen`, `wire-sent` vs an
> earned `steam-routed`, the shared CDP tunnel (one ssh process across 8 reads, ~4.2x, and a
> **real** killed tunnel detected and rebuilt in 408 ms), the image content block resolving from a
> **packaged** build with no source-tree fallback, `deck_checkReady` reporting `unknown` rather
> than passing, and a save/replay round trip that ignored genuinely different press counts and
> durations, and **lane 6's dead-path repro on 2026-09-08** (the Deck-side lead unplugged by hand:
> every press tool reported `wire-sent`, and `verify: true` named the unplugged lead). Not verified: lane 5's
> chip-strip walk (could not reproduce the container in the state the Deck was in) and lane 5's
> deploy chown (not run — it restarts the loader on a live consumer Deck). Lane 1 **failed** and was
> rebuilt the next day: see *`deck_holdAwake` held nothing* under [Fixed 2026-09-08](#fixed-2026-09-08).

Landed 2026-09-07 desk-verified; the device pass above followed the next day. Plan:
[09-parallel-feature-session.md](planning/09-parallel-feature-session.md).

**`bridgeReady` and `fidelity: "steam-routed"` both reported success down a dead path** · ★★★ (lane 6)
- Fixed by `bridgePortOpen` (honest name; `bridgeReady` kept as a deprecated alias because bonsAI reads it) and by making `"steam-routed"` unreachable except through the new opt-in `verify: true`, which reads focus before and after a real press. An unverified press reports `"wire-sent"` — the firmware acked, and nothing more. `preview_start` had the same one-line disease and now checks the URL answers. Its device repro — unplug the board's Deck-side lead — was done on 2026-09-08 (above).
- Also found: the lane brief assumed the extension's status bar and tree view display bridge state. They do not — nothing in `extension/` reads `bridgeReady`/`bridgePort`/`bridgeReason` today. No extension change was needed.

**Every CDP read opened and tore down its own SSH tunnel** · ★★ (lane 7)
- One tunnel, opened lazily and shared for the process lifetime; `close()` became a no-op so no call site changed. 2.6x at 8 reads, 3.1x at 20, against the faked layer at real costs. Dead-tunnel rebuild, single-creation-under-race, IP change, shutdown and killswitch teardown all handled explicitly. Residual: a Deck that sleeps without resetting TCP leaves ssh believing the link is fine for up to ~30 s.

**`deck_runSequence` crashed on a malformed step** · ★ (lane 5)
- Steps validated before the run starts — ahead of the killswitch check and the tunnel — with the step index and offending field named.

**Deploy re-owned pre-existing plugin content, and the restart message cried wolf** · ★ (lane 5)
- Chown scoped to the staged manifest entries; the doomed user-scope restart attempt removed so a successful restart stops printing a failure. A real failure reports exactly as before.

**`deck_walkTo` called a legitimate stay-put a stall** · ★★ (lane 5)
- A change in the focused element's accessible name now counts as movement even when the DOM node does not, via the existing shared resolver.

**`npm test` failed on a clean checkout** · (merge)
- The test script now runs `copy-scripts.mjs`, not just `tsc`. Four of eight lanes independently lost time to this.

### Fixed 2026-09-02

**Capture scripts directory never resolved** · ★★ · [#2](https://github.com/qd313/decky-plugin-studio/issues/2) — the GitHub issue is still open and can be closed
- **Problem:** `deck_captureScreenshot` and `deck_installCaptureHelper` both failed immediately with a malformed path (`\c:\Users\...`) — a POSIX-style path join applied to a Windows drive letter, so the lookup could never succeed. The same broken candidate was even printed twice.
- **Fix:** replaced the manual path handling with `fileURLToPath` in both places (capture scripts and the reverse-tunnel script), deduplicated the candidate list, and added a `DECKY_STUDIO_REPO`-based fallback to `templates/scripts` that doesn't depend on install location. A packaged-build resolution check was added by plan 09 lane 8 and verified on the Deck 2026-09-08.

**`deck_openPlugin` needed 2–3 attempts after `deck_deploy`** · ★★ · [#3](https://github.com/qd313/decky-plugin-studio/issues/3) — **not fixed; see Open bugs.** The entry stays here as the record of the first attempt.
- **Problem:** reproduced on 5/5 deploy-then-open cycles. Attempt 1 failed because the QAM's CEF debug targets aren't enumerable yet right after a loader restart. Attempt 2 then fired the open/close chord blind — since it's a toggle, hitting it against an already-open QAM closed it instead.
- **What was done:** retry target enumeration briefly instead of failing immediately, and only fire the chord when the tool can see the QAM isn't already showing (rather than firing unconditionally). `deck_deploy` / `deck_reloadPlugin` now also wait (up to 30s) for the loader to actually come back before returning. On the Deck the first try kept failing after a reload (2026-09-26 onward); three more fixes followed in October.

### Fixed 2026-08-28

**Every bridge command paid 2.5s of dead wait** · ★
- **Problem:** a `status` command that moves nothing was taking 3287ms. The code waited up to 2.5s for a `"ready"` line that a non-reset board (DTR/RTS deliberately held low) was never going to send.
- **Fix:** `open_port` now sends a `status` ping and treats any answer as proof the board is alive, falling back to the old wait only if nothing answers. `drain()` now stops as soon as it sees the expected marker instead of waiting a fixed window.
- **Result:** status calls dropped from 3287ms to 256ms, presses from ~3.8s to ~386ms.

**`deck_deploy` shipped an unreadable plugin (root-only file modes)** · ★★★
- **Problem:** files deployed from a Windows host landed as `drwx------ root:root`, so Decky's unprivileged plugin process couldn't even import its own backend — `ModuleNotFoundError` on every start. The frontend still rendered fine (served as root), so it looked like a settings bug, not a permissions bug, and cost several wasted loader restarts to trace.
- **Cause:** Windows OpenSSH reports directories with mode 0700, `scp -r` preserves that verbatim, and the deploy's `sudo cp -a` copied it straight through.
- **Fix:** normalize permissions (`chmod -R u+rwX,go+rX`) on the local staging directory right before the copy, not on the live target — chmod-ing the target would also re-permission pre-existing content like bonsAI's `data/`.

**`deck_openPlugin` claimed `alreadyOpen: true` when the plugin wasn't even mounted** · ★★
- **Problem:** after a loader restart closes the panel, the tool would still report the plugin as already open — the ring was actually sitting on a header button in the Decky list pane, not inside the plugin.
- **Cause:** "already open" was decided by checking whether the plugin's name appeared anywhere in the pane's labels — but the Decky list pane advertises every installed plugin's name too, so it couldn't tell "this plugin is open" from "this plugin is listed."
- **Fix:** added an optional `rootSelector` input (a CSS selector the plugin's own panel renders) that decides already-open directly and authoritatively. Without one, the label check now also requires Decky's own pane title to be *absent* — an open plugin panel replaces that title with the plugin's name.

**`deck_openPlugin` couldn't recover when the ring was on the QAM's left rail** · ★
- **Problem:** with the Decky pane already showing and focus sitting on the QAM's icon rail, the tool gave up after 2 presses when a single RIGHT press would have entered the pane — the normal state right after a game launches.
- **Cause:** one guard conflated "the right pane is visible" with "the ring is inside it," so the whole navigation block (including the needed RIGHT press) was skipped whenever the pane was already showing.
- **Fix:** split the check so each navigation step keys on its own actual precondition, instead of one shared guard doing two jobs.

**`deck_walkTo` / `deck_readFocus` ignored an element's own `aria-label`** · ★★
- **Problem, in increasing severity:** (1) walking to an icon-only button by its own label returned `found: false` even after landing exactly on it. (2) On a tab strip, the reported "owner text" came back as the entire contents of the tab, not the tab's own name — misleading, not just wrong. (3) Worst case: `walkTo` reported `found: true` after **zero presses**, because the ring hadn't moved at all but its surrounding text happened to contain the search term — a false success with no signal anything went wrong.
- **Cause:** name-matching walked up the DOM tree for *any* text rather than checking the element's own `aria-label` first, and could climb all the way up to a giant container.
- **Fix:** added one shared "accessible name" resolver, used everywhere focus is matched — checks the element's own `aria-label`, then `aria-labelledby`, then a labeled descendant, then its own text, and only then an ancestor's label/text (capped at 80 characters; past that it's treated as a container and reported as `labelOverflow: true` rather than returned as a name).

### Fixed 2026-08-27

**`deck_deploy` deleted plugin data the deploy set doesn't ship** · ★ · regression, caught before shipping
- **Problem:** the elevated deploy step did `sudo rm -rf <target>` before copying in the new files — but the deploy only copies a fixed file list (`dist`, `main.py`, `plugin.json`, etc.) that doesn't include `data/`, where bonsAI keeps seed content. The first real deploy would have silently destroyed it.
- **Fix:** replaced the delete-then-copy with a merge (`sudo mkdir -p && sudo cp -a .../. target/`), matching what plain `scp -r` always did. Trade-off: a file removed from the plugin source is no longer cleaned up on deploy — accepted, since a stale file is visible and fixable, unlike deleted data.

**`sudo rm -rf` was reachable from an unvalidated `plugin.json` field** · ★ · caught at review, never shipped
- **Problem:** the same deploy rewrite dropped whitespace-collapsing from the plugin-name derivation without replacing it with real validation, so a blank or space-containing `name` field could target the wrong path or inject shell punctuation into a root-privileged `rm -rf` run over SSH.
- **Fix:** plugin names are now restricted to `[A-Za-z0-9._-]+` (rejecting `.` / `..`) before any command is built, remote paths are quoted, and the parent directory is spelled out literally rather than computed with a shell substitution that could run on the wrong host.

**`deck_status` didn't report bridge health** · ★
- **Problem:** `deck_status` reported tunnel / ingest / Deck / Ollama health but not whether the bridge board's COM port could even open — so an unplugged board wasn't caught until the first press failed mid-run.
- **Fix:** added `bridgeReady` / `bridgePort` / `bridgeReason`, probed with the bridge's own read-only `status` command.
- **Correction made on hardware:** the first timeout (3000ms) was too short — a healthy board measures 3312ms to answer (Python startup plus the ESP32's DTR-triggered auto-reset), so real boards were reporting `bridgeReady: false`. Timeout raised to 10s; a missing board still fails fast since opening an absent port errors immediately.

**`deck_openPlugin` failed when the panel was already open** · ★
- **Problem:** with the plugin already on screen and focus inside it, the tool searched for the plugin's entry in the Decky list — looking for it from inside it — and reported failure.
- **Fix, in two parts found only once tested on hardware:** (1) the tool refused before reaching the already-open check whenever nothing owned the focus ring — the normal resting state right after this tool is called — so it now acquires focus first if unowned. (2) the "already open" text match was a substring check that both missed real cases and matched unrelated text (like a suggestion chip that happened to contain the plugin's name); it's now a whole-label, case-insensitive match against the pane's actual labels.

**`deck_waitFor` reported satisfied/unsatisfied backwards** · ★
- **Problem:** seen twice — a `null` value (not truthy) was reported `satisfied: true`, and later a populated object was reported `satisfied: false` (timeout) with that same object sitting right there as the "final" value.
- **Why it mattered:** this is the reply-finished check for every Ask macro — a wait that lies in both directions is exactly the false-instrument class this toolset exists to prevent.
- **Cause:** the code decided whether to do exact-match comparison by checking whether an `equals` *key* was present in the options object — but the caller always builds that key (valued `undefined` when unset), so every real call was silently pinned to comparing against the string `"null"`.
- **Fix:** one-line fix (`!== undefined` instead of a key-presence check), plus 6 regression tests. Verified on hardware across all cases.

**`deck_runSequence` couldn't start from an unowned focus ring** · ★
- **Problem:** it refused with "could not read focus before the run started" whenever nothing currently owned the ring — which is the normal state after every plugin open and every finished Ask.
- **Fix:** extracted `walkTo`'s existing `acquireFocus` handling into a shared helper and gave `runSequence` the same option, defaulted on.
- **Note:** verified working through `deck_openPlugin`; the specific unowned-ring-at-start scenario for `runSequence` itself couldn't be reproduced live on hardware (the ring re-owns itself within a second or two), so that exact path is covered by unit tests only.

**`deck_deploy` guessed the plugin directory and got the case wrong** · ★
- **Problem:** deploy failed against `~/homebrew/plugins/bonsAI/` because the tool lower-cased the target name instead of reading it from `plugin.json`, and separately couldn't write into the root-owned install directory anyway — neither problem was reported clearly.
- **Fix:** local copies still lower-case, but the *remote* target name now comes verbatim from the manifest; the deploy stages into a writable temp dir first, then moves it into place with one elevated command; permission failures now name the target, the actual problem, and the fix.

**The build never copied capture scripts into `dist`** · ★
- **Note:** the build already did copy them — the real bug was that script-directory resolution (`getScriptsDir()`) was hardcoded relative to the compiled file's location, so it broke specifically when running from source (`npm run dev` / `tsx`), which is exactly the setup this repo's own docs point consumers toward.
- **Fix:** resolution now tries the built location, then the server package's `dist` folder, then a repo-root fallback, and reports every path it tried if all three fail. Added smoke tests for both layouts.

**`deck_getEnv` hung on an unreachable `DECK_IP`** · ★
- **Problem:** with a wrong IP configured, the tool never returned — measured over 40s, versus the 1s deadline used elsewhere in the same call.
- **Cause:** the remote probe made SSH calls with no timeout.
- **Fix:** added a shared 4s deadline; a timeout now reports `remote: { unreachable: true, reason: ... }` instead of hanging. Verified on hardware: a bogus IP now returns in 5s with the timeout reported as a finding.

**Deck automation killswitch** · ★★ · shipped
- **Why:** on 2026-08-26, a host that was "alive, confident, and wrong" left the focus ring one press away from launching a game, with no way to stop it but noticing by hand.
- **Design:** a file-based latch (`~/.config/decky-plugin-studio/automation-stop.json`), not an in-memory flag — the extension's server process and an agent's own MCP server process are two separate processes that share no memory, so a flag in the wrong process wouldn't help. A file also survives a server restart.
- **Sequence on stop:** set the latch first (one synchronous write), then release the board, then tear down tunnels — in that order so nothing can sneak in a press between the release and the latch.
- **Re-arming is deliberately not exposed as a tool** — it lives on a route the MCP handler has no path to, verified by hitting it and getting `Unknown method`. An agent can't clear its own killswitch.
- **Reachable four ways:** a dedicated status bar item, the **Decky: Stop All Deck Automation** command, `ctrl+alt+.`, and `pnpm stop`.
- **Found and fixed alongside:** the VSIX never bundled `bridge/tools/`, so the killswitch (and `deck_pressButton` / `deck_openPlugin` generally) had never actually worked from an installed extension.

### Fixed 2026-08-26 (VS Code extension packaging)

**Installed extension was inert — bundled MCP server could never start** · ★★
- **Problem:** the VSIX packaging script copied the MCP server's compiled code but not its `package.json` or `node_modules` — so every Studio tool was dead in any *installed* build (it only ever worked from a source checkout), and the failure was silent: a dead server just let `initialize` hang for a full 2 minutes.
- **Fix:** bundle the manifest and run `npm install --omit=dev` (VSIX grew 18.3→25.5MB). Process exit/error now reject in-flight requests immediately, stderr goes to a dedicated output channel, and status is now `starting` / `running` / `failed` instead of just up/down.
- **Also fixed:** the status bar was reading "server is down" as "Deck is offline," sending users to check their network for a problem that was actually in the extension. It now says `Decky (server failed)` and links to the log.
- **Guard added:** a packaging-time smoke test that actually starts the bundled server and requires it to answer `initialize`.

**VS Code settings were read by nothing** · ★
- **Problem:** `deckIp`, `deckUser`, `ingestPort`, `previewHttpAllow`, `localLoaderUnit` had existed in the extension manifest since 0.1.0, but nothing in the code ever called `getConfiguration` — the server only read `~/.config/decky-plugin-studio/deck.env`. Typing a Deck IP into VS Code settings did nothing, silently.
- **Fix:** `deckIp` / `deckUser` / `ingestPort` now flow to the server as environment variables at spawn, layered over the env file (blank values don't override a working file). `previewHttpAllow` and `localLoaderUnit` are still unread — lower priority, not yet reported by anyone.

**Status bar was a one-shot snapshot** · ★
- **Problem:** the status bar only refreshed once, at activation — starting a tunnel or waking the Deck never updated it, and the only fix was manually running the refresh command.
- **Fix:** now polls `deck_status` every 30s (a 1s-deadline ping plus one local HTTP probe — cheap enough to repeat, slow enough not to spawn a flood of subprocesses).

**Status bar was missing in VS Code** · ★
- **Problem:** reported as "status bar shows in Cursor but not VS Code."
- **Cause:** the extension was never actually installed in VS Code — Cursor and VS Code keep separate extension directories, and only Cursor had it. The status bar code itself was fine.
- **Fix:** rebuilt and installed a fresh VSIX. Two latent bugs found and fixed at the same time (same symptom, no trace either way): the status item had no `id` / `name`, so a user who hid it couldn't find it again in the manage menu; and the status text was one long unbroken string that VS Code silently drops when it doesn't fit a narrow bar. Text is now a short `Decky ●●●` badge with full detail in a (unlimited-width) tooltip.

---

## Shipped in 0.3.11 (installed 2026-10-06, not released)

Version pins moved on 2026-10-06 for a local VS Code install only; no tag, no GitHub Release. The
VSIX built that day is the newest packaged build, so **none of the fixes from 2026-10-08 to
2026-10-22 is in any packaged extension**; bonsAI runs the server from this repo's `mcp-server/dist`,
rebuilt 2026-10-22. `CHANGELOG.md` `[Unreleased]` carries the entries up to 2026-10-08 and none after.

- **Drive several Decks at once** (plan 10): `machines.json`, `machine` on every `deck_*` tool, `deck_listMachines`, `deck_releaseMachine`, every result stamped `machine: { name, kind, os }`, `machineKind` in `deck_checkReady`
- **Only one driver per machine**: the lease at the dispatch seam; `deck_status` stays off a leased serial port
- **A virtual gamepad for stand-ins**: `bridge/tools/vpad.py` (uinput on Linux, ViGEm on Windows), the per-machine killswitch, the status-bar controller state
- **LT and RT** on the board and the virtual pads (2026-10-08)
- **The visibility sampler reads where the words are** (2026-10-03)
- 57 registered tools; 493 tests in `mcp-server`

## Shipped in v0.3.x (autonomy pack)

- **Deck automation killswitch** — `deck_stopAutomation` / `deck_automationStatus`, a status bar stop button, `ctrl+alt+.`, and `pnpm stop`; file-based latch so a stop crosses process boundaries, human-only re-arm
- **deck.reloadPlugin**, **deck.openPlugin** (a checklist in v0.3.3; drives the Deck itself since v0.3.9, with `drive: false` for the checklist), **deck.readPluginLog**, **deck.getEnv**
- **The controller bridge and the focus tools** (v0.3.9–0.3.10): `deck_pressButton`, `deck_pressChord`, `deck_readFocus`, `deck_walkTo`, `deck_assertFocusMove`, `deck_runSequence`, `deck_sweep`, `deck_waitFor`, `deck_readPage`; the visibility oracle; `deck_launchGame` / `deck_exitGame`
- **Run hygiene** (v0.3.10, plan 09): `deck_holdAwake` / `deck_restorePowerSettings`, `deck_snapshotSettings` / `deck_restoreSettings`, `deck_checkReady`, `deck_saveCheck` / `deck_replayChecks`; screenshots as `image` content blocks; lint rules R13 and R14
- **plugin.diffRpc** — frontend/backend RPC parity
- **preview.compareScreenshot** + `tests/preview-baselines/`
- **Streaming RPC (experimental)** — sidecar `decky.emit` → WS + **preview.tailEmit** / `collectEmitsMs`
- Pack skills: **decky-onboard**, **decky-release**, **decky-focus-audit**; agent **decky-focus-architect**
- Hooks: build parity, RPC drift hint, handoff check

## Shipped in v0.2.0

- Dynamic preview RPC discovery (`.decky/preview.json`)
- Unified deploy copy manifest + SSH retry
- Generic preview test kit + `preview.callTestHook` / `preview.health`
- Permission simulator, richer UI shims, hardened screenshot MCP
- Vitest harness template, dev-loop / tier-qa skills
