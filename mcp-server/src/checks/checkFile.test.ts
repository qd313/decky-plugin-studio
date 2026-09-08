/**
 * Tests for checks.checkFile -- the pure half of the feature: normalizing a
 * tool result into what a check compares, and diffing a saved check against
 * a fresh one. Nothing here touches a filesystem or a Deck; fixtures are
 * hand-built SweepReport / RunSequenceResult objects, exactly the "fake the
 * run layer entirely" the feature asks for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CHECK_FORMAT_VERSION,
  CheckFile,
  CheckFileError,
  diffCheck,
  normalizeRunSequenceResult,
  normalizeSweepResult,
  validateCheckFile,
} from "./checkFile.js";
import type { SweepReport, SweepStop, SweepLeg } from "../deck/sweep.js";
import type { RunSequenceResult, StepResult } from "../deck/runSequence.js";
import type { Visibility } from "../deck/readFocus.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function visibility(overrides: Partial<Visibility> = {}): Visibility {
  return {
    verdict: "visible",
    visiblePercent: 100,
    coveredBy: null,
    clippedBy: null,
    points: { visible: 9, covered: 0, clipped: 0, offscreen: 0 },
    ...overrides,
  };
}

function sweepStop(overrides: Partial<SweepStop> = {}): SweepStop {
  return {
    index: 0,
    lane: 0,
    leg: "start",
    press: null,
    tag: "BUTTON",
    label: "Ask",
    labelSource: "text",
    selector: "sel:#ask",
    rect: { x: 10, y: 20, w: 100, h: 40 },
    scrollTop: 0,
    visibility: visibility(),
    focusKey: "sel:#ask",
    ...overrides,
  };
}

function sweepReport(stops: SweepStop[], legs: SweepLeg[] = []): SweepReport {
  return {
    tool: "deck_sweep",
    pattern: { direction: "DOWN", returnTrip: true, lanes: 0, laneButton: "RB", budget: 80, stallLimit: 2 },
    ok: true,
    stopped: false,
    totals: {
      stopsRecorded: stops.length,
      stopsVisited: new Set(stops.map((s) => s.focusKey)).size,
      unlabeledStops: stops.filter((s) => !s.label).length,
      cycles: legs.filter((l) => l.cycle).length,
      stopsFocusedButNotVisible: stops.filter((s) => s.visibility && s.visibility.verdict !== "visible").length,
      presses: Math.max(0, stops.length - 1),
      legs: legs.length,
    },
    notVisible: stops
      .filter((s) => s.visibility && s.visibility.verdict !== "visible")
      .map((s) => ({
        index: s.index,
        lane: s.lane,
        leg: s.leg,
        label: s.label,
        verdict: s.visibility!.verdict,
        visiblePercent: s.visibility!.visiblePercent,
        coveredBy: s.visibility!.coveredBy,
        clippedBy: s.visibility!.clippedBy,
      })),
    legs,
    stops,
  };
}

function sweepCheck(stops: SweepStop[], legs: SweepLeg[] = [], name = "carousel-down"): CheckFile {
  return {
    formatVersion: CHECK_FORMAT_VERSION,
    name,
    tool: "deck_sweep",
    savedAt: "2026-09-01T00:00:00.000Z",
    buildHash: "sha256:aaaa",
    buildHashInputs: ["dist/index.js"],
    runOptions: {
      direction: "DOWN",
      returnTrip: true,
      lanes: 0,
      laneButton: "RB",
      budget: 80,
      stallLimit: 2,
      acquireFocus: true,
    },
    expected: normalizeSweepResult(sweepReport(stops, legs)),
  };
}

function step(overrides: Partial<StepResult> = {}): StepResult {
  return {
    index: 1,
    label: "step 1",
    press: ["DOWN"],
    expect: null,
    ok: true,
    pass: true,
    moved: true,
    matched: null,
    from: '<BUTTON> "Ask"',
    to: '<BUTTON> "Show details"',
    focusKey: "sel:#details",
    visibility: visibility(),
    visible: true,
    settled: true,
    settleMs: 40,
    diagnosis: "moved and settled",
    ...overrides,
  };
}

function runSequenceResult(steps: StepResult[]): RunSequenceResult {
  const passed = steps.filter((s) => s.pass).length;
  return {
    ok: passed === steps.length,
    fidelity: "steam-routed",
    steps,
    ranSteps: steps.length,
    totalSteps: steps.length,
    passed,
    failed: steps.length - passed,
    visited: steps.map((s) => s.to),
    cycle: null,
    neverReached: [],
    stopsFocusedButNotVisible: steps.filter((s) => s.visibility && s.visibility.verdict !== "visible").length,
    notVisibleStops: [],
    stopped: false,
    evidenceFile: null,
    durationMs: 1234,
    acquired: false,
    summary: `${passed}/${steps.length} steps passed`,
  };
}

function sequenceCheck(steps: StepResult[], name = "open-settings"): CheckFile {
  return {
    formatVersion: CHECK_FORMAT_VERSION,
    name,
    tool: "deck_runSequence",
    savedAt: "2026-09-01T00:00:00.000Z",
    buildHash: "sha256:bbbb",
    buildHashInputs: ["dist/index.js"],
    runOptions: { steps: [{ press: "DOWN" }], stopOnFailure: true, mustReachText: [], requireVisible: false, acquireFocus: true },
    expected: normalizeRunSequenceResult(runSequenceResult(steps)),
  };
}

// ---------------------------------------------------------------------------
// Normalization: which fields survive
// ---------------------------------------------------------------------------

test("normalizeSweepResult drops the render-timing measurement but keeps the categorical visibility facts", () => {
  const s = sweepStop({ visibility: visibility({ verdict: "covered", visiblePercent: 37, coveredBy: "div.dock" }) });
  const expected = normalizeSweepResult(sweepReport([s]));
  assert.deepEqual(expected.stops[0].visibility, { verdict: "covered", coveredBy: "div.dock", clippedBy: null });
  assert.equal("visiblePercent" in expected.stops[0].visibility!, false);
  assert.equal("points" in expected.stops[0].visibility!, false);
  assert.equal("visiblePercent" in expected.notVisible[0], false);
});

test("normalizeRunSequenceResult drops timing and prose fields but keeps the landing facts", () => {
  const expected = normalizeRunSequenceResult(runSequenceResult([step({ settleMs: 999, settled: false, diagnosis: "slow this time" })]));
  const s = expected.steps[0] as unknown as Record<string, unknown>;
  assert.equal("settleMs" in s, false);
  assert.equal("settled" in s, false);
  assert.equal("diagnosis" in s, false);
  assert.equal("reason" in s, false);
  assert.equal(s.to, '<BUTTON> "Show details"');
  assert.equal(s.focusKey, "sel:#details");
});

test("normalizeRunSequenceResult's ok ignores a killswitch stop -- that is an operator fact, not a landing", () => {
  const result = runSequenceResult([step()]);
  const stoppedByHuman: RunSequenceResult = { ...result, ok: false, stopped: true, reason: "KILLSWITCH" };
  assert.equal(normalizeRunSequenceResult(result).ok, true);
  assert.equal(normalizeRunSequenceResult(stoppedByHuman).ok, true, "same steps, same passed/total -- the stop is not a landing change");
});

// ---------------------------------------------------------------------------
// diffCheck: the behaviours the feature is graded on
// ---------------------------------------------------------------------------

test("an unchanged replay reports no diff", () => {
  const stops = [sweepStop(), sweepStop({ index: 1, label: "Show details", selector: "sel:#details", focusKey: "sel:#details", leg: "DOWN", press: "DOWN" })];
  const check = sweepCheck(stops);
  const outcome = diffCheck(check, check.buildHash, sweepReport(stops));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.buildHashMatch, true);
  assert.deepEqual(outcome.diffs, []);
  assert.match(outcome.summary, /no diff/);
});

test("a changed landing is named specifically: which stop, expected versus actual", () => {
  const before = [sweepStop({ index: 0, label: "Ask" })];
  const check = sweepCheck(before);
  const after = [sweepStop({ index: 0, label: "Ask (renamed)" })];
  const outcome = diffCheck(check, check.buildHash, sweepReport(after));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.diffs.length, 1);
  assert.equal(outcome.diffs[0].path, "stops[0].label");
  assert.equal(outcome.diffs[0].expected, "Ask");
  assert.equal(outcome.diffs[0].actual, "Ask (renamed)");
  assert.match(outcome.messages[0], /stop #0 "Ask" \(lane 0, leg start\): label expected "Ask" but got "Ask \(renamed\)"/);
});

test("a lost stop and a new stop are both named, not just counted", () => {
  const before = [sweepStop({ index: 0 }), sweepStop({ index: 1, label: "Copy", selector: "sel:#copy", focusKey: "sel:#copy", leg: "DOWN", press: "DOWN" })];
  const check = sweepCheck(before);
  // Replay stalled after one stop: the second landing never happened.
  const after = [sweepStop({ index: 0 })];
  const outcome = diffCheck(check, check.buildHash, sweepReport(after));
  assert.equal(outcome.ok, false);
  const wholeStopDiff = outcome.diffs.find((d) => d.path === "stops[1]");
  assert.ok(wholeStopDiff, "the missing stop should show up as its own diff entry");
  const msg = outcome.messages.find((m) => m.includes("missing from the replay"));
  assert.match(msg ?? "", /stop #1 from the saved check \(Copy\) is missing from the replay/);
});

test("a runSequence step landing on the wrong control is named by step number and label", () => {
  const check = sequenceCheck([step({ index: 2, label: "go to settings", to: '<BUTTON> "Settings"', focusKey: "sel:#settings" })]);
  const actual = runSequenceResult([step({ index: 2, label: "go to settings", to: '<BUTTON> "About"', focusKey: "sel:#about" })]);
  const outcome = diffCheck(check, check.buildHash, actual);
  assert.equal(outcome.ok, false);
  assert.match(outcome.messages.join("\n"), /step 2 \("go to settings"\): to expected "<BUTTON> \\"Settings\\"" but got "<BUTTON> \\"About\\""/);
  assert.match(outcome.messages.join("\n"), /step 2 \("go to settings"\): focusKey expected "sel:#settings" but got "sel:#about"/);
});

test("an incidental field changing does not fail the check", () => {
  // Same landings, but this run's settle timing and press-retry-adjacent
  // measurement (visiblePercent) differ, plus wording in diagnosis changed --
  // none of that is a landing.
  const before = [sweepStop({ visibility: visibility({ visiblePercent: 100 }) })];
  const check = sweepCheck(before);
  const after = [sweepStop({ visibility: visibility({ visiblePercent: 78 }) })]; // still "visible", just a different sampled percent
  const sweepOutcome = diffCheck(check, check.buildHash, sweepReport(after));
  assert.equal(sweepOutcome.ok, true, "visiblePercent is a render-timing measurement, not a landing fact");

  const seqCheck = sequenceCheck([step({ settleMs: 40, settled: true, diagnosis: "moved and settled" })]);
  const seqActual = runSequenceResult([step({ settleMs: 900, settled: false, diagnosis: "moved (settle timed out, but position matched)" })]);
  const seqOutcome = diffCheck(seqCheck, seqCheck.buildHash, seqActual);
  assert.equal(seqOutcome.ok, true, "settleMs/settled/diagnosis are excluded from the comparison entirely");
});

test("replaying a check saved against a different build hash says so, without pretending to have diffed anything", () => {
  const stops = [sweepStop()];
  const check = sweepCheck(stops);
  const outcome = diffCheck(check, "sha256:different-build", sweepReport(stops));
  assert.equal(outcome.buildHashMatch, false);
  assert.equal(outcome.ok, false);
  assert.deepEqual(outcome.diffs, [], "no landing diff is computed across two different builds");
  assert.match(outcome.summary, /saved against build sha256:aaaa/);
  assert.match(outcome.summary, /current build is sha256:different-build/);
  assert.match(outcome.summary, /never been verified against what is running now/);
});

// ---------------------------------------------------------------------------
// Malformed / truncated check files
// ---------------------------------------------------------------------------

test("a non-object payload is rejected with a clear message, not a crash", () => {
  assert.throws(() => validateCheckFile("not even json-shaped", "checks/bad.json"), (err: unknown) => {
    assert.ok(err instanceof CheckFileError);
    assert.match((err as Error).message, /checks\/bad\.json is not a check/);
    return true;
  });
  assert.throws(() => validateCheckFile(null, "checks/null.json"), CheckFileError);
  assert.throws(() => validateCheckFile([1, 2, 3], "checks/array.json"), CheckFileError);
});

test("a truncated check file (valid JSON, missing fields) is rejected by name, not by crash", () => {
  assert.throws(
    () => validateCheckFile({ formatVersion: 1, name: "x" }, "checks/truncated.json"),
    (err: unknown) => {
      assert.ok(err instanceof CheckFileError);
      assert.match((err as Error).message, /missing required field\(s\): tool, buildHash, runOptions, expected/);
      return true;
    },
  );
});

test("an unknown formatVersion is rejected rather than misread", () => {
  assert.throws(
    () =>
      validateCheckFile(
        { formatVersion: 99, name: "x", tool: "deck_sweep", buildHash: "sha256:a", runOptions: {}, expected: { stops: [], legs: [], totals: {} } },
        "checks/future.json",
      ),
    /formatVersion 99/,
  );
});

test("a version 1 check is refused with advice, not silently mis-compared", () => {
  assert.throws(
    () =>
      validateCheckFile(
        {
          formatVersion: 1,
          name: "x",
          tool: "deck_sweep",
          buildHash: "sha256:2f4ef12a",
          runOptions: {},
          expected: { stops: [], legs: [], totals: {} },
        },
        "checks/v1.json",
      ),
    (err: unknown) => {
      assert.ok(err instanceof CheckFileError);
      const msg = (err as Error).message;
      assert.match(msg, /formatVersion 1/);
      assert.match(msg, /different build fingerprint/);
      assert.match(msg, /deck_saveCheck/);
      return true;
    },
  );
});

test("an unknown tool name is rejected", () => {
  assert.throws(
    () =>
      validateCheckFile(
        { formatVersion: CHECK_FORMAT_VERSION, name: "x", tool: "deck_launchGame", buildHash: "sha256:a", runOptions: {}, expected: {} },
        "checks/wrong-tool.json",
      ),
    /unknown tool "deck_launchGame"/,
  );
});

test("a deck_sweep check missing its expected shape is rejected", () => {
  assert.throws(
    () =>
      validateCheckFile(
        { formatVersion: CHECK_FORMAT_VERSION, name: "x", tool: "deck_sweep", buildHash: "sha256:a", runOptions: {}, expected: { onlyThis: true } },
        "checks/shapeless.json",
      ),
    /missing stops\/legs\/totals/,
  );
});
