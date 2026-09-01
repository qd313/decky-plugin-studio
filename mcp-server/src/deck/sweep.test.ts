/**
 * Tests for deck.sweep.
 *
 * The same split as walkTo's and runSequence's suites: the refusals and the
 * report's shape can be pinned without a bridge board, and those are the parts
 * a consumer's baseline diff depends on. Walking itself needs real presses and
 * is verified on a Deck (bonsAI's Main tab, row QA-FREE-PLAY-01).
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startFakeCdp, focusedPage, unfocusedPage } from "./__testutil__/fakeCdp.js";
import { sweep, summarize, SweepStop, SweepLeg } from "./sweep.js";
import type { Visibility } from "./readFocus.js";

const VISIBLE: Visibility = {
  verdict: "visible",
  visiblePercent: 100,
  coveredBy: null,
  clippedBy: null,
  points: { visible: 9, covered: 0, clipped: 0, offscreen: 0 },
};
const COVERED: Visibility = {
  verdict: "covered",
  visiblePercent: 0,
  coveredBy: "div.bonsai-main-tab-dock > button.Focusable.bonsai-chip",
  clippedBy: null,
  points: { visible: 0, covered: 9, clipped: 0, offscreen: 0 },
};

function stop(
  index: number,
  label: string,
  key: string | null,
  visibility: Visibility | null,
  leg = "DOWN",
): SweepStop {
  return {
    index,
    lane: 0,
    leg,
    press: index === 0 ? null : leg,
    tag: "BUTTON",
    label,
    labelSource: label ? "text" : null,
    selector: key,
    rect: { x: 20, y: 100 + index * 50, w: 300, h: 40 },
    scrollTop: index * 50,
    visibility,
    focusKey: key,
  };
}

// --------------------------------------------------------------------------
// Safety: only the ring moves
// --------------------------------------------------------------------------

test("A, B and START are refused as a direction -- a sweep must not be able to activate anything", async () => {
  for (const bad of ["A", "B", "START"]) {
    const r = await sweep({ direction: bad as never, writeEvidence: false });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /must be one of UP, DOWN, LEFT, RIGHT/);
    assert.equal(r.stops.length, 0, "nothing was read, let alone pressed");
  }
});

test("only LB and RB change lane; anything else is refused before a tunnel is opened", async () => {
  for (const bad of ["A", "X", "START", "L3"]) {
    const r = await sweep({ laneButton: bad as never, lanes: 1, writeEvidence: false });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /laneButton must be LB or RB/);
  }
});

// --------------------------------------------------------------------------
// Report shape -- what a consumer's baseline diff sees
// --------------------------------------------------------------------------

test("totals count rows, distinct controls, unnamed controls, cycles and not-visible stops", () => {
  /*
   * A DOWN leg over three controls, the last of them behind the dock, then an
   * UP leg back over the same three -- on the way up the pane is scrolled
   * differently and the same control is visible. That is a real shape: the
   * verdict is a property of the STOP, not of the control, so it is counted
   * per row.
   */
  const stops = [
    stop(0, "Ask", "sel:#ask", VISIBLE, "start"),
    stop(1, "Show details", "sel:#details", VISIBLE),
    stop(2, "", "sel:#icon", VISIBLE),
    stop(3, "Copy", "sel:#copy", COVERED),
    stop(4, "", "sel:#icon", VISIBLE, "UP"),
    stop(5, "Show details", "sel:#details", VISIBLE, "UP"),
    stop(6, "Ask", "sel:#ask", VISIBLE, "UP"),
  ];
  const legs: SweepLeg[] = [
    { lane: 0, direction: "DOWN", presses: 5, stops: 3, endedBy: "stall", cycle: null },
    {
      lane: 0,
      direction: "UP",
      presses: 5,
      stops: 3,
      endedBy: "stall",
      cycle: { key: "sel:#ask", seenAt: [0, 6], loop: [], escaped: false, stepsAfterLoop: 0 },
    },
  ];
  const { totals, notVisible } = summarize(stops, legs, 10);
  assert.deepEqual(totals, {
    stopsRecorded: 7,
    stopsVisited: 4,
    unlabeledStops: 1,
    cycles: 1,
    stopsFocusedButNotVisible: 1,
    presses: 10,
    legs: 2,
  });
  assert.deepEqual(notVisible, [
    {
      index: 3,
      lane: 0,
      leg: "DOWN",
      label: "Copy",
      verdict: "covered",
      visiblePercent: 0,
      coveredBy: "div.bonsai-main-tab-dock > button.Focusable.bonsai-chip",
      clippedBy: null,
    },
  ]);
});

