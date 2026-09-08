# Parallel feature session — eight lanes

Written 2026-09-07. Implements the eight lanes in [ROADMAP.md](../ROADMAP.md) § Session plan.
Run this from a fresh Opus session (orchestrator, extra-high reasoning). Each lane below is a
complete, self-contained subagent prompt — paste it verbatim into an `Agent` call.

Same shape as [05-parallel-bugfix-session.md](05-parallel-bugfix-session.md), which covered the
seven open bugs of 2026-08-26/27. That session's lessons are baked in here: the acceptance bar,
the named merge hotspots, and the serial on-device phase that must not be parallelized.

## Orchestrator instructions

- Spawn all eight lanes at once: `Agent` tool, `model: "sonnet"` (high reasoning),
  `isolation: "worktree"`, background (the default). **Do not implement anything yourself in
  phase 1** — your job is dispatch, diff review, and merge.
- Each worktree needs `pnpm install` before its tests run. pnpm hardlinks from a shared store,
  so the disk cost is modest, but the install time is real — tell each lane to do it first.
- Base every lane on `main` at the session plan commit. `main` was fast-forwarded from
  `faster-bridge-presses` on 2026-09-07; there is no other outstanding work.

### Acceptance bar for every lane

1. **A test that fails before the change and passes after.** The lane must show the failing
   output, not merely claim it. The harness is `node:test` + `tsx`; the fake CDP server lives at
   `mcp-server/src/deck/__testutil__/fakeCdp.ts`. Read `readPage.test.ts`, `walkTo.test.ts`,
   `runSequence.test.ts`, `deckDeploy.test.ts` for the idiom.
2. **The full mcp-server suite green** (`npm test` in `mcp-server/`, 238 passing at session
   start). New test files must be added to the `test` script in `mcp-server/package.json` or
   they will never run.
3. **The honesty paragraph.** Every lane answers, in its report: *what could this test pass while
   the real thing is broken?* One paragraph. If the honest answer is "everything" — the test
   mocks the very thing under test — the lane says so plainly and the feature is marked
   device-unverified rather than counted as done. This is not optional and it is not a
   formality: nearly every serious bug in the roadmap's Fixed list passed its unit tests and was
   caught on hardware anyway.
4. **No scope creep.** Reject diffs that refactor beyond the stated change.

### Files no lane may touch

`docs/ROADMAP.md`, `CHANGELOG.md`, `docs/MCP_TOOLS.md`, `AGENTS.md`, `pack/AGENTS.md`.
The orchestrator writes all of these once, at the end. Hand-resolved documentation merges are a
known recurring cost and this rule removes them outright.

### Known merge hotspots

`mcp-server/src/toolRegistry.ts` and `mcp-server/src/index.ts` — L1, L2, L3 add tools and L6, L8
change descriptions or the result path. The edits are additive and the conflicts trivial; resolve
them yourself at merge, do not bounce them back. `mcp-server/src/toolRegistry.test.ts` already
diffs the registry against the dispatch cases in both directions, so a tool added to one and not
the other fails the build rather than going quietly missing.

Merge order: **L4, L5, L7 first** (little or no registry contact), then **L6, L8**, then
**L1, L2, L3**. Full suite plus `pnpm build` after each merge, not just at the end.

### Landing

One squashed commit per lane, straight onto `main`, so a bad feature backs out with a single
`git revert`. **Do not bump the version in `package.json` or `extension/package.json`.** A push
to `main` that changes either file triggers
[build-vsix.yml](../../.github/workflows/build-vsix.yml), and when the matching tag is absent it
auto-publishes a GitHub Release. Leaving the version alone is what makes landing
desk-verified-only work on `main` harmless. The bump is a deliberate act after phase 2.

After all eight merge: full suite, `pnpm build`, then `pnpm run package:vsix` and the bundled
smoke test. This repo has shipped three packaging omissions (VSIX missing the MCP server's
`node_modules`, VSIX missing `bridge/tools/`, capture scripts never reaching `dist`) — any lane
adding a file that must ship gets checked against the VSIX manifest by hand.

---

