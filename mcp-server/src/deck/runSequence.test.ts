/**
 * Tests for the sequence runner.
 *
 * Two halves, for two different reasons.
 *
 * The cycle detector is pure, so it gets the hard coverage here. It is also the
 * only genuinely new judgement in this feature -- everything else composes tools
 * that already have tests -- and it is the half most able to be subtly wrong in
 * a way nobody notices, because a false cycle report looks exactly like a real
 * finding.
 *
 * The runner's own paths can only be tested down to the first press, because a
 * real press needs the bridge board. That is fine: the paths worth pinning
 * without hardware are the refusals, and those are exactly the ones that must
 * never quietly degrade. The happy path is verified on a Deck.
 */
/*
 * Hardware guard. The bridge board is plugged into the machine that runs this
 * suite, so any test reaching pressButton would move the ring on a real Deck.
 * Set before anything runs, and never overridden if the caller set it already.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";

import { startFakeCdp, focusedPage, unfocusedPage } from "./__testutil__/fakeCdp.js";
import { runSequence, findCycle, judgeVisibility, Visit } from "./runSequence.js";
import type { Visibility } from "./readFocus.js";
import type { PressOptions, PressResult } from "./pressButton.js";

/** Build a visit list from labels; the key is the label unless one is given. */
function visits(...spec: Array<string | [string, string | null]>): Visit[] {
  return spec.map((s, i) => {
    const [label, key] = Array.isArray(s) ? s : [s, s];
    return {
      step: i,
      key,
      label,
      el: key
        ? {
            selector: null,
            selectorVerified: false,
            tag: "BUTTON",
            id: null,
            classes: [],
            ariaLabel: null,
            text: label,
            ownerText: label,
            rect: null,
          }
        : null,
    };
  });
}

// --------------------------------------------------------------------------
// Cycle detection
// --------------------------------------------------------------------------

test("a straight path reports no cycle", () => {
  assert.equal(findCycle(visits("Retry", "Show details", "chip 1", "chip 2")), null);
});

test("a loop that never escapes is reported as not escaped", () => {
  // The 2026-08-23 regression's shape: Up from the strip header fed focus back
  // into the strip, and nothing above it was ever reached again.
  const c = findCycle(visits("strip header", "strip ladder", "strip header", "strip ladder"));
  assert.ok(c);
  assert.equal(c.key, "strip header");
  assert.deepEqual(c.seenAt, [0, 2]);
  assert.deepEqual(c.loop, ["strip header", "strip ladder", "strip header"]);
  assert.equal(c.escaped, false);
  assert.equal(c.stepsAfterLoop, 1);
});

test("a loop the ring later escapes is reported as escaped", () => {
  const c = findCycle(visits("chip 1", "chip 2", "chip 1", "Retry"));
  assert.ok(c);
  assert.equal(c.escaped, true, "Retry was new, so the ring got out");
});

test("a cycle at the very end does not claim the ring was trapped", () => {
  // Nothing ran after the loop closed, so whether it could have escaped is
  // untested. Reporting escaped:false here without stepsAfterLoop would be a
  // manufactured finding.
  const c = findCycle(visits("a", "b", "a"));
  assert.ok(c);
  assert.equal(c.escaped, false);
  assert.equal(c.stepsAfterLoop, 0, "the caller needs this to tell 'trapped' from 'run ended'");
});

test("unowned focus never counts as a repeat visit", () => {
  // Two reads with no gpfocus owner are not "the same element twice" -- they are
  // two absences. Treating them as a cycle would fire on every plugin open.
  assert.equal(findCycle(visits(["nothing", null], ["nothing", null])), null);
});

test("the outermost loop is reported, not whichever repeat is found first", () => {
  // "a" repeats across the whole run and "b" repeats inside it. The useful
  // report is the big loop.
  const c = findCycle(visits("a", "b", "c", "b", "a"));
  assert.ok(c);
  assert.equal(c.key, "a");
  assert.deepEqual(c.loop, ["a", "b", "c", "b", "a"]);
});

test("a press that moves nothing is not a cycle", () => {
  // Found on hardware: walking into the bottom of the bonsAI panel, three no-op
  // presses in a row produced four identical reads. That is a dead end, already
  // reported per step as moved:false -- calling it a loop is noise dressed up as
  // a finding. A real loop has to leave and come back.
  assert.equal(findCycle(visits("Save chat", "Save chat", "Save chat", "Save chat")), null);
});