test("an unmeasured stop is not counted as not-visible, and not as visible either", () => {
  const { totals, notVisible } = summarize([stop(0, "Ask", "sel:#ask", null, "start")], [], 0);
  assert.equal(totals.stopsFocusedButNotVisible, 0);
  assert.deepEqual(notVisible, []);
});

test("the starting read is row 0, and a press that cannot be delivered ends the sweep honestly", async () => {
  // Focus reads fine; the press is what fails (hardware guard). The report
  // must still carry the one stop it did measure, name the failure as a press
  // failure rather than a stall, and not claim to be ok.
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => ({ ...focusedPage, visibility: VISIBLE }));
  try {
    const r = await sweep({ cdpUrl: fake.base, writeEvidence: false });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /DPS_NO_BRIDGE/);
    assert.equal(r.stops.length, 1);
    assert.equal(r.stops[0].leg, "start");
    assert.equal(r.stops[0].press, null);
    assert.equal(r.stops[0].label, "bonsAI");
    assert.equal(r.stops[0].visibility?.verdict, "visible");
    assert.equal(r.legs.length, 1);
    assert.equal(r.legs[0].endedBy, "press-failed");
    assert.equal(r.totals.stopsRecorded, 1);
    assert.equal(r.totals.presses, 0);
    assert.equal(r.fidelity, null, "nothing was routed");
    assert.match(r.summary, /ended early after 0 press\(es\)/);
    assert.equal(r.evidenceFile, null);
  } finally {
    await fake.close();
  }
});

test("an unreachable Deck stops before any press", async () => {
  const r = await sweep({ cdpUrl: "http://127.0.0.1:1", writeEvidence: false });
  assert.equal(r.ok, false);
  assert.equal(r.stops.length, 0);
  assert.match(r.summary, /could not read focus before the sweep started/);
});

test("acquireFocus:false leaves an unowned ring alone and says what to do", async () => {
  const fake = await startFakeCdp(["SharedJSContext"], () => unfocusedPage);
  try {
    const r = await sweep({ acquireFocus: false, cdpUrl: fake.base, writeEvidence: false });
    assert.equal(r.ok, false);
    assert.equal(r.acquired, false);
    assert.equal(r.totals.presses, 0);
    assert.match(r.summary, /acquireFocus does that automatically/);
  } finally {
    await fake.close();
  }
});

test("the evidence file is the report alone -- nothing in it depends on the clock", async () => {
  /*
   * The whole point of the sweep is "sweep, then diff against a baseline". A
   * duration or the file's own path in the file would dirty every diff, so
   * the file holds the report and the tool result holds the rest.
   */
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dps-sweep-"));
  const previous = process.env.DECKY_STUDIO_WORKSPACE;
  process.env.DECKY_STUDIO_WORKSPACE = workspace;
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => ({ ...focusedPage, visibility: COVERED }));
  try {
    const r = await sweep({ cdpUrl: fake.base, runName: "main-tab" });
    assert.equal(r.evidenceFile, path.join(workspace, "runs", "main-tab.json"));
    const written = JSON.parse(fs.readFileSync(r.evidenceFile!, "utf8"));
    assert.deepEqual(Object.keys(written), [
      "tool",
      "pattern",
      "ok",
      "reason",
      "stopped",
      "totals",
      "notVisible",
      "legs",
      "stops",
    ]);
    assert.equal(written.tool, "deck_sweep");
    assert.equal("durationMs" in written, false);
    assert.equal("evidenceFile" in written, false);
    assert.equal(written.totals.stopsFocusedButNotVisible, 1);
    assert.equal(written.notVisible[0].coveredBy, COVERED.coveredBy);
    assert.equal(written.stops[0].scrollTop, null, "the fixture has no pane; null, not 0");
    assert.match(r.summary, /1 stop\(s\) FOCUSED BUT NOT VISIBLE: #0 bonsAI COVERED by/);
  } finally {
    await fake.close();
    if (previous === undefined) delete process.env.DECKY_STUDIO_WORKSPACE;
    else process.env.DECKY_STUDIO_WORKSPACE = previous;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
