/**
 * Tests for deck_openPlugin waiting for Decky's tab to be back on the Quick
 * Access rail (plan 97, lane X2).
 *
 * The Deck, 2026-10-17 (plan 94 block 7): after deck_reloadPlugin the Decky tab
 * (pane 999) was missing from the rail for over 100 s. Two deck_openPlugin tries
 * failed with "walked 10 rail entries without the Decky pane appearing"; the
 * third worked, with the tab back. A walk along a rail with no Decky entry can
 * only fail, so the tool now presses nothing while the menu is open and the page
 * has no Decky pane, polls for up to 120 s, and says how long it waited.
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
    assert.match(r.summary, /close and reopen the Quick Access menu/);
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