test("a dead end reached after real movement is still not a cycle", () => {
  assert.equal(findCycle(visits("Retry", "Show diagnostics", "Save chat", "Save chat")), null);
});

test("the same label at a different position is a different element", () => {
  // Two distinct chips can both render the text "Retry"; identity is the key,
  // not the label.
  assert.equal(findCycle(visits(["Retry", "sel:#one"], ["Retry", "sel:#two"])), null);
});

// --------------------------------------------------------------------------
// Labelling of Decky controls
// --------------------------------------------------------------------------

test("a Decky toggle is matched and named by its ancestor's label", async () => {
  // Found on hardware 2026-08-26 running FOCUS-GRAPH-DEV-KB-01. Decky's
  // ToggleField puts the ring on an inner div with no text of its own; the
  // label sits four parents up. Matching only the focused element's own text
  // reported "never reached" for two controls the ring was demonstrably on,
  // which is a false negative on the most common control type in a Decky
  // settings page.
  const togglePage = {
    hasGpfocus: true,
    elementCount: 300,
    gpfocus: {
      selector: null,
      selectorVerified: false,
      tag: "DIV",
      id: null,
      classes: ["Focusable"],
      ariaLabel: null,
      text: "",
      ownerText: "Hybrid retrieval (meaning search)On, the knowledge base ranks",
      rect: null,
    },
    gpfocusWithin: [],
    activeElement: null,
    agree: false,
    quickAccessTab: "999",
    deckyPluginRoot: true,
  };
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => togglePage);
  try {
    const r = await runSequence({
      steps: [{ press: "NOT_A_BUTTON" }],
      mustReachText: ["Hybrid retrieval", "Nonexistent control"],
      cdpUrl: fake.base,
      writeEvidence: false,
    });
    assert.deepEqual(r.neverReached, ["Nonexistent control"]);
    // And the run log names the control instead of showing an anonymous <DIV>.
    assert.match(r.visited[0], /^<DIV> in "Hybrid retrieval/);
  } finally {
    await fake.close();
  }
});

test("mustReachText is not satisfied by text belonging to something else", async () => {
  /*
   * P1-10's third copy. matchesText used to concatenate text + ariaLabel +
   * ownerText into one haystack, so any string anywhere above the ring counted
   * as reached -- and with an icon-only control that inherited a whole pane,
   * every label in that pane "was reached". `neverReached` is the field a whole
   * unattended run is trusted on, so a false empty there is a run that reports
   * a reachability guarantee it never checked.
   *
   * Here the ring is on a control genuinely named "Retry"; "Send" appears only
   * in the surrounding container's text. "Retry" must be reached, "Send" must
   * not.
   */
  const nestedPage = {
    hasGpfocus: true,
    elementCount: 300,
    gpfocus: {
      selector: null,
      selectorVerified: false,
      tag: "BUTTON",
      id: null,
      classes: ["Focusable"],
      ariaLabel: null,
      text: "Retry",
      ownerText: "Send to bonsAIRetryCopy",
      label: "Retry",
      labelSource: "text",
      labelOverflow: false,
      rect: null,
    },
    gpfocusWithin: [],
    activeElement: null,
    agree: false,
    quickAccessTab: "999",
    deckyPluginRoot: true,
  };
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => nestedPage);
  try {
    const r = await runSequence({
      steps: [{ press: "NOT_A_BUTTON" }],
      mustReachText: ["Retry", "Send"],
      cdpUrl: fake.base,
      writeEvidence: false,
    });
    assert.deepEqual(r.neverReached, ["Send"], '"Send" is the container\'s text, not a control the ring reached');
  } finally {
    await fake.close();
  }
});

// --------------------------------------------------------------------------
// Visibility (plan 06): a stop the ring is on and a person cannot see
// --------------------------------------------------------------------------

const COVERED: Visibility = {
  verdict: "covered",
  visiblePercent: 0,
  coveredBy: "div.bonsai-main-tab-dock > button.Focusable.bonsai-chip",
  clippedBy: null,
  points: { visible: 0, covered: 9, clipped: 0, offscreen: 0 },
};
const VISIBLE: Visibility = {
  verdict: "visible",
  visiblePercent: 100,
  coveredBy: null,
  clippedBy: null,
  points: { visible: 9, covered: 0, clipped: 0, offscreen: 0 },
};

