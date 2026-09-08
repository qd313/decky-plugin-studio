# Decky Plugin Studio — roadmap (deferred)

Star ratings follow bonsAI [roadmap](https://github.com/cantcurecancer/bonsAI) legend (effort/risk, 1 = lowest).

- [Deferred / shelved](#deferred--shelved) — out of scope for now, with reasons
- [In progress](#in-progress) — partially shipped
- [Session plan](#session-plan) — the eight parallel lanes next, and the solo order after them
- [Planned features](#planned-features) — not yet built
- [Open bugs](#open-bugs) — known issues, not yet fixed
- [Fixed bugs](#fixed-bugs) — grouped by fix date, newest first
- [Shipped releases](#shipped-in-v03x-autonomy-pack) — v0.3.x and v0.2.0

---

## Deferred / shelved

### Native Steam Input / HID bridge in preview
★★★★★★ · Deferred
- **What:** Full native gamepad/HID input simulation inside the in-IDE preview.
- **Why deferred:** The preview only supports the W3C Gamepad API. See PREVIEW_LIMITATIONS.

### Gamescope / QAM compositing in preview
★★★★★★ · Deferred
- **What:** Simulate Steam's Gamescope/QAM compositor inside the preview.
- **Why deferred:** Would require capturing CEF/Chrome rendering.

### Deck UI automation (`deck.openPlugin`, hard mode)
★★★★ · Deferred
- **What:** Fully automated navigation to open a plugin from anywhere in the Steam UI.
- **Status:** v1 only returns a checklist for a human to follow.

### Auto `.env` → `config.ts` on deploy
★★★ · Plugin-specific
- **What:** Automatically generate `config.ts` from `.env` on deploy.
- **Note:** Use `.decky/preview.json`'s `preDeployCommand` instead — this is specific to each plugin, not something Studio should own generically.

### Pixel-perfect `@decky/ui` mocks
★★★★ · Partial
- **What:** Preview UI shims that visually match real Decky components exactly.
- **Status:** v0.2 shipped richer shims, but on-device QA is still required for anything visual.

### Parallel VM QA farm for bonsAI
★★★★★★ · Shelved 2026-09-05
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
★★ · Parts A + B shipped 2026-08-31 — fail-by-default flip still pending
- **Why it exists:** every focus tool could answer "where is the ring?" but none could answer "can a person actually see it?" Proven twice in two days on bonsAI: a control focused behind a bottom-pinned dock passed every automated check (`walkTo`, `runSequence`, `readFocus`), and a human found the problem in 30 seconds of free play.
- **What shipped:**
  - A `visibility` verdict (visible/partial/covered/offscreen + percent + covering selector) on every focus read.
  - A `stopsFocusedButNotVisible` counter and `requireVisible` option on `runSequence` (report-only for now).
  - `deck_sweep`: spams D-pad direction presses only (never A/B) across a pane, recording label/rect/scroll/visibility at every stop into a diffable `runs/` report.
- **Verification:** matched a manual `elementFromPoint` probe exactly on bonsAI's Main tab. Two corrections made along the way: the visibility sample inset needed to be a quarter of the short side (2–12px), not a flat 2px, or visible rounded-corner buttons misread as `partial`; and the sweep needed the COM7 press-retry fix below, or it died around press 10–22.
- **First real finding:** the sweep's first run found 4 chips that are focused but not visible (expected was 0), reproduced byte-for-byte across two runs. Reported to bonsAI as a consumer bug.
- **Honest limit:** this is a DOM hit-test, not real eyes — wrong colors or compositing artifacts still need screenshots or a human. It only guarantees that focused-but-occluded and focused-but-offscreen can't pass silently anymore.
- **Full design:** [06-visibility-oracle-and-free-play-sweep.md](planning/06-visibility-oracle-and-free-play-sweep.md)

---

## Session plan

Written 2026-09-07. Work splits into two shapes, and the dividing line is hardware, not
difficulty: there is one Deck, one bridge board, one COM port and one focus ring. Anything
whose risk lives at the desk can run in parallel. Anything whose hard part is "what does this
particular hardware actually do" is an experiment before it is a feature, and runs alone.

The split is not theoretical. Almost every serious bug in [Fixed bugs](#fixed-bugs) passed its
unit tests and was caught on device anyway — the bridge status timeout set to 3000ms when a
healthy board answers in 3312ms, the visibility inset that had to become a quarter of the short
side, two `deck_openPlugin` fixes "found only once tested on hardware," and a keydown intercept
that was "dead code on hardware and alive under vitest, which is the recurrence engine."

### Next: parallel feature session — eight lanes

Each lane is one subagent in its own worktree. Lanes are grouped by which files they own, so
they do not collide. Every lane is chosen because it can be *proven* at the desk; the Deck is
the bottleneck, so nothing that needs it goes here.

**Full plan, with the verbatim lane prompts:** [09-parallel-feature-session.md](planning/09-parallel-feature-session.md)

| Lane | What it covers | Device time |
|------|----------------|-------------|
| **L1 — Put the Deck back** | *Hold the Deck awake* + *Save and restore the plugin's settings*. One lane on purpose: they are the same state machine (snapshot, write the run file immediately, refuse a second snapshot while one is unrestored, restore safe to call twice, auto-expire toward "sleeps again"). Two lanes would build it twice and drift. | ~30 min |
| **L2 — Don't start blind** | *Check the Deck is ready before a run starts.* Composes existing readers, does not refactor them. | ~15 min |
| **L3 — Pin a check, replay it** | *Save a passing check and replay it after every deploy.* File format plus a diff loop; sweep reports already reproduce byte-for-byte. | ~20 min |
| **L4 — Make the preview lie less** | *Make the preview behave more like Steam* — the two lint rules plus dropping DOM keydown for D-pad. Highest value per star on the board: the rules alone are ★ and would have caught both multi-fix recurring bugs before deploy. | **none** |
| **L5 — Three small honest fixes** | *`deck_runSequence` crashes on a malformed step*, *deploy re-owns content / loader cries wolf*, *`deck_walkTo` calls a stay-put a stall.* | ~20 min |
| **L6 — Say what you actually know** | *`bridgeReady` and `fidelity: "steam-routed"` report success down a dead path* — plus `preview_start`, which returns `running: true` without checking that anything is running. Same family, one line. | ~15 min |
| **L7 — One tunnel, not one per read** | *Every CDP read opens and tears down its own SSH tunnel.* Earns its slot twice: 2–3× on read-heavy runs, and every device session after it is shorter — including this plan's own. | ~10 min |
| **L8 — Let the model actually see** | Capture tools return an `image` content block, not just a file path, so any MCP client sees the pixels — plus a resolution test that runs against a *packaged* VSIX rather than a source tree. | ~10 min |

**Why L8 is not optional:** every `tools/call` today returns exactly one text block
(`index.ts`, the `tools/call` case), and there is no `image` content block anywhere in the
server. `deck_captureScreenshot` returns a path, so a model can only see the picture if it also
happens to own a file-reading tool pointed at the same machine — and nothing in the tool
description tells it to look. Two consequences: the pixels never reach an agent that is not
Claude Code, and *Measure colours inside a control* in the solo season below cannot meet its own
acceptance ("a number with a crop attached") until this lands. The resolution half is here
because this seam has broken three times — the build not copying capture scripts into `dist`,
the Windows drive-letter path join, and the VSIX not bundling `bridge/tools/` — and no test yet
proves resolution from a packaged build.

**L6's compatibility call:** add `bridgePortOpen` and keep `bridgeReady` beside it as a
deprecated alias for one version, so bonsAI does not break on a rename. Do *not* alias the
`fidelity` value — an unverified press stops claiming `steam-routed` outright, because keeping
the lying value available is the whole thing being fixed.

**Out of this session:** *A self-check for DPS itself* was cut for capacity, not merit — it is ★,
needs no Deck and collides with nothing, so drop it into any later session with room. Preview
parity for agents running outside VS Code is deliberately not chased: the preview drive tools
need the extension's IPC bridge, and that work belongs with *One D-pad test, two runners*, which
needs the same headless preview anyway.

### Then: solo season, in this order

1. **Only one driver at a time.** First because it is cross-cutting — it would fight all eight
   lanes above — and because every solo session after it is safer for having it: a second chat
   session cannot sneak a press into someone else's run. It also root-fixes *the 30s status poll
   opens COM7*, which the eight lanes will still be living with. Build it as a guard at the
   dispatch seam in `index.ts`, not as an edit inside twenty tools.
2. **Sleep the Deck and wake it again.** An experiment before it is a feature — the deliverable
   of the first hour is "which wake method works on this Deck," not code. Try the wake alarm
   first: no hardware, ~10 minutes, and it is the safety net that makes a failed bridge-keyboard
   wake cost a minute instead of the session. Never sleep without a proven way back.
3. **Type text on the Deck.** Immediately after 2, because they share the bridge board's
   keyboard interface and the same "does the extra USB interface disturb Steam's view of the
   controller" check. Build that firmware once.
4. **Run the same check through every way into the plugin.** Five of the six paths exist today;
   this sits here so it ships with the suspend path from 2 rather than shipping twice.
5. **Find and launch games from the library, not the Recent shelf.** Needs a live Steam client
   to learn the `SharedJSContext` shape for installed titles and non-Steam shortcuts — not
   specifiable in advance, which is exactly why it is not a parallel lane.
6. **Measure colours inside a control.** Needs the capture helper working on device and
   thresholds tuned against real pixels. After 5, so a running game is available as a test
   surface — highlighted words are where the colour bugs actually live.
7. **Keep a log of every run automatically.** Last of the tool-shaped work: it wraps every
   `deck_*` tool, so it wants a tool set that has stopped moving. Same trick as 1 — build it at
   the dispatch seam, not inside each tool.
8. **Time a run the way a person sees it.** Wants the lease from 1 in place, or a foreign presser
   can pollute a timing run and the numbers lie again — which is the failure this feature exists
   to end.

Cheap enough to slot into any of the above with spare capacity: *A self-check for DPS itself* (★,
no Deck). Waiting on work above rather than on scheduling: *One D-pad test, two runners* (needs
L4), *Automated issue triage agent* (needs *Studio issue intake*), *Pluckable studio*.

### How this lands

Lane work happens in per-lane worktrees, then merges to `main` as **one squashed commit per
lane**, so a bad feature backs out with a single `git revert` instead of an archaeology session.
Three rules keep that safe:

- **No lane touches `ROADMAP.md`, `CHANGELOG.md`, `MCP_TOOLS.md` or `AGENTS.md`.** Those are
  written once at the end. Hand-resolved doc merges are a known recurring cost.
- **No version bump until after the on-device pass.** A push to `main` only triggers
  [build-vsix.yml](../.github/workflows/build-vsix.yml) when `extension/package.json` or
  `package.json` changes — and when it does, it auto-publishes a GitHub Release. Leaving the
  version alone is what makes landing unverified features on `main` harmless.
- **Every lane answers one question in its report:** what could this test pass while the real
  thing is broken? If the honest answer is "everything," the feature is marked device-unverified
  rather than counted as done.

---

## Planned features

### Hold the Deck awake for a test run, then put the setting back
> **Spike run on hardware 2026-09-08. The answer is yes: a logind block inhibitor stops Steam suspending this Deck.**
> v1 (plan 09, lane 1) shipped broken and is still broken on `main` — see
> [Open bugs](#deck_holdawake-does-not-hold-a-steam-deck-awake). What follows is the measured replacement.

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
- **Honest limit:** the spike drove `SuspendPC()` directly rather than waiting out the 60-minute idle timer. Both produce the identical logind message from the identical Steam process, so they are almost certainly the same path — but "almost certainly" is not "watched", and the first unattended run longer than an hour is what settles it.
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
> **Shipped 2026-09-07 (plan 09, lane 1) — desk-verified only, never run against a Deck.**

★★ · Planned — asked 2026-09-07
- **Problem:** every device session ends with someone putting the Deck back by hand — settings, pinned test questions, which tab was open. bonsAI's plan 31 lists what each round will change and restore, the plan 32 log ends with a paragraph doing it manually, and a `settings.json.bak-preQA` sits on the Deck because nothing tooled does this.
- **What to build:** two paired calls. One copies the plugin's settings directory (and optionally its data directory) over SSH into a run file. The other puts exactly that copy back. Refuse to take a new snapshot while an old one was never restored, and make the restore safe to call when nothing changed — the same safety rules as *Hold the Deck awake* above.
- **Also unlocks:** the "clean install" test rows bonsAI's plan 23 lists as permanently manual become partly mechanical.
- **Acceptance:** a device round that changes five settings and pins three test chips ends with the plugin's files byte-identical to the snapshot, with no hand edits.

### Check the Deck is ready before a run starts
> **Shipped 2026-09-07 (plan 09, lane 2) — desk-verified only, never run against a Deck.**

★★★ · Planned — asked 2026-09-07
- **Problem:** runs start blind. bonsAI's plan 23 names "is the Deck in the state I think it is" as the one bucket worth investing in, and the log shows why: a sleeping Deck, a stale build proven only by a manual `md5sum`, a foreign tunnel, a game running when none was expected, and a Steam dialog nobody knew was on screen. Each one costs a run plus the time to work out it wasn't the thing under test.
- **What to build:** one call that takes a declared state and returns the diff: awake, deployed build hash equals the local build, running game is X or none, plugin open on tab Y, no foreign CDP tunnel, nothing modal on screen, focus ring owned. Any mismatch fails the run at step zero with a named reason.
- **Cheap first half:** `deck_deploy` already knows every file it shipped, so "is the right build installed" is a hash compare and nothing more. bonsAI's own `build.ps1` already does this for 57 files.
- **Acceptance:** a run against a Deck that fell asleep, or that still has last night's build, stops before the first press and says which precondition failed.

### Save a passing check and replay it after every deploy
> **Shipped 2026-09-07 (plan 09, lane 3) — desk-verified only, never run against a Deck.**

★★ · Planned — asked 2026-09-07
- **Problem:** bonsAI reruns the same sweeps by hand after every build (plan 32: two regression sweeps at 03:50 on build 4), and its key metric is "bugs fixed more than once" — but nothing counts that. Its M4 milestone is exactly "a D-pad bug locked by a check that fails without the fix," reached once by hand.
- **What to build:** a way to save a `deck_runSequence` or `deck_sweep` result, with its expected landings, as a named check file in the consumer repo. A replay call reruns every saved check after a deploy and diffs against the saved result. Sweep reports already reproduce byte-for-byte across runs, so this is a file format plus a loop.
- **Acceptance:** after a deploy, one call replays every pinned check and names the ones whose landings changed.

### Run the same check through every way into the plugin
★★★ · Planned — asked 2026-09-07
- **Problem:** the same bug appears on one entry path and not another. bonsAI measured four fresh mounts, a QAM close-and-reopen, a chord reopen, a modal close, a loader restart and a suspend-and-resume, each landing focus somewhere different for the same bug (`6fb7104`, `1c7e6ac`, `d86b694`). The plan 32 sweeps were clean only because no game was running, so no words were highlighted — and the highlighted words were the trap (`4183f6f`).
- **What to build:** a tool that reaches the plugin by a named path (`fresh`, `qam-toggle`, `chord`, `modal-close`, `loader-restart`, later `suspend-resume`), plus an option on sweep and runSequence that repeats the check across every drivable path and reports each separately. A second axis for "game running / none" belongs here too.
- **Depends on:** *Sleep the Deck and wake it again* for the suspend path; the other paths exist today.
- **Acceptance:** one call runs a check five ways and reports per path, so "passes fresh, fails after loader restart" is a single line rather than a night's work.

### Only one driver at a time
★★★ · Planned — asked 2026-09-07
- **Problem:** bonsAI's plan 31 states it plainly: the bridge registers CDP tunnels but not presses, and has no lock, so "nobody is looking" does not mean "nobody is pressing." Two chat sessions drove the same Deck in one evening, one pinned chips the other had to restore, and every press batch starts with a manual check for a foreign tunnel.
- **What to build:** a lease with owner, purpose, expiry and heartbeat, held in a file on the host and on the device. Presses, deploys and reloads refuse without it, or when another live holder exists. The extension's 30 s status poll honours it too.
- **Fixes at the root:** the open *status poll opens COM7* bug below — the poll simply doesn't touch the port while a lease is held.
- **Acceptance:** a second session that tries to press while the first holds the lease gets a refusal naming the holder, and the status poll never opens the serial port during a leased run.

### Time a run the way a person sees it
★★★ · Planned — asked 2026-09-07
- **Problem:** speed checks that lie. bonsAI's newest commit (`fdfa91a`) is a budget probe that prints PASS at 23–38 ms while a real Ask on the same Deck, minutes apart, costs over a second for the same step — the probe warms itself inside one process, a real question pays every time. Its testing doc now says "ask a throwaway question before timing anything."
- **What to build:** wrap a sequence and a `deck_waitFor` with wall-clock stamps at each stage (press sent, first DOM change, first streamed token via the ingest tail, reply done), repeat N times cold and warm, and report the spread rather than one number. It measures only what the UI shows, so a warm in-process cache can't fool it.
- **Honest limit:** it can't see inside the backend. It answers "how long did the person wait," which is the number the budget is actually about.
- **Acceptance:** three consecutive Asks on the Deck report three separate durations with the per-stage split, and a probe-style false PASS is impossible by construction.

### Make the preview behave more like Steam
> **Partly shipped 2026-09-07 (plan 09, lane 4).** Lint rules R13 (D-pad via DOM `keydown`) and R14
> (cross-realm `instanceof Element`/`Node`) landed, and the preview shim now swallows direction keys on
> the capture phase so a `keydown` D-pad handler stops working there as it does on device. **Still open:**
> rendering the plugin in a separate frame, so cross-realm brand checks fail in the preview too — see
> `preview-server/src/sandbox-host.tsx`'s `mount()`, where the plugin currently shares a document with the shim.

★★★ · Planned — asked 2026-09-07
- **Problem:** fixes pass on the PC and do nothing on the Deck, repeatedly. The spoiler-fence keydown intercept was "dead code on hardware and alive under vitest, which is the recurrence engine" (`31423e7`) — Steam never dispatches DOM keyboard events into a plugin. The hidden-tab trap's `instanceof Element` check was false for every node because the QAM document is a different realm (`d86b694`), and jsdom shares realms so the test couldn't reproduce it.
- **What to build, in three parts:** (1) the preview stops sending DOM keydown for D-pad and fires only Focusable nav props, as Steam does; (2) the plugin renders in a separate frame so a brand check that fails on the Deck fails in the preview too; (3) the focus linter gains rules against D-pad routing via keydown and against `instanceof Element` / `Node` on nodes from another document.
- **Cheapest slice:** the two lint rules alone are ★ and would have caught both multi-fix bugs before deploy.
- **Concrete first step for:** *One D-pad test, two runners* below — this is what makes the preview runner worth having.
- **Acceptance:** a D-pad handler written on keydown, or a brand-checked node, fails in the preview and the linter, not only on the Deck.

### Find and launch games from the library, not the Recent shelf
★★★ · Planned — asked 2026-09-07
- **Problem:** `deck_launchGame` walks the Home screen's Recent Games shelf in one direction. bonsAI's round 34 hit both limits in one night: Black Mesa was installed but not on the shelf, so the launcher refused it, and "the launcher only walks right, so a ring parked at the end of the shelf makes a present game look absent" (`4183f6f`). bonsAI also read the Steam library over SSH by hand twice to plan test titles.
- **What to build:** a `deck_listGames` that reads installed titles, non-Steam shortcuts and running apps from `SharedJSContext` with no presses, and a launch path that navigates to the game's own page (`/library/app/<appid>`) and presses A on Play, with the shelf walk as fallback and both walk directions.
- **Acceptance:** any installed title, including a non-Steam shortcut, launches by app id whether or not it is on the Recent shelf.

### Measure colours inside a control
★★★★ · Planned — asked 2026-09-07
- **Problem:** screenshots are being used as rulers. bonsAI sampled nine points by hand to explain why a corner icon read as 89 % visible on a two-line bubble and 67 % on a one-line one (`48c8c08`), and "measured and pictured" two colour fixes on device (`b8ed222`). The visibility oracle is a DOM hit-test and admits it can't see colour.
- **What to build:** given a selector or the focused element, capture the screen, sample N points inside its rect, return the colours and a cropped PNG, and compare against a saved baseline (`preview.compareScreenshot` does this for the preview only).
- **Why four stars:** needs the capture helper (sudo, gamescope) on every read, and colour thresholds are easy to get wrong in both directions.
- **Acceptance:** "is the focus ring the right colour and uncovered" is a number with a crop attached, reproducible across two runs on the same build.
- **Depends on:** L8 in the [session plan](#session-plan). The crop in that acceptance line cannot reach a model today — every tool result is a single text block, so a returned PNG is a filename, not a picture.

### Type text on the Deck
★★★★ · Planned — asked 2026-09-07
- **Problem:** nothing can type on the Deck. bonsAI built "frozen test chips" (`b278f7b`) and pins test questions into `settings.json` over SSH with the panel closed, purely because a question can't be entered from a tool. Every Ask test is routed through that workaround.
- **What to build:** a keyboard interface on the bridge board alongside the gamepad, and a `deck_typeText` that uses it. Shares the firmware work and the "does the extra interface disturb Steam's view of the controller" check with option 1 of *Sleep the Deck and wake it again*.
- **Fallback:** CDP `Input.insertText` is ★ and works today, but must be fidelity-tagged as injected, never `steam-routed` — it bypasses Steam's on-screen keyboard and proves nothing about the real path.
- **Acceptance:** a test types a question into the plugin's Ask field through the bridge and the reply arrives, with no pinned chip involved.

### Keep a log of every run automatically
★★ · Planned — asked 2026-09-07
- **Problem:** bonsAI's `runs/` folder holds 457 hand-named evidence files, `roadmap.md` changed 290 times in a month, and a whole subagent lane exists for "desk paperwork" during device rounds. Each device row means saving a tool result under a name, flipping a testing row, and moving a roadmap entry — three merges were resolved by hand in three days.
- **What to build:** every `deck_*` tool appends a line to a per-session ledger (row id, build hash, running game, verdict, evidence path), tools accept a `rowId` / `saveAs` so evidence files name themselves, and a report call emits the markdown block a testing row expects.
- **Out of scope:** flipping rows in the consumer's own docs — that convention is theirs.
- **Acceptance:** a night's device round produces a ledger and named evidence files with no hand-typed filenames.

### A self-check for DPS itself
★ · Planned — asked 2026-09-07
- **Problem:** three bonsAI commits went to DPS setup drift: Claude Code reads `.mcp.json` not `mcp.json` (`6322f64`), the DPS tools pointed at a path that no longer existed (`d98a97a`), and a second VS Code window killed its own MCP server (`127a743`). bonsAI is now building a connection doctor for Ollama; DPS has none for itself.
- **What to build:** a `studio_doctor` call and IDE command that checks the MCP config points at a live server path, no second workspace shares the preview or sidecar ports, and the bridge, tunnel script and capture helper are present — and prints the fix for each miss.
- **Acceptance:** each of the three drifts above is reported by name with its fix, instead of surfacing as a silent dead tool.

### Studio issue intake
★★ · Planned
- **What:** An MCP tool (`studio.reportIssue`) plus a **Decky: Report Studio Issue** IDE command and tree entry, so an agent that hits a bug can file it without leaving the IDE.
- **Details:** auto-captures a redacted diagnostic bundle (version, Deck env, preview state, recent tool calls), stamps a `reportId` into failed-tool errors, and submits via `gh` or a prefilled issue URL — always previews before posting. Needs `.github/ISSUE_TEMPLATE/` and `surface:*` / `source:*` labels.
- **Plan:** [01-dpad-focus-oracle-and-issue-intake.md](planning/01-dpad-focus-oracle-and-issue-intake.md) § Part B

### Pluckable studio
★★★ · Planned
- **What:** Split the all-or-nothing Init Pack into separately installable modules: (1) build/deploy/dev scripts, (2) hooks, (3) MCP tools, (4) subagents + skills, (5) preview + visual/capture, (6) D-pad focus linter — each documented and installable on its own.
- **Catch:** the modules aren't actually independent yet — subagent instructions assume the MCP tools exist, hooks assume the scripts exist, and the focus linter needs the preview to render. Untangling those dependencies is the real work, not the packaging. Either the linter needs a source-only fallback mode, or module 6 declares a hard dependency on module 5.

### One D-pad test, two runners
★★★★ · Planned — requested 2026-08-27
- **What:** write a focus/D-pad test once, run it against both the in-IDE preview (fast, free, CI-friendly) and a real Deck through the bridge (slow, truthful).
- **Honest framing:** this gives a shared test *definition*, not a shared *verdict* — the preview has no access to Steam's real navigation graph, so it can never confirm Deck focus behavior. The win is that the preview catches cheap failures early (a control that stopped rendering, a changed label), while the device run stays the only source of truth for "did the ring actually move."
- **Evidence it's needed:** a real bonsAI navigation bug (Down never reaching a masked spoiler fence) was reproduced twice on-device, but a preview run of the same steps would have reported it as fine, since the preview doesn't model Steam's routing at all.
- **Must-have to avoid making things worse:** label the preview result as a smoke check only, never merge it into the device verdict — a green preview must never be mistakable for a green device result.
- **Concrete first step:** *Make the preview behave more like Steam* above — until the preview stops dispatching keydown and shares a realm with the plugin, its green means less than it looks.

### Automated issue triage agent
★★★ · Planned
- **What:** a GitHub agent with two tiers. Tier 1 (automatic, read-only): classify the issue's surface, dedupe it, check it against `main`, comment with a `file:line` confirmation, label `agent-triaged`. Tier 2 (only when a maintainer adds `agent-fix`): branch, fix, test, open a draft PR — never touches `main`, never releases.
- **Guardrails:** issue text is untrusted public input; anything needing hardware to confirm (`needs-hardware`) must stop and ask rather than guess. Depends on the issue-intake feature above for good signal.
- **Plan:** [01-dpad-focus-oracle-and-issue-intake.md](planning/01-dpad-focus-oracle-and-issue-intake.md) § Part C

---

## Open bugs

### `deck_holdAwake` does not hold a Steam Deck awake
★★★ · Open — found 2026-09-08 on the plan-09 phase-2 device pass
- **Problem:** the tool reports `ok: true`, "screen/suspend timeouts disabled", and `restored: true` — and controls nothing. Neither setting it targets governs Game Mode sleep.
- **Measured on device:** `xset q` on `DISPLAY=:1` answers, but reports **"Server does not have the DPMS Extension"** — the whole `xset dpms`/`xset s` half is a no-op on this Deck's Xwayland. Sleep here is owned by **gamescope** (`start-gamescope-session`, `--xwayland-count 2`) with `upower`/`vpower`, not by systemd-logind's idle action, so `IdleActionSec` is the wrong knob even when it is written successfully.
- **And restore does not restore.** Both reads collapse "could not read" into `0`, and `0` is also the value meaning "disabled". An **absent** `IdleActionSec` — where systemd's own default (30 min, per the commented line in `logind.conf`) applies — is therefore recorded as `previous: 0`, and restore writes back an explicit `IdleActionSec=0` that is never removed. The Deck is left in a state it was not in before, while the tool reports success. **Cleaned up 2026-09-08:** the QA Deck's `/etc/systemd/logind.conf` did carry an uncommented `IdleActionSec=0` from this pass — proven added by the tool rather than pre-existing (file mtime 00:19 on the night of the run, the line appended as the last line of an otherwise entirely commented stock file). It was removed, and the file is back to stock with `[Login]` as its only uncommented line; a copy of the modified version is at `/etc/systemd/logind.conf.dps-bak-20260908` on the Deck.
- **Why the unit tests did not catch it:** the SSH layer is faked, so the fake answers whatever the test wrote — the "test mocks the thing under test" case the acceptance bar's honesty paragraph exists to surface. **The lane's own report predicted this precisely** and marked the feature device-unverified. The process worked; the feature does not.
- **Fix: known, and measured on hardware 2026-09-08.** Replace both settings with a single logind **block-mode `sleep` inhibitor**, held in system scope via `systemd-run` — see [Hold the Deck awake](#hold-the-deck-awake-for-a-test-run-then-put-the-setting-back) for the measurement and the exact commands. Steam refuses to suspend while one is held, and says so itself (`Access denied due to active block inhibitor`). A lease has nothing to read and nothing to write, so both halves of this bug disappear rather than getting patched: there is no "absent versus 0" to confuse, and no file to leave changed. The tool can also *prove* it holds the lock (`systemd-inhibit --list`) instead of asserting success. Until that ships, `deck_holdAwake` must refuse rather than report a hold it did not take.

### The extension's 30s status poll opens COM7 and collides with presses
★ · Open — found 2026-08-31, mitigated
- **Problem:** the extension polls `deck_status` every 30s ([extension.ts](../extension/src/extension.ts) `pollStatus`), which opens the same serial port a live press is trying to use. Every early `deck_sweep` run died around press 10–22 with `PermissionError: could not open port 'COM7'`.
- **Mitigation shipped:** `pressButton` now retries once, 350ms later, on exactly this error, reports `retried: true`, and callers surface it as `pressRetried` / `pressRetries` so the collision stays visible instead of hidden. Also fixed the error message getting truncated before the actual exception line.
- **Still needed:** the status poll shouldn't open the serial port while a run holds it (shared port ownership, or a cached last-known state), and the extension shouldn't probe at all while a run is live.
- **Root fix:** *Only one driver at a time* under Planned features — the poll simply stays off the port while a lease is held.

### `deck_openPlugin` intermittently fails to open the QAM
★★ · Open
- **Problem:** twice in one session (2026-08-28), the tool reported the QAM pane never appeared after sending the open chord, even though the focus read right before it succeeded. Calling it again immediately worked both times.
- **Likely cause:** the chord is delivered before the client is ready to act on it, not that anything is actually broken.
- **Cost:** a full failed run plus a retry, and the failure message points at hardware/config, sending the reader to check cabling when nothing is wrong there.
- **Fix idea:** retry the pane-visibility check on a short loop before declaring failure, and if a resend is genuinely needed, say in the message that a retry usually works.

---

## Fixed bugs

### Fixed 2026-09-08

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
> deploy chown (not run — it restarts the loader on a live consumer Deck). Lane 1 **failed**: see
> Open bugs.

Landed desk-verified only: unit tests green, **no on-device pass yet**. See
[09-parallel-feature-session.md](planning/09-parallel-feature-session.md) § Phase 2.

**`bridgeReady` and `fidelity: "steam-routed"` both reported success down a dead path** · ★★★ (lane 6)
- Fixed by `bridgePortOpen` (honest name; `bridgeReady` kept as a deprecated alias because bonsAI reads it) and by making `"steam-routed"` unreachable except through the new opt-in `verify: true`, which reads focus before and after a real press. An unverified press reports `"wire-sent"` — the firmware acked, and nothing more. `preview_start` had the same one-line disease and now checks the URL answers. **Its device repro — unplug the board's Deck-side lead — is the one phase-2 step that needs a human's hands, and is still outstanding.**
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

**Capture scripts directory never resolved** · ★★ · [#2](https://github.com/qd313/decky-plugin-studio/issues/2)
- **Problem:** `deck_captureScreenshot` and `deck_installCaptureHelper` both failed immediately with a malformed path (`\c:\Users\...`) — a POSIX-style path join applied to a Windows drive letter, so the lookup could never succeed. The same broken candidate was even printed twice.
- **Fix:** replaced the manual path handling with `fileURLToPath` in both places (capture scripts and the reverse-tunnel script), deduplicated the candidate list, and added a `DECKY_STUDIO_REPO`-based fallback to `templates/scripts` that doesn't depend on install location.

**`deck_openPlugin` needed 2–3 attempts after `deck_deploy`** · ★★ · [#3](https://github.com/qd313/decky-plugin-studio/issues/3)
- **Problem:** reproduced on 5/5 deploy-then-open cycles. Attempt 1 failed because the QAM's CEF debug targets aren't enumerable yet right after a loader restart. Attempt 2 then fired the open/close chord blind — since it's a toggle, hitting it against an already-open QAM closed it instead.
- **Fix:** retry target enumeration briefly instead of failing immediately, and only fire the chord when the tool can see the QAM isn't already showing (rather than firing unconditionally). `deck_deploy` / `deck_reloadPlugin` now also wait (up to 30s) for the loader to actually come back before returning.

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
- **Reachable four ways:** a dedicated status bar item, the **Decky: Stop All Deck Automation** command, `ctrl+alt+.`, and `pnpm stop` from a terminal.
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

## Shipped in v0.3.x (autonomy pack)

- **Deck automation killswitch** — `deck_stopAutomation` / `deck_automationStatus`, a status bar stop button, `ctrl+alt+.`, and `pnpm stop`; file-based latch so a stop crosses process boundaries, human-only re-arm
- **deck.reloadPlugin**, **deck.openPlugin** (checklist), **deck.readPluginLog**, **deck.getEnv**
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