## Phase 2 — one on-device pass (serial, human-scheduled, do NOT start it yourself)

One Deck, one bridge board, one COM port, one focus ring. Nothing else may drive the Deck during
this pass — the killswitch latch (`~/.config/decky-plugin-studio/automation-stop.json`) and the
source-tree MCP server are shared with bonsAI work.

Budget roughly **1h40 of active device time, 2.5–3h wall clock** with setup and recovery.

1. First act of the session: one harmless direction press to probe the bridge (working rule from
   2026-08-27). L6 changed what a press claims about itself — read the new fields here.
2. **L6** — unplug the board's Deck-side USB lead, leave the host COM port connected, press, read
   focus twice. `bridgePortOpen: true` with no `steam-routed` claim, and an honest failure.
3. **L8** — `deck_captureScreenshot` returns a picture the model can actually see, from a
   packaged VSIX rather than a source checkout.
4. **L7** — a read-heavy run (a sweep) completes with one tunnel, and is measurably faster than
   the recorded baseline.
5. **L5** — `deck_walkTo` across bonsAI's context-chip strip walks out of it instead of reporting
   `stalled: true`; a deploy against a plugin with a `data/` directory leaves that directory's
   ownership alone and prints no false restart failure.
6. **L2** — run against a Deck still holding last night's build, then against a sleeping one.
   Both stop before the first press and name the failed precondition.
7. **L3** — save a sweep, deploy, replay, diff. Landings that did not change report as unchanged.
8. **L1** — set the timeouts, run several questions and a game launch unattended for 20+ minutes,
   restore, and confirm the Deck's sleep settings are byte-identical to the snapshot.
9. **L4** needs no device time — it is preview and linter only.

Expect this pass to find things. That is its job. Note that the COM7 status-poll collision is
still live (its root fix is *Only one driver at a time*, first in the solo season), so a press
reporting `retried: true` during this pass is expected behaviour, not a finding.

---

## Lane 1 — Put the Deck back the way you found it

You are working in a worktree of decky-plugin-studio, a VS Code extension plus MCP server for
Steam Deck plugin development. Run `pnpm install` first. All verification is unit tests — touch
no real hardware.

Build **two paired tools that share one state machine**. They are one lane precisely because
they are the same problem twice, and building them separately would produce two implementations
that drift apart.

**Feature A — hold the Deck awake for a test run, then put the setting back.** QA runs involve a
lot of waiting (slow replies, game launches, a person reading results) and the Deck falls asleep
mid-run. Presses land on a sleeping machine and vanish; reads come back empty. The cost is real
time spent working out "did the Deck sleep" versus "did the thing under test break." Build one
call that turns off the screen and suspend timeouts while recording their previous values, and
one that restores exactly those values.

**Feature B — save and restore the plugin's settings around a test run.** Every device session
currently ends with someone putting the Deck back by hand: settings, pinned test questions, which
tab was open. There is a `settings.json.bak-preQA` sitting on the Deck right now because nothing
tooled does this. Build one call that copies the plugin's settings directory (and optionally its
data directory) over SSH into a run file, and one that puts exactly that copy back.

**The shared state machine — build it once, in its own module, and use it for both:**

- Write the old values to a run file **the instant they are read**, before changing anything, so
  a crashed session still leaves them recoverable.
- Refuse to take a new snapshot while a previous one was never restored. Name the stale snapshot
  and how to restore it.
- Restore must be safe to call when nothing changed, and safe to call twice.
- Consider an automatic expiry after N minutes, so a forgotten restore fails toward the safe
  state (the Deck sleeps again; the settings go back) rather than the unsafe one.

The battery risk is the reason for all of the above: a Deck left never sleeping drains itself
with nobody watching.

**Requirements.** Fake the SSH layer; no network, no hardware. Test at minimum: values are
persisted before the change is applied; a second snapshot over an unrestored one is refused with
a message naming the stale one; restore with no snapshot present is a clean no-op, not an error;
restore is idempotent; a partially-written run file is detected rather than silently trusted;
and expiry restores the original values. Add your test files to the `test` script in
`mcp-server/package.json`. Register new tools in `mcp-server/src/toolRegistry.ts` **and** add the
dispatch cases in `mcp-server/src/index.ts` — `toolRegistry.test.ts` fails the build if you do
one without the other. Do not touch `docs/ROADMAP.md`, `CHANGELOG.md`, `docs/MCP_TOOLS.md` or
`AGENTS.md`.