test("a covered stop is shouted but does not fail the step unless requireVisible is set", () => {
  // The one-release grace period: measured, reported, counted -- not failed.
  const reportOnly = judgeVisibility(COVERED, false);
  assert.equal(reportOnly.visible, false);
  assert.equal(reportOnly.visibleOk, true, "report-only for this release");
  assert.match(reportOnly.note, /FOCUSED BUT COVERED by div\.bonsai-main-tab-dock/);
  assert.doesNotMatch(reportOnly.note, /failing the step/);

  const required = judgeVisibility(COVERED, true);
  assert.equal(required.visibleOk, false, "requireVisible fails a covered stop the way expect fails a wrong one");
  assert.match(required.note, /failing the step because requireVisible is set/);
});

test("a visible stop passes quietly either way", () => {
  assert.deepEqual(judgeVisibility(VISIBLE, false), { visible: true, visibleOk: true, note: "" });
  assert.deepEqual(judgeVisibility(VISIBLE, true), { visible: true, visibleOk: true, note: "" });
});

test("an unmeasured stop under requireVisible fails rather than rounding up to seen", () => {
  const j = judgeVisibility(null, true);
  assert.equal(j.visible, null);
  assert.equal(j.visibleOk, false);
  assert.match(j.note, /could not be measured/);
  // And without the requirement, unmeasured is simply unmeasured.
  assert.deepEqual(judgeVisibility(null, false), { visible: null, visibleOk: true, note: "" });
});

test("a run that starts on a covered control counts it and says so in the summary", async () => {
  /*
   * The starting read is a stop too. Here the ring begins on a control behind
   * the dock; the step's press cannot be delivered (hardware guard), so the
   * only stop is step 0 -- and it must still be counted and shouted, with the
   * report-only caveat, because a suite that never looks at per-step fields
   * reads the summary.
   */
  const coveredPage = { ...focusedPage, visibility: COVERED };
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => coveredPage);
  try {
    const r = await runSequence({
      steps: [{ press: "NOT_A_BUTTON" }],
      cdpUrl: fake.base,
      writeEvidence: false,
    });
    assert.equal(r.stopsFocusedButNotVisible, 1);
    assert.match(r.notVisibleStops[0], /^step 0: <BUTTON> "bonsAI" COVERED by div\.bonsai-main-tab-dock/);
    assert.match(r.summary, /1 stop\(s\) FOCUSED BUT NOT VISIBLE/);
    assert.match(r.summary, /report-only -- pass requireVisible/);
    // A step that never executed has no verdict -- not a "visible" one.
    assert.equal(r.steps[0].visibility, null);
    assert.equal(r.steps[0].visible, null);
  } finally {
    await fake.close();
  }
});

test("a payload from before the oracle existed counts as unmeasured, not as visible", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => focusedPage);
  try {
    const r = await runSequence({
      steps: [{ press: "NOT_A_BUTTON" }],
      cdpUrl: fake.base,
      writeEvidence: false,
    });
    assert.equal(r.stopsFocusedButNotVisible, 0);
    assert.doesNotMatch(r.summary, /NOT VISIBLE/);
  } finally {
    await fake.close();
  }
});

// --------------------------------------------------------------------------
// Runner paths reachable without a bridge board
// --------------------------------------------------------------------------

test("an empty step list is refused rather than reported as a pass", async () => {
  const r = await runSequence({ steps: [], writeEvidence: false });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /No steps given/);
});

test("an unreachable Deck stops before any press", async () => {
  const r = await runSequence({
    steps: [{ press: "DOWN" }],
    cdpUrl: "http://127.0.0.1:1",
    writeEvidence: false,
  });
  assert.equal(r.ok, false);
  assert.equal(r.ranSteps, 0);
  assert.equal(r.fidelity, null);
  assert.match(r.summary, /could not read focus before the run started/);
});

