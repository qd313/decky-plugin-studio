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
import { test } from "node:test";
import assert from "node:assert/strict";

import { startFakeCdp, focusedPage, unfocusedPage } from "./__testutil__/fakeCdp.js";
import { runSequence, findCycle, Visit } from "./runSequence.js";

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
  const fake = await startFakeCdp(["SharedJSContext"], () => unfocusedPage);
  try {
    const r = await runSequence({
      steps: [{ press: "DOWN" }],
      cdpUrl: fake.base,
      writeEvidence: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.ranSteps, 0);
    assert.match(r.reason ?? "", /gpfocus marker not found/);
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