**Report:** the shared module's shape, the tool names and their schemas, test names, what you
decided about expiry, and the honesty paragraph — what could these tests pass while the real
thing is broken?

---

## Lane 2 — Check the Deck is ready before a run starts

You are working in a worktree of decky-plugin-studio, a VS Code extension plus MCP server for
Steam Deck plugin development. Run `pnpm install` first. All verification is unit tests.

**The problem.** Runs start blind, and each blind start costs a run plus the time to work out it
was not the thing under test. Real cases from device QA: a Deck that had fallen asleep; a stale
build proven only by a hand-run `md5sum`; a foreign CDP tunnel belonging to another session; a
game running when none was expected; and a Steam dialog on screen that nobody knew about.

**What to build.** One call that takes a *declared* state and returns the diff against the actual
one. The declared state covers: the Deck is awake; the deployed build hash equals the local
build; the running game is a named app id or nothing; the plugin is open on a named tab; there is
no foreign CDP tunnel; nothing modal is on screen; the focus ring is owned. Every field is
optional — an absent field is not checked. Any mismatch fails the run at step zero with a named
reason, not a generic failure.

**Start with the cheap half.** `deck_deploy` already knows every file it shipped, so "is the
right build installed" is a hash compare and nothing more. Get that correct and well-tested
before the harder checks.

**Compose, do not refactor.** This tool reads through machinery that already exists — the deploy
copy manifest, the CDP reads, the focus reader, the game-session state. Call into it. If a reader
genuinely cannot be reused without a change, make the smallest possible additive change and say
so in your report; do not restructure another module to suit this one.

**Requirements.** Fake the SSH and CDP layers. Test at minimum: a matching declared state passes;
each individual mismatch fails with its own named reason; an absent field is not checked at all;
and a check that cannot be evaluated (a reader that errors) reports *that* rather than silently
passing — an unknown must never read as a pass. Add your test files to the `test` script in
`mcp-server/package.json`. Register the tool in `mcp-server/src/toolRegistry.ts` and add its
dispatch case in `mcp-server/src/index.ts`. Do not touch `docs/ROADMAP.md`, `CHANGELOG.md`,
`docs/MCP_TOOLS.md` or `AGENTS.md`.

**Report:** the input schema, what each check actually reads, anything you could not check and
why, test names, and the honesty paragraph.

---

## Lane 3 — Save a passing check and replay it after every deploy

You are working in a worktree of decky-plugin-studio, a VS Code extension plus MCP server for
Steam Deck plugin development. Run `pnpm install` first. All verification is unit tests.

**The problem.** The same sweeps get rerun by hand after every build, and the metric that matters
most — "bugs fixed more than once" — is counted by nothing. The goal on the consumer side is
literally "a D-pad bug locked by a check that fails without the fix," reached once, by hand.

**What to build.** A way to save a `deck_runSequence` or `deck_sweep` result, together with its
expected landings, as a **named check file in the consumer's repo**. Then a replay call that
reruns every saved check after a deploy and diffs each against its saved result. Sweep reports
already reproduce byte-for-byte across runs on the same build, so this is a file format plus a
loop — the hard part is choosing what belongs in the format, not the mechanism.

**Design notes.** Decide deliberately which fields are part of the expected result and which are
incidental (timing, press retries, and anything else that legitimately varies run to run must not
make a check fail). A check that fails for a reason unrelated to the plugin is worse than no
check, because it trains people to ignore red. Record the build hash the check passed against, so
a diff can say "this changed" separately from "this was never true here."

**Stay at the check layer.** Read the result shapes that `sweep.ts` and `runSequence.ts` already
produce. Do not modify those modules to add saving — if you genuinely cannot express a check
without a change there, make it additive and justify it in your report.

