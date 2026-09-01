# Plan 06 — The visibility oracle, and a free-play sweep that emulates a user

**Raised 2026-08-31 by the maintainer, after the second bug in two days that every automated
check passed and a human found in thirty seconds.** Their words: *"Too many times this happens
and I just burn tokens to fix something that should've never passed automated QA."*

## The incident that defines the gap

bonsAI has a bottom-pinned dock (preset chips + Ask bar) that covers the bottom ~246px of the
QAM scroll pane. A user D-pads down a long reply to reach the buttons at its end. Steam scrolls
the focused control "into view" — into the *pane*, which Steam owns — but Steam knows nothing
about the dock, so the control lands focused and fully hidden behind the chips
(`bonsAI recordings/DeckRecord_20260831_193132_game.mkv`).

Every DPS focus tool reported this as **success**, and by their own definitions they were right:

- `deck_walkTo` → `found: true, matched: "Show details"` — the ring WAS on it.
- `deck_runSequence` → `moved: true, matched: true` on every step.
- `deck_readFocus` → correct selector, correct label, correct rect.

Nothing anywhere asked *"could a person see this control?"* Focus and visibility are two
different facts, and the rig measures only the first. That is the entire gap — not flaky
hardware, not Steam weirdness, not an exotic interaction. The same blindness class produced the
2026-08-30 bug where the panel's last 50px were clipped by an `overflow: hidden` ancestor:
every element was present, focusable, asserted — and unreachable by eye.

**The maintainer's expectations are not too high.** Both facts are cheaply measurable from the
DOM the tools already evaluate in. No screenshot pipeline, no pixel diffing, no live video feed
is needed for this class.

## Part A — the visibility verdict (quantify both, distinguish both)

Every focus read gains a second measurement next to `gpfocus`:

```jsonc
"visibility": {
  "verdict": "visible" | "partial" | "covered" | "offscreen",
  "visiblePercent": 0,          // sampled, see below
  "coveredBy": ".bonsai-main-tab-dock"   // top-most coverer when not visible
}
```

**Mechanism** — in the same page-eval that already reads the focused element's rect:

1. Take a 3×3 grid of sample points across the element's rect (inset ~2px from the edges).
2. For each point, `document.elementFromPoint(x, y)`:
   - the element itself, or a descendant → that point is **visible**;
   - any other element → **covered**, record the hit's selector;
   - point outside the viewport (or rect clipped to nothing) → **offscreen**.
3. `visiblePercent` = visible points / 9. Verdict: all → `visible`, none-with-coverer →
   `covered`, none-off-viewport → `offscreen`, else `partial`. `coveredBy` = the most frequent
   non-self hit.

Two properties make `elementFromPoint` the right instrument here:

- It respects `pointer-events: none`, so decorative scrims and gradients (which should carry it
  anyway) do not register as coverers — the bonsAI dock's fade already behaves this way, while
  the dock itself, being interactive, correctly registers.
- It sees stacking exactly as the compositor resolves it — sticky overlays, z-index, transforms
  — without DPS hard-coding knowledge of any particular plugin's dock.

**Where the verdict surfaces:**

- `deck_readFocus`: always included, informational.
- `deck_walkTo`: the found-stop's verdict in the result; `found: true` with
  `visibility.verdict !== "visible"` is the exact signature of this bug class, so the summary
  line must say it out loud ("found, but COVERED by .bonsai-main-tab-dock").
- `deck_runSequence`: per-step verdict in the step record, and a new summary counter
  `stopsFocusedButNotVisible`. New optional step/global field `requireVisible` fails a step the
  way `expect` does. **Default stays report-only for one release** so existing suites don't
  break, then flips to fail-by-default — a covered stop should never again read as a pass.

**Honest limits, stated up front:** this is a DOM hit-test, not eyes. It cannot see a control
rendered in the wrong color, a 1px-tall flexbox collapse, or gamescope compositing artifacts.
Those still need screenshots (`deck_captureScreenshot`) or a human. The claim is narrower and
worth exactly this much: *focused-but-occluded and focused-but-offscreen can never again pass
silently* — which covers both of the last two incidents.

## Part B — the free-play sweep (emulate what a user does)

The maintainer found the bug by "just using the thing": scroll around, walk down, try the
buttons. That behavior is scriptable with the machinery `deck_runSequence` already has —
what's missing is a verb that does it without a hand-written step list.

**New tool `deck_sweep`:**

- Input: a direction pattern (default: `DOWN` until the ring stops moving or cycles, then `UP`
  back; optional `LB`/`RB` lanes to repeat the walk per carousel position), a press budget,
  and the existing safety rails (only direction presses — the sweep NEVER presses A/B, exactly
  like `deck_walkTo`, so it cannot activate anything).
- At **every** stop it records what the tools now know how to measure: label, selector, rect,
  scroll position of the pane, and the Part A visibility verdict.
- Output: a `runs/` report with per-stop rows plus a summary made for diffing:
  stops visited, unlabeled stops, focus cycles (already detected), **stops focused-but-covered**,
  stops that never became reachable.

**"Results vs expected", concretely:** the report is deterministic for a given UI state, so a
consumer commits a baseline (`runs/sweep-main-tab.expected.json`) and QA becomes
*run sweep → diff against baseline*. A new stop, a lost stop, a stop that went from visible to
covered — all show up as a diff line, no assertion authored per control. This is the cheap,
non-visual version of the maintainer's "d-pad spam and record results vs expected", and it is
what would have caught 2026-08-31 unattended: the sweep's summary would have read
`stopsFocusedButNotVisible: 3` on the first run after the dock shipped.

**Escalation path if the DOM ever lies** (deferred, not needed for this class): pair each sweep
stop with `deck_captureScreenshot` and diff crops around the focused rect. Expensive, brittle to
theming, and so far unnecessary — every incident to date was DOM-detectable. Build it only when
a bug is found that the hit-test called visible.

## Part C — consumer adoption (bonsAI, until the sweep ships)

Nothing in Part A/B blocks doing this today by hand: after any UI change on Main, walk the pane
one press at a time and, at each stop, `deck_readPage` the focused element's rect against the
dock's top plus an `elementFromPoint` probe. bonsAI has adopted this as standing row
**QA-FREE-PLAY-01** (its testing-manual), which is both the interim practice and the acceptance
test for `deck_sweep`: when the tool ships, that row becomes one call.

## Effort and order

| Piece | Stars | Notes |
|---|---|---|
| Part A verdict in readFocus/walkTo/runSequence | ★★ | One page-eval extension + result plumbing + tests. Highest value per line in this plan. |
| Part B `deck_sweep` | ★★ | Composition of existing runSequence internals + report writer. |
| Fail-by-default flip for covered stops | ★ | One release after A, with changelog notice. |
| Screenshot escalation | ★★★★ | Deferred until the hit-test is caught lying. |

Order: A, then B. A alone already turns every existing walk in every consumer suite into an
occlusion detector.
