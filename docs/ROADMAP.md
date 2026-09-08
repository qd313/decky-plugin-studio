# Decky Plugin Studio — roadmap (deferred)

Star ratings follow bonsAI [roadmap](https://github.com/cantcurecancer/bonsAI) legend (effort/risk, 1 = lowest).

- [Deferred / shelved](#deferred--shelved) — out of scope for now, with reasons
- [In progress](#in-progress) — partially shipped
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

## Planned features

### Hold the Deck awake for a test run, then put the setting back
★★ · Planned — asked 2026-09-07
- **Problem:** QA runs involve a lot of waiting (slow replies, game launches, a person reading results), and the Deck falls asleep mid-run. Presses land on a sleeping machine and get lost; reads come back empty — costing real time working out "did the Deck sleep" versus "did the thing under test break."
- **What to build:** two paired calls. One turns off the screen/suspend timeouts and records their old values; the other restores exactly those values.
- **Key risk:** leaving a Deck that never sleeps drains its battery. Mitigate by writing the old values to a run file the instant they're read (so a crashed session still leaves them recoverable), refusing to disable timeouts again if a previous run's values were never restored, and making the restore call safe to call even if nothing changed. Worth considering: an automatic restore after N minutes, so a forgotten restore fails toward "sleeps again" rather than "never sleeps."
- **Not the same as** "Sleep the Deck and wake it again" below — that causes a sleep to test what happens after one; this prevents an unwanted sleep from interrupting everything else. They likely share the code that reads/writes the settings.
- **Acceptance:** a long unattended run (several questions, a game launch, a game exit) completes with no lost press or empty read, and the Deck's sleep settings match their original values afterward.

### Sleep the Deck and wake it again
★★★ · Planned — asked 2026-09-05
- **Why it matters:** a bonsAI bug was first seen after the Deck slept and woke — focus landed on an invisible button. Every other way of forcing a redraw (closing a dialog, reopening the menu, restarting the plugin loader) came back clean, so the fix shipped without ever testing the one path that actually showed the bug.
- **Why it's hard:** presses go through a controller, and a sleeping Deck ignores its controller. Sleeping is easy (power menu, or over the network); waking is the problem — the power button is physical, so a sleep with no way back strands the Deck and ends the session.
- **Three candidate wake methods, in try-order** (from maintainer experience 2026-09-05 — a keyboard press has woken this Deck before, and SteamOS has a setting to let some controllers wake it, maybe Bluetooth-only):
  1. **Add a keyboard interface to the bridge board** (alongside its existing gamepad interface) and press a key. Same path known to work on this hardware. Needs two checks first: the extra interface doesn't disturb Steam's view of the controller, and the Deck is configured to allow that USB device to wake it.
  2. **Sleep with a wake alarm already armed**, so the Deck wakes itself after N seconds. No hardware needed, ~10 minutes to try, and doubles as a safety net for option 1 — a failed wake then costs a minute, not the whole session.
  3. **Wake over the network** (magic packet, or Steam's own Remote Play wake). Least certain, but needs no hardware — worth testing alongside option 2.
- **Shape of the tool:** one call — sleep, then come back after N seconds. It refuses to sleep until it has proven a way back on this machine (armed and read back the alarm, or confirmed the board's wake permission), refuses while a game is running, and logs what it saw before/after to a run file. It must not touch the panel on the way back, so the very next read shows exactly where focus landed. Prefer sleeping through the real power menu (truer to what a person does), falling back to the network method when the menu isn't reachable, and report which path was used.
- **Also needs:** confirming the stop-control (killswitch file) survives a sleep, and reporting plainly — not silently pressing on — if focus comes back somewhere unexpected on wake.
- **Acceptance:** the bonsAI suspend/resume test can run unattended and report where the focus ring landed on wake.

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

### Automated issue triage agent
★★★ · Planned
- **What:** a GitHub agent with two tiers. Tier 1 (automatic, read-only): classify the issue's surface, dedupe it, check it against `main`, comment with a `file:line` confirmation, label `agent-triaged`. Tier 2 (only when a maintainer adds `agent-fix`): branch, fix, test, open a draft PR — never touches `main`, never releases.
- **Guardrails:** issue text is untrusted public input; anything needing hardware to confirm (`needs-hardware`) must stop and ask rather than guess. Depends on the issue-intake feature above for good signal.
- **Plan:** [01-dpad-focus-oracle-and-issue-intake.md](planning/01-dpad-focus-oracle-and-issue-intake.md) § Part C

---

## Open bugs

### The extension's 30s status poll opens COM7 and collides with presses
★ · Open — found 2026-08-31, mitigated
- **Problem:** the extension polls `deck_status` every 30s ([extension.ts](../extension/src/extension.ts) `pollStatus`), which opens the same serial port a live press is trying to use. Every early `deck_sweep` run died around press 10–22 with `PermissionError: could not open port 'COM7'`.
- **Mitigation shipped:** `pressButton` now retries once, 350ms later, on exactly this error, reports `retried: true`, and callers surface it as `pressRetried` / `pressRetries` so the collision stays visible instead of hidden. Also fixed the error message getting truncated before the actual exception line.
- **Still needed:** the status poll shouldn't open the serial port while a run holds it (shared port ownership, or a cached last-known state), and the extension shouldn't probe at all while a run is live.

### `bridgeReady` and `fidelity: "steam-routed"` both report success down a dead path
★★★ · Open — found 2026-08-27
- **Problem:** with the bridge board connected to the host but its USB lead unplugged from the Deck, every layer reported success and nothing actually happened — `deck_status` said `bridgeReady: true`, `deck_pressButton` said `ok: true, fidelity: "steam-routed"`, and focus reads before/after the press showed no change.
- **Cause:** both signals only check the near half of the path. `bridgeReady` just confirms the serial port opens and the firmware acks — which it does regardless of whether its USB side reaches the Deck. `fidelity: "steam-routed"` claims the Deck received the press without ever asking the Deck.
- **Why it matters more than the star rating suggests:** a confident false "success" is worse than an honest failure — the same class of problem the killswitch feature exists to prevent.
- **Why it's not fixed yet:** the honest fix costs a press — proving delivery means reading focus before and after a real press. Minimum fix in the meantime: rename `bridgeReady` to something accurate like `bridgePortOpen`, and stop calling an unverified press `steam-routed`.
- **Repro:** unplug just the board's Deck-side USB lead, leave the host-side COM port connected, press a button, read focus twice.

### `deck_runSequence` crashes on a malformed step instead of rejecting it cleanly
★ · Open — found 2026-08-27
- **Problem:** passing `{"buttons": ["DOWN"]}` instead of the correct `{"press": "DOWN"}` throws a raw `TypeError: Cannot read properties of undefined (reading 'trim')` instead of a clear validation error.
- **Cause:** the registry schema already declares the required shape, but nothing enforces it before the step runs.
- **Why it matters:** the caller is usually an agent that guessed a field name — a validation error tells it to re-read the schema; a `TypeError` sends it debugging the server instead.

### Deploy re-owns pre-existing plugin content, and the loader-restart message cries wolf
★ · Open — found 2026-08-27
- **Issue 1 — ownership:** the final `sudo chown -R root:root <target>` walks the *entire* installed directory, not just what was just uploaded — so pre-existing content (like bonsAI's `data/`) silently changes ownership. Harmless if the plugin only reads it, a silent problem if anything writes there, and it also blocks a later plain-`scp` deploy from overwriting those files. Fix: scope the chown to only what was staged.
- **Issue 2 — false alarm:** `sshRestartLoader()` tries a user-scope restart first, which always fails because the systemd unit is system-scope — so every *successful* restart still prints a scary "Failed to restart" line. Cosmetic, but it trains people to ignore the one failure message that would actually matter.

### Every CDP read opens and tears down its own SSH tunnel
★★ · Open
- **Problem:** `withCdpTunnel` ([cdpTunnel.ts](../mcp-server/src/deck/cdpTunnel.ts)) spawns a fresh SSH tunnel, waits for it to be ready, runs the call, then closes it — for every single `deck_readPage` / `readFocus` / `walkTo` / `runSequence` call. A round trip is ~350ms on this network, plus a 300ms-step readiness poll on top, so a ~150ms read ends up costing close to a second.
- **Why it matters now:** this is the largest remaining per-step cost, now that the bridge fix (below) got presses down to ~0.4s.
- **Options:** keep one tunnel alive for the server's whole lifetime and hand its URL to every tool call (the `cdpUrl` input already half-exists for this), or use SSH `ControlMaster` / `ControlPersist` to amortize the connection cost. Expected gain: roughly 2–3x on read-heavy runs.

### `deck_openPlugin` intermittently fails to open the QAM
★★ · Open
- **Problem:** twice in one session (2026-08-28), the tool reported the QAM pane never appeared after sending the open chord, even though the focus read right before it succeeded. Calling it again immediately worked both times.
- **Likely cause:** the chord is delivered before the client is ready to act on it, not that anything is actually broken.
- **Cost:** a full failed run plus a retry, and the failure message points at hardware/config, sending the reader to check cabling when nothing is wrong there.
- **Fix idea:** retry the pane-visibility check on a short loop before declaring failure, and if a resend is genuinely needed, say in the message that a retry usually works.

### `deck_walkTo` calls a legitimate stay-put a stall
★★ · Open
- **Problem:** the stall detector compares the focused *element* between presses. A container that handles its own left/right/up/down internally (like bonsAI's context-chip strip) looks frozen to that check even though it's actually responding — `walkTo` reported `stalled: true` after 3 presses when 2 more presses would have walked out of the strip onto the next real control.
- **Why it matters:** a false dead end reads like a focus-trap bug in the plugin being tested, when the plugin is fine.
- **Fix idea:** treat a change in the focused element's text/`aria-label` as movement even when the DOM node itself doesn't change — that's exactly what an internally-paged container does change.

---

## Fixed bugs

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
