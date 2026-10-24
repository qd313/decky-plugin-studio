/**
 * Tests for deck_openPlugin waiting for Decky's tab to be back on the Quick
 * Access rail (plan 97, lane X2).
 *
 * The Deck, 2026-10-17 (plan 94 block 7): after deck_reloadPlugin the Decky tab
 * (pane 999) was missing from the rail for over 100 s. Two deck_openPlugin tries
 * failed with "walked 10 rail entries without the Decky pane appearing"; the
 * third worked, with the tab back. A walk along a rail with no Decky entry can
 * only fail, so the tool now presses no D-pad button while the menu is open and
 * the page has no Decky pane. It polls for up to 120 s, closing and reopening the
 * menu every 10 s (the reopen step, 0527dfa), and says how long it waited.
 *
 * The fake Quick Access page here is driven by the clock and by which buttons
 * were pressed, not by read counts, so the number of polls the wait makes does
 * not matter.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";

import { startFakeCdp, focusedPage, unfocusedPage } from "./__testutil__/fakeCdp.js";
import { openPluginDriven } from "./openPlugin.js";
import { openPluginWithRetry, isRetryableOpenFailure } from "./openPluginRetry.js";
import type { OpenPluginResult } from "./openPlugin.js";
import type { PressOptions, PressResult } from "./pressButton.js";

const TARGETS = ["SharedJSContext", "QuickAccess_uid2"];

/** The menu is open on Quick Settings (pane 3) with the ring on the tab rail, Decky's tab not on it. */
const RAIL_NO_DECKY = {
  ...unfocusedPage,
  hasGpfocus: true,
  gpfocus: { ...focusedPage.gpfocus, selector: "div.rail-tab", tag: "DIV", text: "", ownerText: "", ariaLabel: "Quick Settings" },
  quickAccessTab: null,
  visibleQuickAccessTab: "3",
  visiblePane: "3",
  ownsFocus: true,
  paneCount: 5,
  deckyPaneMounted: false,
};
/** Same rail with Decky's tab back on it (the ring still on Quick Settings). */
const RAIL_WITH_DECKY = { ...RAIL_NO_DECKY, deckyPaneMounted: true };
/** One DOWN along the rail later: Decky's pane is the one on screen, the ring still on the rail. */
const RAIL_AT_DECKY = { ...RAIL_WITH_DECKY, visibleQuickAccessTab: "999", visiblePane: "999" };
/** One RIGHT later: the ring is inside Decky's pane, on bonsAI's row. */
const IN_DECKY = { ...focusedPage, visiblePane: "999", ownsFocus: true, deckyPaneMounted: true };

function recorder() {
  const log: string[] = [];
  const ok = (buttons: string[], method: string): PressResult => ({
    ok: true,
    fidelity: "steam-routed",
    method,
    buttons,
    holdMs: 80,
  });
  return {
    log,
    count: (b: string) => log.filter((l) => l === `press:${b}`).length,
    chords: () => log.filter((l) => l.startsWith("chord:")).length,
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

/** A Quick Access page whose Decky tab comes back at `backAt` (epoch ms); `Infinity` means never. */
function deckyTabAppearsAt(backAt: number, rig: ReturnType<typeof recorder>) {
  return (title: string): unknown => {
    if (title !== "QuickAccess_uid2") return unfocusedPage;
    if (Date.now() < backAt) return RAIL_NO_DECKY;
    if (rig.count("RIGHT") > 0) return IN_DECKY;
    if (rig.count("DOWN") > 0) return RAIL_AT_DECKY;
    return RAIL_WITH_DECKY;
  };
}

test("Decky's tab is missing from the rail for a while: nothing is pressed until it is back, then ONE call opens the panel, and says how long it waited", async () => {
  const rig = recorder();
  const backAt = Date.now() + 700;
  let firstPressAt = 0;
  const page = deckyTabAppearsAt(backAt, rig);
  const fake = await startFakeCdp(TARGETS, page);
  try {
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 300,
      deckyTabWaitMs: 5000,
      deckyTabPollMs: 50,
      pressFn: async (o) => {
        firstPressAt ||= Date.now();
        return rig.pressFn(o);
      },
      chordFn: rig.chordFn,
    });
    assert.equal(r.ok, true, r.reason);
    assert.ok(firstPressAt >= backAt, "no press went out while the tab was missing");
    const wait = r.stages.find((s) => s.stage === "wait-decky-tab");
    assert.equal(wait?.ok, true);
    assert.equal(wait?.presses, 0);
    assert.match(wait?.detail ?? "", /came back after \d+ ms/);
    const waited = Number(/after (\d+) ms/.exec(wait?.detail ?? "")?.[1]);
    assert.ok(waited >= 500, `the stage reports the real wait (${waited} ms)`);
  } finally {
    await fake.close();
  }
});