**Requirements.** Fake the run layer entirely; a replay test must not need a Deck. Test at
minimum: a saved check round-trips; an unchanged replay reports no diff; a changed landing is
named specifically (which stop, expected versus actual); an incidental field changing does *not*
fail the check; a malformed or truncated check file is rejected with a clear message rather than
crashing; and replaying a check saved against a different build hash says so. Add your test files
to the `test` script in `mcp-server/package.json`. Register new tools in
`mcp-server/src/toolRegistry.ts` and add dispatch cases in `mcp-server/src/index.ts`. Do not
touch `docs/ROADMAP.md`, `CHANGELOG.md`, `docs/MCP_TOOLS.md` or `AGENTS.md`.

**Report:** the check file format with a worked example, which fields are compared and which are
ignored and why, test names, and the honesty paragraph.

---

## Lane 4 — Make the preview lie less

You are working in a worktree of decky-plugin-studio, a VS Code extension plus MCP server for
Steam Deck plugin development. Run `pnpm install` first. **This lane needs no Deck at any point,
now or at verification.**

**The problem, stated precisely.** Fixes pass on the PC and do nothing on the Deck, repeatedly,
and the test suite is what makes it repeatable. Two documented cases:

- A spoiler-fence keydown intercept was "dead code on hardware and alive under vitest, which is
  the recurrence engine." Steam never dispatches DOM keyboard events into a plugin — D-pad
  navigation runs through Decky `Focusable` callbacks (`onMoveLeft`, `onMoveRight`, `onOKButton`
  and friends). A handler written on `keydown` works in the preview and is inert on device.
- A hidden-tab trap used `instanceof Element`, which was false for every node, because the QAM
  document is a **different realm**. jsdom shares realms, so the test could not reproduce it.

**What to build, in two parts. The linter is the priority — do it first and do it well.**

1. **Two lint rules**, in `mcp-server/src/lint/rules/` following the existing rule structure
   (`activation.ts`, `banned.ts`, `reachable.ts`, `reveal.ts`, `reversibility.ts` — read several
   before writing yours, and match how they report). Rule one: D-pad routing via DOM `keydown`
   (or `keyup`/`keypress`) rather than Focusable navigation props. Rule two: `instanceof Element`
   or `instanceof Node` applied to a node that may come from another document. Each rule needs
   fixture cases that trip it and, just as importantly, near-miss cases that must **not** trip it
   — a rule with false positives gets disabled and then protects nothing.
2. **The preview stops sending DOM keydown for D-pad directions** and fires only the Focusable
   navigation props, as Steam does. This lives in the preview server
   (`preview-server/src/shim/focusManager.ts` and around it — read how focus is currently routed
   before changing it). A D-pad handler written on keydown must stop working in the preview,
   because it does not work on the Deck.

**Out of scope for this lane:** rendering the plugin in a separate frame so that cross-realm
brand checks fail in the preview too. It is the right idea and it is the third part of this
feature, but it is a larger change than the two above and it does not block them. Note in your
report what you learned that would help whoever does it.

**Requirements.** Lint rules are tested through the existing harness — see
`mcp-server/src/lint/lint.test.ts`. Every rule needs both a tripping fixture and a
non-tripping near-miss. For the preview change, a test proving that a D-pad direction no longer
produces a DOM key event and does produce the Focusable call. Add test files to the `test` script
in `mcp-server/package.json`. Do not touch `docs/ROADMAP.md`, `CHANGELOG.md`,
`docs/MCP_TOOLS.md` or `AGENTS.md`.

**Report:** the rule names and exactly what each does and does not flag, whether either rule
would have caught the two historical bugs above (check honestly — if not, say so and explain what
would), what changed in the preview's focus routing, test names, and the honesty paragraph.

---

## Lane 5 — Three small honest fixes

You are working in a worktree of decky-plugin-studio, a VS Code extension plus MCP server for
Steam Deck plugin development. Run `pnpm install` first. All verification is unit tests. Three
separate small bugs in three different files. Fix each, test each, keep them independent.