test("no gpfocus owner at the start stops the run rather than pressing blind", async () => {
  // acquireFocus is on by default, so this still tries to place the ring --
  // but the suite's hardware guard refuses that press too, so the net effect
  // for this test is unchanged: no readable focus, no steps run.
  const fake = await startFakeCdp(["SharedJSContext"], () => unfocusedPage);
  try {
    const r = await runSequence({
      steps: [{ press: "DOWN" }],
      cdpUrl: fake.base,
      writeEvidence: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.ranSteps, 0);
    assert.equal(r.acquired, false, "the placing press could not be delivered either");
    assert.match(r.reason ?? "", /gpfocus marker not found/);
  } finally {
    await fake.close();
  }
});

test("acquireFocus:false leaves an unowned ring alone and says what to do", async () => {
  // Mirrors walkTo's own test for this: with acquiring switched off, an
  // unowned ring must refuse rather than press blind, and the message has to
  // point at the way forward instead of just restating the oracle's reason.
  const fake = await startFakeCdp(["SharedJSContext"], () => unfocusedPage);
  try {
    const r = await runSequence({
      steps: [{ press: "DOWN" }],
      acquireFocus: false,
      cdpUrl: fake.base,
      writeEvidence: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.ranSteps, 0);
    assert.equal(r.acquired, false);
    assert.match(r.summary, /acquireFocus does that automatically/);
  } finally {
    await fake.close();
  }
});

test("an unowned ring is acquired before the run starts, instead of refusing outright", async () => {
  // The bug this fixes: runSequence used to refuse from the exact state every
  // run naturally starts in -- right after a plugin opens or an Ask finishes
  // (doc 03) -- forcing a wasted deck_pressButton before every call. Here the
  // acquire press is stubbed to succeed (acquirePressFn is a test-only seam;
  // the suite's hardware guard forbids a real one), which lets the run get
  // past the old refusal and reach its first real step. That step's own press
  // is NOT stubbed, so it still hits the hardware guard -- proving this test
  // exercises the acquire path specifically, not a general bypass of it.
  const fake = await startFakeCdp(["SharedJSContext"], (_title, idx) =>
    idx === 0 ? unfocusedPage : focusedPage,
  );
  const stubPress = async (opts: PressOptions): Promise<PressResult> => ({
    ok: true,
    fidelity: "steam-routed",
    method: "usb-hid:bridge",
    buttons: opts.buttons,
    holdMs: opts.holdMs ?? 80,
  });
  try {
    const r = await runSequence({
      steps: [{ press: "DOWN", label: "first step" }],
      cdpUrl: fake.base,
      writeEvidence: false,
      acquirePressFn: stubPress,
    });
    assert.equal(r.acquired, true, "the unowned ring should have been placed before the run started");
    assert.equal(r.ranSteps, 1, "the run got past the old refusal and attempted its first step");
    assert.equal(r.reason, undefined, "the run-level refusal must not fire once acquisition succeeded");
    // The step itself still refuses -- the bridge board is disabled for this
    // whole suite -- but that is assertFocusMove's own real press failing, a
    // different and expected refusal from the acquire press above.
    assert.match(r.steps[0].reason ?? "", /DPS_NO_BRIDGE/);
  } finally {
    await fake.close();
  }
});

test("a press that cannot be delivered fails the step and stops the run", async () => {
  // Focus reads fine; the press is what fails. The run must not report progress.
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => focusedPage);
  try {
    const r = await runSequence({
      steps: [
        { press: "NOT_A_BUTTON", label: "bad" },
        { press: "DOWN", label: "never runs" },
      ],
      cdpUrl: fake.base,
      writeEvidence: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.ranSteps, 1, "stopOnFailure means the second step never ran");
    assert.equal(r.totalSteps, 2);
    assert.equal(r.steps[0].pass, false);
    assert.equal(r.steps[0].moved, false);
    assert.match(r.steps[0].diagnosis, /no press was delivered/);
    assert.match(r.summary, /stopped after 1/);
  } finally {
    await fake.close();
  }
});

test("mustReachText reports what the run never landed on", async () => {
  // The starting element is recorded even when the first press fails, so the
  // text matcher has something real to work against.
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => focusedPage);
  try {
    const r = await runSequence({
      steps: [{ press: "NOT_A_BUTTON" }],
      mustReachText: ["bonsAI", "Retry"],
      cdpUrl: fake.base,
      writeEvidence: false,
    });
    assert.deepEqual(r.visited, ['<BUTTON> "bonsAI"']);
    assert.deepEqual(r.neverReached, ["Retry"], "bonsAI was the starting element; Retry never appeared");
    assert.match(r.summary, /never reached: Retry/);
  } finally {
    await fake.close();
  }
});

test("evidence is off by request and the run still returns its findings", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => focusedPage);
  try {
    const r = await runSequence({
      steps: [{ press: "NOT_A_BUTTON" }],
      cdpUrl: fake.base,
      writeEvidence: false,
    });
    assert.equal(r.evidenceFile, null);
    assert.equal(r.steps.length, 1);
  } finally {
    await fake.close();
  }
});