test("Decky's tab never comes back: a clear refusal after the wait, nothing pressed, and the wait is not run a second time", async () => {
  const rig = recorder();
  const fake = await startFakeCdp(TARGETS, deckyTabAppearsAt(Infinity, rig));
  try {
    const started = Date.now();
    const r = await openPluginWithRetry({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 300,
      deckyTabWaitMs: 400,
      deckyTabPollMs: 50,
      retryDelayMs: 50,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(rig.log, [], "no press went along a rail that has no Decky entry");
    assert.match(r.reason ?? "", /Decky's tab did not come back/);
    assert.match(r.summary, /reload the plugin again/);
    const wait = r.stages.find((s) => s.stage === "wait-decky-tab");
    assert.equal(wait?.ok, false);
    assert.match(wait?.detail ?? "", /still missing from the Quick Access rail after \d+ ms/);
    assert.equal(r.retried, undefined, "a tab that stayed away for the whole wait is not given a second whole wait");
    assert.ok(Date.now() - started < 3000);
  } finally {
    await fake.close();
  }
});

test("when Decky's tab is already on the rail there is no wait stage and no extra delay", async () => {
  const rig = recorder();
  const fake = await startFakeCdp(TARGETS, deckyTabAppearsAt(0, rig));
  try {
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 300,
      deckyTabWaitMs: 5000,
      deckyTabPollMs: 50,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.stages.find((s) => s.stage === "wait-decky-tab"), undefined);
  } finally {
    await fake.close();
  }
});

test("a failed rail wait is never retried, but other no-press failures still are", () => {
  const base: OpenPluginResult = {
    ok: false, pluginName: "bonsAI", verified: false, fidelity: "wire-sent", stages: [], seen: [],
    focus: null, stopped: false, summary: "",
  };
  assert.equal(
    isRetryableOpenFailure({ ...base, stages: [{ stage: "wait-decky-tab", ok: false, detail: "", presses: 0 }] }),
    false,
  );
  assert.equal(isRetryableOpenFailure({ ...base, stages: [{ stage: "wait-decky-tab", ok: true, detail: "", presses: 0 }] }), true);
});

/**
 * The Deck, 2026-10-22 (plan 97 block A): the Decky tab did not come back in 90 s with the menu open; closing
 * the menu and opening it again brought it back, and the next try worked. This page behaves so: the tab is
 * mounted only once the menu has been closed and opened again (two chords), whatever the clock says. The menu
 * is shut after an odd number of chords. `ignoresChord` models a menu that does not react at all.
 */
function deckyTabNeedsReopen(rig: ReturnType<typeof recorder>, opts: { returnsAfterReopens?: number; ignoresChord?: boolean } = {}) {
  const need = opts.returnsAfterReopens ?? 1;
  return (title: string): unknown => {
    if (title !== "QuickAccess_uid2") return unfocusedPage;
    const chords = opts.ignoresChord ? 0 : rig.chords();
    if (chords % 2 === 1) return { ...unfocusedPage, visiblePane: null, ownsFocus: false, deckyPaneMounted: false };
    if (Math.floor(chords / 2) < need) return RAIL_NO_DECKY;
    if (rig.count("RIGHT") > 0) return IN_DECKY;
    if (rig.count("DOWN") > 0) return RAIL_AT_DECKY;
    return RAIL_WITH_DECKY;
  };
}

test("waiting alone does not bring the tab back: the menu is closed and opened again, and ONE call then opens the panel", async () => {
  const rig = recorder();
  const fake = await startFakeCdp(TARGETS, deckyTabNeedsReopen(rig));
  const started = Date.now();
  let firstRailPressAt = 0;
  let secondChordAt = 0;
  try {
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 300,
      deckyTabWaitMs: 5000,
      deckyTabPollMs: 30,
      deckyTabReopenEveryMs: 200,
      pressFn: async (o) => {
        firstRailPressAt ||= Date.now();
        return rig.pressFn(o);
      },
      chordFn: async (h, t) => {
        const res = await rig.chordFn(h, t);
        if (rig.chords() === 2) secondChordAt = Date.now();
        return res;
      },
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(rig.chords(), 2, "closed once, opened once, and no third chord");
    assert.ok(Date.now() - started >= 200, "it waited the 'every N ms' before the first reopen");
    assert.ok(firstRailPressAt > secondChordAt, "the rail was walked only after the menu was open again");
    const reopen = r.stages.filter((s) => s.stage === "reopen-qam");
    assert.equal(reopen.length, 1);
    assert.equal(reopen[0].ok, true);
    assert.equal(reopen[0].presses, 2);
    assert.match(reopen[0].detail, /closed the menu and opened it again/);
    const wait = r.stages.find((s) => s.stage === "wait-decky-tab");
    assert.equal(wait?.ok, true);
    assert.match(wait?.detail ?? "", /1 close-and-reopen of the menu/);
  } finally {
    await fake.close();
  }
});

test("a tab that needs two reopens gets two, each in the stage log, and the menu is left open", async () => {
  const rig = recorder();
  const fake = await startFakeCdp(TARGETS, deckyTabNeedsReopen(rig, { returnsAfterReopens: 2 }));
  try {
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 300,
      deckyTabWaitMs: 8000,
      deckyTabPollMs: 30,
      deckyTabReopenEveryMs: 150,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(rig.chords(), 4);
    assert.equal(r.stages.filter((s) => s.stage === "reopen-qam").length, 2);
    assert.match(r.stages.find((s) => s.stage === "wait-decky-tab")?.detail ?? "", /2 close-and-reopens/);
  } finally {
    await fake.close();
  }
});

test("a tab that never comes back is reopened a bounded number of times, then a clear refusal, with the menu left OPEN", async () => {
  const rig = recorder();
  const fake = await startFakeCdp(TARGETS, deckyTabNeedsReopen(rig, { returnsAfterReopens: 1000 }));
  try {
    const r = await openPluginWithRetry({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 300,
      deckyTabWaitMs: 6000,
      deckyTabPollMs: 30,
      deckyTabReopenEveryMs: 250,
      retryDelayMs: 50,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
    });
    assert.equal(r.ok, false);
    const reopens = r.stages.filter((s) => s.stage === "reopen-qam").length;
    assert.ok(reopens >= 2 && reopens <= 5, `bounded by the wait over the interval, got ${reopens}`);
    assert.equal(rig.chords(), reopens * 2);
    assert.equal(rig.count("DOWN") + rig.count("LEFT") + rig.count("RIGHT"), 0, "no D-pad press along a rail with no Decky entry");
    assert.match(r.reason ?? "", /Decky's tab did not come back/);
    assert.equal(r.retried, undefined, "no second whole wait");
    assert.equal(rig.chords() % 2, 0, "every close was followed by an open");
  } finally {
    await fake.close();
  }
});

test("a menu that does not shut when asked is not toggled again on a guess", async () => {
  const rig = recorder();
  const fake = await startFakeCdp(TARGETS, deckyTabNeedsReopen(rig, { returnsAfterReopens: 1000, ignoresChord: true }));
  try {
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 300,
      deckyTabWaitMs: 5000,
      deckyTabPollMs: 30,
      deckyTabReopenEveryMs: 100,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
    });
    assert.equal(r.ok, false);
    assert.equal(rig.chords(), 1, "one close chord, no open chord on top of it");
    assert.match(r.reason ?? "", /did not close when asked/);
    const reopen = r.stages.find((s) => s.stage === "reopen-qam");
    assert.equal(reopen?.ok, false);
    assert.equal(reopen?.presses, 1);
  } finally {
    await fake.close();
  }
});
