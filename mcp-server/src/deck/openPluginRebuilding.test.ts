/**
 * Tests for deck_openPlugin reading through a debugger that is rebuilding
 * (plan 12 lane A, item 3).
 *
 * The Deck, 2026-10-22, bonsAI's stricter set: 1 of 3, both failures 1 s after
 * the reload with a "debugger connection reset". Inside the restart window
 * (loaderRestart.ts, 120 s) a read that fails with a reset, a hang-up, a
 * refused connect or an empty target list is now read again with backoff
 * until it answers or the window closes; outside it, the old behaviour.
 *
 * THE FAKE'S RESTART IS A GUESS AT THE SHAPE. fakeCdp.ts's restart() resets,
 * hangs up or empties the list for a fixed time; what CEF really does after a
 * plugin_loader restart, in what order and for how long, is unmeasured until
 * deck_probeDebugger has run on the Deck. These tests prove how the tool reacts
 * to those three shapes, not that the Deck makes them.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";

import { startFakeCdp, focusedPage, unfocusedPage } from "./__testutil__/fakeCdp.js";
import { sandboxHome } from "./__testutil__/sandboxHome.js";
import { openPluginDriven, rebuildingKind } from "./openPlugin.js";
import { noteLoaderRestart, clearLoaderRestart, RESTART_WINDOW_MS } from "./loaderRestart.js";
import { QUICK_ACCESS_PROBE_EXPRESSION } from "./readFocus.js";
import type { PressOptions, PressResult } from "./pressButton.js";

sandboxHome("dps-open-rebuild-");

const TARGETS = ["SharedJSContext", "QuickAccess_uid2"];
/** The Quick Access page's own probe: the menu open on Decky's pane, the tab on the rail. */
const PROBE_OPEN_DECKY = { visiblePane: "999", ownsFocus: true, paneCount: 5, deckyPaneMounted: true, visibilityState: "visible" };

function recorder() {
  const log: string[] = [];
  const ok = (buttons: string[], method: string): PressResult => ({ ok: true, fidelity: "steam-routed", method, buttons, holdMs: 80 });
  return {
    log,
    count: (b: string) => log.filter((l) => l === `press:${b}`).length,
    pressFn: async ({ buttons }: PressOptions): Promise<PressResult> => {
      log.push(`press:${buttons.join("+")}`);
      return ok(buttons, "fake");
    },
    chordFn: async (hold: string, tap: string): Promise<PressResult> => {
      log.push(`chord:${hold}>${tap}`);
      return ok([hold, tap], "fake:chord");
    },
  };
}

/**
 * The Deck with the menu open on Decky's pane and the ring on bonsAI's row;
 * A mounts `.bonsai-scope`. `resetFocusUntil` makes the Quick Access page reset
 * every FOCUS read until then (the probe and the root read still answer).
 */
function deck(rig: ReturnType<typeof recorder>, resetFocusUntil = 0) {
  return (title: string, _i: number, expr: string): unknown => {
    if (title !== "QuickAccess_uid2") return unfocusedPage;
    if (expr === QUICK_ACCESS_PROBE_EXPRESSION) return PROBE_OPEN_DECKY;
    if (expr.includes(".bonsai-scope")) return rig.count("A") > 0;
    if (Date.now() < resetFocusUntil) return { __reset: true };
    return rig.count("A") > 0 ? unfocusedPage : focusedPage;
  };
}

const QUICK = { targetsSettleMs: 100, afterRestartSettleMs: 100, rebuildingBackoffMs: [50] };

for (const mode of ["reset", "hangup", "empty"] as const) {
  test(`inside the restart window, a debugger that answers "${mode}" for a second is waited out: one call opens the panel, nothing pressed until it answers`, async () => {
    const rig = recorder();
    const fake = await startFakeCdp(TARGETS, deck(rig));
    const machine = `rebuild-${mode}`;
    let firstPressAt = 0;
    try {
      noteLoaderRestart(machine);
      const rebuiltAt = Date.now() + 1200;
      fake.restart(1200, mode);
      const r = await openPluginDriven({
        pluginName: "bonsAI",
        cdpUrl: fake.base,
        restartMachine: machine,
        rootSelector: ".bonsai-scope",
        ...QUICK,
        pressFn: async (o) => {
          firstPressAt ||= Date.now();
          return rig.pressFn(o);
        },
        chordFn: rig.chordFn,
      });
      assert.equal(r.ok, true, `${r.reason}\n${JSON.stringify(r.stages, null, 1)}`);
      if (mode !== "empty") assert.ok(fake.resets() > 0, "the fake did drop connections");
      assert.ok(firstPressAt >= rebuiltAt, "no press went out while the debugger was rebuilding");
      assert.deepEqual(rig.log, ["press:A"]);
      const waits = r.stages.filter((s) => s.stage === "wait-rebuilding");
      assert.ok(waits.length >= 1, "the wait is on the record");
      assert.ok(waits.every((s) => s.ok && s.presses === 0));
      const words = { reset: /connection reset|hang-up/, hangup: /hang-up/, empty: /target list/ }[mode];
      assert.match(waits[0].detail, words);
      assert.match(waits[0].detail, /after the plugin_loader restart failed with .*read again \d+ times? over \d+ ms, and it answered/);
    } finally {
      clearLoaderRestart(machine);
      await fake.close();
    }
  });
}