**Bug A — `deck_runSequence` crashes on a malformed step instead of rejecting it cleanly.**
Passing `{"buttons": ["DOWN"]}` instead of the correct `{"press": "DOWN"}` throws a raw
`TypeError: Cannot read properties of undefined (reading 'trim')`. The registry schema in
`mcp-server/src/toolRegistry.ts` already declares the required shape, but nothing enforces it
before the step runs. The caller is nearly always an agent that guessed a field name: a
validation error naming the expected shape sends it back to the schema, while a `TypeError` sends
it debugging the server. Validate steps before the run starts, and report *which* step index and
*which* field.

**Bug B — deploy re-owns pre-existing plugin content, and the loader-restart message cries
wolf.** Two independent defects in the deploy path (`mcp-server/src/deploy/` and
`mcp-server/src/tools/`). First: the final `sudo chown -R root:root <target>` walks the entire
installed directory rather than only what was just uploaded, so pre-existing content — such as a
plugin's `data/` directory — silently changes ownership. Harmless if the plugin only reads it, a
silent problem if anything writes there, and it blocks a later plain `scp` deploy from
overwriting those files. Scope the chown to only what was staged. Second: `sshRestartLoader()`
tries a user-scope restart first, which always fails because the systemd unit is system-scope, so
every *successful* restart still prints a frightening "Failed to restart" line. Cosmetic, but it
trains people to ignore the one failure message that would actually matter. Do not change what a
real restart failure reports.

**Bug C — `deck_walkTo` calls a legitimate stay-put a stall.** The stall detector in
`mcp-server/src/deck/walkTo.ts` compares the focused *element* between presses. A container that
handles its own left/right/up/down internally — a context-chip strip, for instance — looks frozen
to that check even while it is responding correctly: `walkTo` reported `stalled: true` after 3
presses when 2 more would have walked out of the strip onto the next real control. A false dead
end reads like a focus-trap bug in the plugin under test, when the plugin is fine. Treat a change
in the focused element's text or `aria-label` as movement even when the DOM node itself does not
change — that is exactly what an internally-paged container does change. Note that the shared
accessible-name resolver already exists (see `readFocus.ts` and `focusKey.ts`); reuse it rather
than writing a second one.

**Requirements.** One failing-then-passing test per bug, minimum. For B, assert on the emitted
command strings with the exec layer faked — the existing `deckDeploy.test.ts` shows the idiom.
For C, use the fake CDP server. Add any new test files to the `test` script in
`mcp-server/package.json`. Keep the three fixes in separate commits within your branch so they
can be reviewed independently. Do not touch `docs/ROADMAP.md`, `CHANGELOG.md`,
`docs/MCP_TOOLS.md` or `AGENTS.md`.

**Report:** root cause of each in a sentence, test names, and one honesty paragraph covering all
three.

---

## Lane 6 — Say what you actually know

You are working in a worktree of decky-plugin-studio, a VS Code extension plus MCP server for
Steam Deck plugin development. Run `pnpm install` first. All verification is unit tests.

**The problem.** With the bridge board connected to the host but its USB lead unplugged from the
Deck, every layer reported success and nothing happened: `deck_status` said `bridgeReady: true`,
`deck_pressButton` said `ok: true, fidelity: "steam-routed"`, and focus reads before and after
the press showed no change. Both signals only check the near half of the path. `bridgeReady`
confirms the serial port opens and the firmware acks — which it does regardless of whether the
board's USB side reaches the Deck. `fidelity: "steam-routed"` claims the Deck received the press
without ever asking the Deck.

A confident false success is worse than an honest failure. This is the same class of problem the
killswitch exists to prevent, and it matters more than its star rating suggests.

**What to build, in three parts.**

1. **Rename the status field to what it measures.** Add `bridgePortOpen` alongside the existing
   `bridgePort` / `bridgeReason` in `deck_status`. **Keep `bridgeReady` present as a deprecated
   alias carrying the same value** — a live consumer (bonsAI) reads it, and a hard rename breaks
   them for no safety gain. Mark it deprecated in the registry description and say what to use
   instead.
