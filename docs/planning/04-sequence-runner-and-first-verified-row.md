# 04 — The sequence runner, and the first QA row it settled

Built and run 2026-08-26. Two things landed together: `deck_runSequence`, which drives a list of
presses unattended and reports what Steam's nav graph did at each one, and the first use of it —
re-running a bonsAI QA row that had been stuck for three days because nobody could reach the state
it tested.

---

## 1. What was missing

The oracle (`deck_readFocus`), the press (`deck_pressButton`) and the single-step assertion
(`deck_assertFocusMove`) all worked. What did not exist was a way to run more than one of them
without a person in the loop.

Every press was its own tool call: a fresh SSH tunnel at ~350 ms of pure setup, a result a human
read, and a decision a human made before the next press. Twenty presses meant twenty round trips
through a person. That is the whole distance between "the rig can press and read" and plan 19 § 4's
bar, *one command, nobody touches the Deck*.

`deck_openPlugin` had the same shape of gap from the other end: it returned a checklist and said
"Deck UI cannot be automated in v1".

---

## 2. What the runner adds

Three things beyond looping over `assertFocusMove`:

**One tunnel per run.** `assertFocusMove` already took a `cdpUrl` so a caller could own the tunnel.
The runner is that caller. A 9-step run costs one tunnel, not nine.

**Cycle detection.** A focus graph can fail by trapping the ring in a region with no way out, while
every individual press reports `moved: true, matched: true`. No per-step assertion can see it,
because the defect is a property of the *path*, not of any one edge. So the runner tracks the
identity of every element the ring lands on and reports when it returns to one.

The report is deliberately a measurement, not a verdict. It names the repeated element, the loop,
whether anything new was reached afterwards, and **how many steps ran after the loop closed** —
because `escaped: false` with zero steps after means the run ended, not that the ring was trapped,
and collapsing those two would manufacture findings.

**An evidence file.** A run nobody watched has to leave something a person can read later.

Deliberately absent: retries. If a press does not land, that is the finding. Re-pressing until it
works is how a flaky focus graph gets marked green.

### `deck_openPlugin` now drives Steam

Replacing the checklist with a canned button sequence would have been worse than the checklist. A
fixed "GUIDE+A, then Down four times, then A" is a guess about a menu whose layout depends on the
Steam build, the user's tabs, and where the ring happened to be — run it blind and it activates
something in an unrelated menu. So it searches instead, under two rules:

- **Only the D-pad while searching.** Direction presses move the ring and nothing else.
- **A is pressed only when the read taken immediately before it confirms** the ring is on a control
  labelled with the plugin's name. Not "should be by now" — confirmed, on that read.

Out of budget means refuse, and hand back the old checklist plus the controls actually seen.

---

## 3. First hardware run, and what it corrected

The first live run walked 18 D-pad presses down the bonsAI panel and mapped the focus order. It also
found a flaw in the tool itself: at the bottom of the panel three presses moved nothing, and the
detector reported four identical reads as a cycle. That is a dead end, already reported per step as
`moved: false` — calling it a loop is noise dressed up as a finding.

Fixed the same session: a loop now has to *leave and come back*, so there must be a different
element strictly between the two visits. Two tests pin it, both written from the hardware run.

Worth noting how it surfaced: the pure unit tests were green and stayed green. Only a real device
produced the input shape that made the rule wrong.

---

## 4. The row it settled: bonsAI CONTEXT-LADDER-03

The row had a specific problem recorded in bonsAI's `testing.md`: *"The one-way-carousel claim this
row exists for is still unverified — the trap prevented reaching the state that tests it."* A fix
had shipped 2026-08-23, regressed the same day, and been fixed again. Nobody had confirmed any of it
on device.

Both cases were re-run by script with nobody at the Deck, using real controller presses through the
ESP32 bridge and focus read from `gpfocus` rather than `activeElement`.

**Details open.** Down from the utility row entered the ladder at *Chip 1 of 6*. Right five times
stepped to *Chip 6 of 6* — focus never moved, because the ladder is a single focusable that tracks a
chip index internally. One more Right left it onto *Session context (1 turn)*. **Up returned to the
ladder at Chip 6.** Up five more times stepped back down the chips, and one more escaped to *Retry*.
8/8 asserted steps passed.

**Details collapsed.** The 2026-08-23 trap condition was reproduced exactly — strip expanded, one
`.bonsai-chip-ladder` mounted, `inStrip: true`, no inline ladder to compete with it. The ring
climbed **out** to *Retry*. The cycle detector saw the strip-header revisit and correctly reported
it as escaped rather than trapped.

**Verdict: the one-way-carousel claim does not reproduce.** The fix works.

### The part that was actually missing

`focusDownFromReplyUtilityRow` and `focusUpFromBelowContextChipLadder` — the two halves of the round
trip the row exists for — had **no tests at all**. The fix was real but unpinned; anything could
have undone it and the suite would have stayed green, which is exactly how it regressed once
already.

Four cases were added to bonsAI's `liveTurnFocusGraph.test.ts`, and the strip-trap one was confirmed
to fail without the fix by reverting it locally:

```
× Up from an expanded session strip climbs out to the utility row, not back into the strip
  → expected 'strip-ladder' to be 'stop-retry'
```

### Characterised, not filed

Two asymmetries turned up that look like the design rather than defects, recorded so nobody
re-discovers them:

- *Show diagnostics* is on the Down path but skipped going Up. It stays reachable from above, so it
  is not orphaned.
- Re-entering the ladder from below lands on Chip 6, not Chip 1, so escaping upward from there costs
  six presses.

Neither is filed as a bug. The rig's job was to produce the measurement; whether the behaviour is
worth changing is a judgement, and [doc 03](03-plugin-open-leaves-focus-unowned.md) is the standing
reminder of what happens when the tool makes that call on its own.

---

## 5. Status

**Runner: done and in the registry** as `deck_runSequence`, with `deck_openPlugin` upgraded to drive
Steam. 15 tests, no Deck required — the cycle detector is pure and gets the hard coverage, and the
runner's own refusal paths are pinned against an in-process fake CDP server.

**bonsAI M4: two of three parts.** Reproduced by script ✅. Locked by a check that fails without the
fix ✅. Not fixed by the rig ✗ — the claim did not reproduce, so there was nothing to fix. A full M4
still needs a D-pad bug that is broken *now*.

**bonsAI M3: the navigation half.** Nine asserted steps ran unattended. Plan 19 § 4 also wants the
stream start/stop bracket and a live-Ask reply signal; neither is built.