test("a note already cleared (an earlier call saw the Quick Access page) does not end the window: a reset 1 s later is still waited out", async () => {
  // The retry in openPluginRetry.ts, or the next call, after the first one
  // cleared the note: the debugger may not be done resetting.
  const rig = recorder();
  const fake = await startFakeCdp(TARGETS, deck(rig));
  const machine = "rebuild-after-clear";
  try {
    noteLoaderRestart(machine, Date.now() - 1000);
    clearLoaderRestart(machine);
    fake.restart(800, "reset");
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      restartMachine: machine,
      rootSelector: ".bonsai-scope",
      ...QUICK,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.stages.find((s) => s.stage === "wait-qam-after-restart"), undefined, "the cleared note is not waited on again");
    assert.ok(r.stages.some((s) => s.stage === "wait-rebuilding" && s.ok));
    assert.deepEqual(rig.log, ["press:A"]);
  } finally {
    await fake.close();
  }
});

test("outside the window the old behaviour stands: a reset fails the call at once, nothing pressed, no rebuilding wait", async () => {
  const rig = recorder();
  const fake = await startFakeCdp(TARGETS, deck(rig));
  try {
    fake.restart(3000, "reset");
    const started = Date.now();
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      restartMachine: "rebuild-no-note",
      rootSelector: ".bonsai-scope",
      ...QUICK,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
    });
    assert.equal(r.ok, false);
    assert.ok(Date.now() - started < 2500, "it did not wait the reset out");
    assert.deepEqual(rig.log, []);
    assert.equal(r.stages.find((s) => s.stage === "wait-rebuilding"), undefined);
    assert.match(r.reason ?? "", /ECONNRESET|socket hang up/);
  } finally {
    await fake.close();
  }
});

test("the window closes while it is still resetting: the call fails with nothing pressed and says the window closed", async () => {
  const rig = recorder();
  const fake = await startFakeCdp(TARGETS, deck(rig));
  const machine = "rebuild-window-closes";
  try {
    // A restart noted 0.7 s before the window ends, and a debugger that never comes back in it.
    noteLoaderRestart(machine, Date.now() - RESTART_WINDOW_MS + 700);
    fake.restart(30_000, "reset");
    const started = Date.now();
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      restartMachine: machine,
      rootSelector: ".bonsai-scope",
      ...QUICK,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
    });
    assert.equal(r.ok, false);
    assert.ok(Date.now() - started < 5000, `bounded by the window (${Date.now() - started} ms)`);
    assert.deepEqual(rig.log, []);
    const w = r.stages.find((s) => s.stage === "wait-rebuilding");
    assert.equal(w?.ok, false);
    assert.match(w?.detail ?? "", /still failing when the 120 s window closed/);
  } finally {
    clearLoaderRestart(machine);
    await fake.close();
  }
});

test("inside the window, a scan where the Quick Access page reset does not read as 'nothing owns the ring': no blind DOWN press", async () => {
  // readFocusAt reports "gpfocus marker not found ... Errors: QuickAccess_uid2:
  // connection closed before a reply" when one page answered without a ring
  // and the other reset -- and "marker not found" is what earns the acquire
  // DOWN press. In the window that scan is read again instead.
  const rig = recorder();
  const fake = await startFakeCdp(TARGETS, deck(rig, Date.now() + 800));
  const machine = "rebuild-tainted-scan";
  try {
    noteLoaderRestart(machine);
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      restartMachine: machine,
      rootSelector: ".bonsai-scope",
      ...QUICK,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
    });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(rig.log, ["press:A"], "the first and only press is the A on the confirmed row");
    const w = r.stages.find((s) => s.stage === "wait-rebuilding");
    assert.match(w?.detail ?? "", /a focus read .* failed with a connection reset .*connection closed before a reply/);
  } finally {
    clearLoaderRestart(machine);
    await fake.close();
  }
});

test("the same tainted scan outside the window still earns the acquire DOWN press (the old behaviour, kept on purpose)", async () => {
  const rig = recorder();
  const fake = await startFakeCdp(TARGETS, deck(rig, Date.now() + 60_000));
  try {
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      restartMachine: "rebuild-tainted-no-note",
      rootSelector: ".bonsai-scope",
      ...QUICK,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
    });
    assert.equal(r.ok, false);
    assert.equal(rig.count("DOWN"), 1);
    assert.equal(r.stages.find((s) => s.stage === "wait-rebuilding"), undefined);
  } finally {
    await fake.close();
  }
});

test("rebuildingKind names the shapes and nothing else", () => {
  assert.equal(rebuildingKind("Could not reach ... (read ECONNRESET)"), "a connection reset");
  assert.equal(rebuildingKind("socket hang up"), "a hang-up");
  assert.equal(rebuildingKind("connect ECONNREFUSED 127.0.0.1:8080"), "a refused connect");
  assert.equal(rebuildingKind("... (no debuggable targets listed)"), "an empty target list");
  assert.equal(rebuildingKind("no Quick Access page is listed by Steam's CEF debugger (listed: nothing)"), "a target list without the Quick Access page");
  assert.equal(rebuildingKind("Runtime.evaluate timed out after 10000ms"), null, "a timeout is not a reset");
  assert.equal(rebuildingKind("gpfocus marker not found in any target - ... Scanned: A, B."), null, "an unowned ring is not a reset");
  assert.equal(rebuildingKind("GET http://x/json/list returned HTTP 500"), null);
  assert.equal(rebuildingKind(undefined), null);
});