2. **Stop calling an unverified press `steam-routed`.** An unproven press reports something
   honest about what actually happened — that the press was sent down the wire — and nothing
   more. **Do not keep `steam-routed` available as an alias for the unproven case:** the whole
   defect is that the lying value was reachable. `steam-routed` must be *earned*. Add an opt-in
   mode that earns it by reading focus before and after a real press and confirming it changed.
   It costs a press and a read, so it is opt-in, not the default — but when it is off, the result
   must not claim what it did not check.
3. **`preview_start` has the same disease, one line.** `previewStart()` in
   `mcp-server/src/tools/preview.ts` sets a boolean and returns `running: true` without checking
   that anything is running. Have it verify the preview URL actually answers before claiming it,
   and report honestly when it does not.

**Check the blast radius before you finish.** Grep for every reader of `bridgeReady` and of the
`fidelity` value across `mcp-server/`, `extension/` and `pack/` — the extension's status bar and
tree view both display bridge state. Update them to the new field. Do not update the
documentation files listed below; list what needs changing there in your report instead.

**Requirements.** Fake the serial and CDP layers. Test at minimum: `bridgePortOpen` and the
deprecated `bridgeReady` carry the same value; an unproven press does not report `steam-routed`;
the opt-in verified mode reports `steam-routed` only when focus actually changed, and reports an
honest failure when it did not; `preview_start` against a dead URL does not claim to be running.
Add new test files to the `test` script in `mcp-server/package.json`. Do not touch
`docs/ROADMAP.md`, `CHANGELOG.md`, `docs/MCP_TOOLS.md` or `AGENTS.md`.

**Report:** the exact new field and value names, every call site you changed, what the
documentation files still need, test names, and the honesty paragraph — with particular attention
to whether your test for the verified-press path could pass against a dead board.

---

## Lane 7 — One tunnel, not one per read

You are working in a worktree of decky-plugin-studio, a VS Code extension plus MCP server for
Steam Deck plugin development. Run `pnpm install` first. All verification is unit tests.

**The problem.** `withCdpTunnel` in `mcp-server/src/deck/cdpTunnel.ts` spawns a fresh SSH tunnel,
waits for it to become ready, runs the call, then tears it down — **for every single**
`deck_readPage`, `deck_readFocus`, `deck_walkTo`, `deck_runSequence` and `deck_sweep` call. A
round trip is about 350 ms on this network, plus a 300 ms-step readiness poll on top, so a
150 ms read costs close to a second. Now that the bridge fix brought presses down to roughly
0.4 s, this is the largest remaining per-step cost. Expected gain is roughly 2–3× on read-heavy
runs.

**Two candidate approaches — pick one and justify it.** Either keep a single tunnel alive for the
server process's lifetime and hand its URL to every tool call (the `cdpUrl` input already half
exists for exactly this), or use SSH `ControlMaster` / `ControlPersist` to amortize the
connection cost. Read how the tunnel is currently created, waited on, and disposed before
choosing.

**The correctness requirements matter more than the speed.** A shared long-lived tunnel
introduces failure modes a per-call tunnel does not have, and every one of them must be handled
explicitly rather than discovered on hardware:

- The tunnel dies mid-session (the Deck sleeps, the network drops, SSH times out). The next call
  must detect a dead tunnel and rebuild it, not hang and not fail with a confusing error.
- Two calls race to create the tunnel at once. Exactly one is created.
- The server shuts down, or `deck_stopAutomation` fires. The tunnel is released — a stop must not
  leave an SSH process behind. Read `mcp-server/src/deck/killswitch.ts` and follow the existing
  stop sequence exactly; the ordering there is deliberate.
- The configured Deck IP changes mid-session. The stale tunnel is not reused.

**Requirements.** Fake the SSH spawn layer; no network. Test at minimum: N sequential reads
create one tunnel, not N; a dead tunnel is detected and rebuilt on the next call; concurrent
first-calls create exactly one tunnel; shutdown and the killswitch both release it; a changed
Deck IP invalidates it. Also record a before-and-after timing measurement in your report using
the faked layer, so the claimed gain is a number rather than an assertion. Add new test files to
the `test` script in `mcp-server/package.json`. Do not touch `docs/ROADMAP.md`, `CHANGELOG.md`,
`docs/MCP_TOOLS.md` or `AGENTS.md`.

