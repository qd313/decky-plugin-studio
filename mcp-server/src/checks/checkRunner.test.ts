/**
 * Tests for checks.checkRunner -- saving a check from a (faked) tool call,
 * and replaying every check in a directory against a (faked) fresh run.
 *
 * The run layer is faked entirely, per the feature's own requirement: every
 * test below injects `runSweep` / `runRunSequence`, so `saveCheck` and
 * `replayChecks` never call the real deck/sweep.ts or deck/runSequence.ts,
 * which need a live Deck over CDP and a bridge board. Only the filesystem
 * (a scratch plugin tree for the build hash, a scratch checks directory) and
 * the loop/diff logic under test are real.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { saveCheck, replayChecks, loadCheckFile, checkFilePath } from "./checkRunner.js";
import { computeBuildHash } from "./buildHash.js";
import { diffCheck } from "./checkFile.js";
import type { SweepResult, SweepStop, SweepLeg } from "../deck/sweep.js";
import type { RunSequenceResult, StepResult } from "../deck/runSequence.js";
import type { Visibility } from "../deck/readFocus.js";

// ---------------------------------------------------------------------------
// Scratch filesystem helpers
// ---------------------------------------------------------------------------

function makePluginRoot(distContents = "// v1"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dps-checkrunner-plugin-"));
  fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ name: "sample", version: "1.0.0" }));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "index.js"), distContents);
  return root;
}

function makeChecksDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dps-checkrunner-checks-"));
}

function cleanup(...dirs: string[]): void {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}

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

function sweepStops(overrides: Partial<SweepStop> = {}): SweepStop[] {
  const base: SweepStop[] = [
    {
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
    },
    {
      index: 1,
      lane: 0,
      leg: "DOWN",
      press: "DOWN",
      tag: "BUTTON",
      label: "Show details",
      labelSource: "text",
      selector: "sel:#details",
      rect: { x: 10, y: 70, w: 100, h: 40 },
      scrollTop: 0,
      visibility: visibility(),
      focusKey: "sel:#details",
    },
  ];
  return base.map((s) => ({ ...s, ...overrides }));
}

function sweepResultFixture(stops: SweepStop[], overrides: Partial<SweepResult> = {}): SweepResult {
  const legs: SweepLeg[] = [{ lane: 0, direction: "DOWN", presses: 1, stops: 1, endedBy: "stall", cycle: null }];
  return {
    tool: "deck_sweep",
    pattern: { direction: "DOWN", returnTrip: true, lanes: 0, laneButton: "RB", budget: 80, stallLimit: 2 },
    ok: true,
    stopped: false,
    totals: {
      stopsRecorded: stops.length,
      stopsVisited: new Set(stops.map((s) => s.focusKey)).size,
      unlabeledStops: stops.filter((s) => !s.label).length,
      cycles: 0,
      stopsFocusedButNotVisible: stops.filter((s) => s.visibility && s.visibility.verdict !== "visible").length,
      presses: 1,
      legs: 1,
    },
    notVisible: [],
    legs,
    stops,
    fidelity: "steam-routed",
    acquired: false,
    evidenceFile: null,
    durationMs: 55,
    pressRetries: 0,
    summary: "swept 2 control(s) in 1 press(es) over 1 leg(s); every stop was visible",
    ...overrides,
  };
}

function stepFixture(overrides: Partial<StepResult> = {}): StepResult {
  return {
    index: 1,
    label: "open settings",
    press: ["DOWN"],
    expect: null,
    ok: true,
    pass: true,
    moved: true,
    matched: null,
    from: '<BUTTON> "Ask"',
    to: '<BUTTON> "Settings"',
    focusKey: "sel:#settings",
    visibility: visibility(),
    visible: true,
    settled: true,
    settleMs: 40,
    diagnosis: "moved and settled",
    ...overrides,
  };
}

function runSequenceResultFixture(steps: StepResult[], overrides: Partial<RunSequenceResult> = {}): RunSequenceResult {
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
    durationMs: 321,
    acquired: false,
    summary: `${passed}/${steps.length} steps passed`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// saveCheck
// ---------------------------------------------------------------------------

test("a saved check round-trips through the filesystem", async () => {
  const pluginRoot = makePluginRoot();
  const checksDir = makeChecksDir();
  try {
    const canned = sweepResultFixture(sweepStops());
    const saved = await saveCheck({
      name: "carousel-down",
      tool: "deck_sweep",
      checksDir,
      pluginRoot,
      sweepOptions: { direction: "DOWN" },
      runSweep: async () => canned,
    });

    assert.equal(saved.ok, true, saved.reason);
    assert.equal(saved.filePath, checkFilePath(checksDir, "carousel-down"));
    assert.ok(fs.existsSync(saved.filePath!));

    const loaded = loadCheckFile(saved.filePath!);
    assert.equal(loaded.formatVersion, 1);
    assert.equal(loaded.name, "carousel-down");
    assert.equal(loaded.tool, "deck_sweep");
    assert.equal(loaded.buildHash, saved.check!.buildHash);
    assert.deepEqual(loaded.runOptions, saved.check!.runOptions);
    // Compared through the same JSON transformation on both sides: a field
    // that is `undefined` in memory (e.g. `reason` on a run that has none)
    // legitimately has no key at all once it has been through JSON, on
    // either side of the round trip -- that is not a loss of information
    // diffCheck cares about (see the next assertion).
    assert.deepEqual(loaded.expected, JSON.parse(JSON.stringify(saved.check!.expected)));
    // The build hash actually reflects the plugin tree passed in.
    assert.equal(loaded.buildHash, computeBuildHash(pluginRoot).hash);

    // The real proof a check "round-trips": loaded back from disk and diffed
    // against the exact result it was saved from, it reports no diff at all.
    const outcome = diffCheck(loaded, loaded.buildHash, canned);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.diffs));
    assert.deepEqual(outcome.diffs, []);
  } finally {
    cleanup(pluginRoot, checksDir);
  }
});

test("saveCheck refuses to save a run that did not complete cleanly", async () => {
  const pluginRoot = makePluginRoot();
  const checksDir = makeChecksDir();
  try {
    const broken = sweepResultFixture(sweepStops(), { ok: false, summary: "ended early: press-failed" });
    const saved = await saveCheck({
      name: "broken-run",
      tool: "deck_sweep",
      checksDir,
      pluginRoot,
      runSweep: async () => broken,
    });
    assert.equal(saved.ok, false);
    assert.match(saved.reason ?? "", /did not complete cleanly/);
    assert.equal(saved.filePath, null);
    assert.equal(fs.existsSync(checkFilePath(checksDir, "broken-run")), false);
  } finally {
    cleanup(pluginRoot, checksDir);
  }
});

// ---------------------------------------------------------------------------
// replayChecks: the loop
// ---------------------------------------------------------------------------

test("replayChecks reruns every saved check and reports no diff when nothing changed", async () => {
  const pluginRoot = makePluginRoot();
  const checksDir = makeChecksDir();
  try {
    const sweepStopsFixture = sweepStops();
    await saveCheck({
      name: "sweep-check",
      tool: "deck_sweep",
      checksDir,
      pluginRoot,
      runSweep: async () => sweepResultFixture(sweepStopsFixture),
    });
    const stepsFixture = [stepFixture()];
    await saveCheck({
      name: "sequence-check",
      tool: "deck_runSequence",
      checksDir,
      pluginRoot,
      sequenceOptions: { steps: [{ press: "DOWN" }] },
      runRunSequence: async () => runSequenceResultFixture(stepsFixture),
    });

    const replay = await replayChecks({
      checksDir,
      pluginRoot,
      runSweep: async () => sweepResultFixture(sweepStops()),
      runRunSequence: async () => runSequenceResultFixture([stepFixture()]),
    });

    assert.equal(replay.errors.length, 0);
    assert.equal(replay.checked.length, 2);
    assert.ok(replay.checked.every((c) => c.ok), JSON.stringify(replay.checked, null, 2));
    assert.equal(replay.ok, true);
    assert.match(replay.summary, /2\/2 check\(s\) passed/);
  } finally {
    cleanup(pluginRoot, checksDir);
  }
});

test("replayChecks names a changed landing specifically, for both tool kinds", async () => {
  const pluginRoot = makePluginRoot();
  const checksDir = makeChecksDir();
  try {
    await saveCheck({
      name: "sweep-check",
      tool: "deck_sweep",
      checksDir,
      pluginRoot,
      runSweep: async () => sweepResultFixture(sweepStops()),
    });
    await saveCheck({
      name: "sequence-check",
      tool: "deck_runSequence",
      checksDir,
      pluginRoot,
      sequenceOptions: { steps: [{ press: "DOWN" }] },
      runRunSequence: async () => runSequenceResultFixture([stepFixture()]),
    });

    // Second stop's label changed on the sweep; the sequence step now lands
    // on a different control -- both are real regressions.
    const movedStops = sweepStops({}).map((s, i) => (i === 1 ? { ...s, label: "Show details (v2)" } : s));
    const replay = await replayChecks({
      checksDir,
      pluginRoot,
      runSweep: async () => sweepResultFixture(movedStops),
      runRunSequence: async () => runSequenceResultFixture([stepFixture({ to: '<BUTTON> "About"', focusKey: "sel:#about" })]),
    });

    assert.equal(replay.ok, false);
    const sweepOutcome = replay.checked.find((c) => c.name === "sweep-check")!;
    assert.equal(sweepOutcome.ok, false);
    assert.ok(
      sweepOutcome.messages.some((m) => m.includes("stop #1") && m.includes("label") && m.includes("Show details")),
      sweepOutcome.messages.join("\n"),
    );

    const seqOutcome = replay.checked.find((c) => c.name === "sequence-check")!;
    assert.equal(seqOutcome.ok, false);
    assert.ok(
      seqOutcome.messages.some((m) => m.includes("step 1") && m.includes("to") && m.includes("Settings") && m.includes("About")),
      seqOutcome.messages.join("\n"),
    );
  } finally {
    cleanup(pluginRoot, checksDir);
  }
});

test("a malformed check file is rejected with a clear message and does not stop the rest of the replay", async () => {
  const pluginRoot = makePluginRoot();
  const checksDir = makeChecksDir();
  try {
    await saveCheck({
      name: "good-check",
      tool: "deck_sweep",
      checksDir,
      pluginRoot,
      runSweep: async () => sweepResultFixture(sweepStops()),
    });

    // A check file cut off mid-write -- exactly what a crash during save, or a
    // half-finished commit, would leave behind.
    fs.writeFileSync(path.join(checksDir, "truncated.json"), '{"formatVersion": 1, "name": "trunc"');
    // Valid JSON, but not a check at all.
    fs.writeFileSync(path.join(checksDir, "not-a-check.json"), JSON.stringify({ hello: "world" }));

    const replay = await replayChecks({
      checksDir,
      pluginRoot,
      runSweep: async () => sweepResultFixture(sweepStops()),
      runRunSequence: async () => runSequenceResultFixture([stepFixture()]),
    });

    assert.equal(replay.errors.length, 2);
    const messages = replay.errors.map((e) => e.message).join("\n");
    assert.match(messages, /truncated\.json.*(truncated|corrupted)/s);
    assert.match(messages, /not-a-check\.json.*missing required field/s);

    // The one good check was still replayed and still passed.
    assert.equal(replay.checked.length, 1);
    assert.equal(replay.checked[0].name, "good-check");
    assert.equal(replay.checked[0].ok, true);
    assert.equal(replay.ok, false, "the unreadable files must still make the overall replay non-ok");
  } finally {
    cleanup(pluginRoot, checksDir);
  }
});

test("replaying a check saved against a different build hash says so, and does not run a landing diff", async () => {
  const pluginRoot = makePluginRoot("// v1");
  const checksDir = makeChecksDir();
  try {
    const stops = sweepStops();
    await saveCheck({
      name: "sweep-check",
      tool: "deck_sweep",
      checksDir,
      pluginRoot,
      runSweep: async () => sweepResultFixture(stops),
    });
    const savedHash = computeBuildHash(pluginRoot).hash;

    // A real rebuild: the plugin's bundle changed underneath the check.
    fs.writeFileSync(path.join(pluginRoot, "dist", "index.js"), "// v2 -- a real rebuild");
    const newHash = computeBuildHash(pluginRoot).hash;
    assert.notEqual(savedHash, newHash);

    const replay = await replayChecks({
      checksDir,
      pluginRoot,
      // Landings would in fact differ here too, but that must not even be
      // examined once the build hash disagrees.
      runSweep: async () => sweepResultFixture(sweepStops({ label: "totally different" })),
    });

    assert.equal(replay.checked.length, 1);
    const outcome = replay.checked[0];
    assert.equal(outcome.buildHashMatch, false);
    assert.equal(outcome.ok, false);
    assert.deepEqual(outcome.diffs, []);
    assert.equal(outcome.savedBuildHash, savedHash);
    assert.equal(outcome.currentBuildHash, newHash);
    assert.match(outcome.summary, /never been verified against what is running now/);
  } finally {
    cleanup(pluginRoot, checksDir);
  }
});