**Report:** which approach you chose and why, each failure mode and how it is handled, the timing
numbers, test names, and the honesty paragraph — especially what a faked SSH layer cannot tell
you about a real dropped tunnel.

---

## Lane 8 — Let the model actually see

You are working in a worktree of decky-plugin-studio, a VS Code extension plus MCP server for
Steam Deck plugin development. Run `pnpm install` first. All verification is unit tests.

**The problem.** An agent cannot see a screenshot this server takes. Every `tools/call` returns
exactly one text block — see the `tools/call` case in `mcp-server/src/index.ts`:

```
content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }]
```

There is no `image` content block anywhere in the server. `deck_captureScreenshot` returns
`{ path, bytes, mode, method }` — a **filename**, not pixels. So the picture is visible only to
an agent that happens to own a file-reading tool pointed at the same machine, and nothing in the
tool's description even tells it to look. To every other MCP client the tool returns a filename
it can never open. This also blocks a planned feature outright: *Measure colours inside a
control* has the acceptance "a number with a crop attached," and the crop cannot reach a model
today.

**Part 1 — return the pixels.** MCP supports an image content block:
`{ type: "image", data: "<base64>", mimeType: "image/png" }`. Return one **alongside** the
existing text block — do not replace the text, since the path, byte count and capture method are
all still wanted. Applies to `deck_captureScreenshot` and `preview_captureScreenshot`.

Decide and defend these deliberately:

- **A size cap.** A Deck screenshot is roughly 1280×800; base64 inflates by about a third.
  Establish what is reasonable, and when an image exceeds it, downscale rather than dropping it
  silently. If an image is dropped for any reason, the text block must say so — an agent must
  never be left believing it saw a picture it did not receive.
- **Where this lives.** Prefer a small general mechanism at the dispatch seam (a tool result may
  declare an image attachment, and the `tools/call` case turns it into a content block) over
  special-casing two tools. The next tool that returns a picture should not have to repeat this.
  `pngjs` is already a dependency.
- **`deck_record` returns a video.** Video is not an image content block. Leave it returning a
  path, and make sure that stays clearly distinguishable.

**Part 2 — prove the scripts resolve from a packaged build.** This seam has broken three times:
the build never copied capture scripts into `dist`; a POSIX-style path join applied to a Windows
drive letter produced `\c:\Users\...` so no candidate could ever open (issue #2); and separately
the VSIX never bundled `bridge/tools/`. Read the long comment above `scriptsDirCandidatesFrom` in
`mcp-server/src/tools/captureOrchestrator.ts` — it documents the second failure *and* why the
existing layout test did not catch it. That is the gap: the current tests exercise fabricated
paths, not a real packaged artifact.

Add a check that resolves the capture scripts from an actually **packaged** VSIX rather than a
source tree, and fails packaging when they are missing. The precedent to follow is
`extension/scripts/smoke-mcp-bundle.mjs`, which starts the bundled server exactly as an installed
extension does and fails the build unless it answers `initialize`. It must not need a Deck —
resolving and reading the script files is proof enough. It must run as part of the build or test
pipeline, not only when someone remembers.

**Requirements.** Test at minimum: a capture result produces both a text and an image block; the
base64 decodes to the bytes on disk; an oversized image is downscaled rather than dropped; a
dropped or failed image is stated in the text; a capture failure still returns a useful text
error and no malformed image block; and the packaged-resolution check fails when the scripts are
absent and passes when they are present. Add new test files to the `test` script in
`mcp-server/package.json`. Do not touch `docs/ROADMAP.md`, `CHANGELOG.md`, `docs/MCP_TOOLS.md` or
`AGENTS.md`.

**Report:** where the attachment mechanism lives and how the next tool would use it, the size cap
and downscale behaviour you chose and why, what the packaged check actually covers, test names,
and the honesty paragraph — including whether your tests would catch a fourth variant of the
resolution bug.
