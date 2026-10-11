/**
 * Tests for deck.openPlugin's start over a running game (plan 07 § 6.1).
 *
 * Everything else in openPlugin is verified on hardware and by the readFocus
 * and cdp suites; what is pinned here is the one decision measured to go wrong
 * on 2026-09-02 -- which press goes out FIRST when no page carries a ring --
 * and its two neighbours, so the fix cannot quietly widen:
 *
 *   no ring, no pane on screen  -> the QAM chord, then no D-pad press until a
 *                                  read shows Steam UI on screen
 *   no ring, a pane on screen   -> the acquire DOWN, as before (doc 03: the
 *                                  normal start state; a chord would close it)
 *   chord sent, still no pane   -> a refusal, and still no D-pad press
 *
 * The fake CEF answers reads by count, in the order openPluginDriven makes
 * them; each test spells that order out, because a test that depends on it
 * must say so.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";

import { startFakeCdp, focusedPage, unfocusedPage } from "./__testutil__/fakeCdp.js";
import { openPluginDriven } from "./openPlugin.js";
import { noteLoaderRestart, msSinceLoaderRestart, clearLoaderRestart, RESTART_WINDOW_MS } from "./loaderRestart.js";
import type { PressOptions, PressResult } from "./pressButton.js";

const TARGETS = ["SharedJSContext", "QuickAccess_uid2"];
/** What the Quick Access page's own probe answers. */
const MENU_SHUT = { visiblePane: null, ownsFocus: false };
const MENU_OPEN = { visiblePane: "999", ownsFocus: false };
const HL2_RUNNING = [{ appid: 220, display_name: "Half-Life 2" }];

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

test("no ring anywhere and no pane on screen: the chord goes first, and no D-pad press goes into the game", async () => {
  /*
   * Read order: 0-1 the initial focus scan (both pages, no marker); 2 the
   * Quick Access page's own probe (menu shut); 3 RunningApps (Half-Life 2);
   * -- chord -- ; 4-5 the re-read, where the Quick Access page now carries the
   * ring on bonsAI's row with pane 999 on screen; 6+ the read after the A.
   */
  const fake = await startFakeCdp(TARGETS, (title, i) => {
    if (i < 2) return unfocusedPage;
    if (i === 2) return MENU_SHUT;
    if (i === 3) return HL2_RUNNING;
    return title === "QuickAccess_uid2" ? focusedPage : unfocusedPage;
  });
  const rig = recorder();
  try {
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 0,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(rig.log[0], "chord:GUIDE>A", "the chord is the FIRST thing sent");
    assert.ok(!rig.log.includes("press:DOWN"), "no acquire press into the game");
    assert.deepEqual(rig.log, ["chord:GUIDE>A", "press:A"]);
    const blind = r.stages.find((s) => s.stage === "open-qam-blind");
    assert.ok(blind, "the stage is recorded");
    assert.equal(blind.ok, true);
    assert.match(blind.detail, /RunningApps: Half-Life 2 \[220\]/);
    assert.match(blind.detail, /pane 999 is on screen/);
    assert.equal(r.stages.find((s) => s.stage === "acquire-focus"), undefined);
    assert.equal(
      r.stages.find((s) => s.stage === "open-qam"),
      undefined,
      "the ordinary chord stage did not fire a second toggle at the menu it just opened",
    );
  } finally {
    await fake.close();
  }
});

test("no ring but a pane on screen is an unowned ring in the open menu: the acquire press, never the chord", async () => {
  /*
   * Doc 03's state, the one this tool is usually called from. Read order: 0-1
   * the scan; 2 the probe (pane 999 on screen); -- DOWN -- ; 3-4 the re-read
   * with the ring placed; 5+ after the A.
   */
  const fake = await startFakeCdp(TARGETS, (title, i) => {
    if (i < 2) return unfocusedPage;
    if (i === 2) return MENU_OPEN;
    return title === "QuickAccess_uid2" ? focusedPage : unfocusedPage;
  });
  const rig = recorder();
  try {
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 0,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(rig.log[0], "press:DOWN", "Steam UI is on screen, so the ring is placed, as before");
    assert.ok(!rig.log.some((l) => l.startsWith("chord:")), "a chord here would have closed the open menu");
    assert.equal(r.stages.find((s) => s.stage === "open-qam-blind"), undefined);
    assert.equal(r.stages.find((s) => s.stage === "acquire-focus")?.ok, true);
  } finally {
    await fake.close();
  }
});

test("the chord over a surface that owns input, with no pane appearing afterwards, is a refusal with no D-pad press", async () => {
  /*
   * Read order: 0-1 the scan; 2 the probe (shut); 3 RunningApps (empty -- a
   * full-screen surface, not a game); -- chord -- ; 4-5 the re-read, still no
   * marker; 6 the probe again, still shut.
   */
  const fake = await startFakeCdp(TARGETS, (_title, i) => {
    if (i === 2 || i === 6) return MENU_SHUT;
    if (i === 3) return [];
    return unfocusedPage;
  });
  const rig = recorder();
  try {
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 0,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(rig.log, ["chord:GUIDE>A"], "the chord went out; nothing else did");
    assert.match(r.reason ?? "", /no quickaccess pane appeared/);
    assert.match(r.summary, /no D-pad press was sent into it/);
    const blind = r.stages.find((s) => s.stage === "open-qam-blind");
    assert.equal(blind?.ok, false);
    assert.match(blind?.detail ?? "", /RunningApps is empty/);
    assert.ok(r.checklist?.length, "a refusal hands back the manual steps");
    assert.equal(
      r.fidelity,
      "wire-sent",
      "the chord went out and no pane appeared, so nothing established that it reached Steam -- until 2026-09-08 this path claimed steam-routed off a press count",
    );
  } finally {
    await fake.close();
  }
});

/*
 * After a plugin reload (2026-10-11, seen twice before): the loader answers and
 * Steam's Big Picture page is listed, but the Quick Access page comes back some
 * seconds later. The open tool used to read at once, find the ring on a library
 * tile, ask for the Quick Access page for ten seconds, and refuse; the second
 * try then fired the toggle chord into a menu it had not read, and the third
 * worked. Now a reload leaves a note, and the open tool waits for the Quick
 * Access page to be listed AND readable before its first read.
 */
test("right after a reload, the first open waits for the Quick Access page and never fires the chord before it is readable", async () => {
  const t0 = Date.now();
  const qamBackAt = t0 + 900;
  const qamListed = (): boolean => Date.now() >= qamBackAt;
  const titles = (): string[] =>
    qamListed()
      ? ["SharedJSContext", "Steam Big Picture Mode", "QuickAccess_uid2"]
      : ["SharedJSContext", "Steam Big Picture Mode"];
  const libraryTile = {
    ...unfocusedPage,
    hasGpfocus: true,
    gpfocus: { ...focusedPage.gpfocus, selector: "#library-tile", text: "Half-Life 2", ownerText: "Half-Life 2" },
  };
  // Per page: the Quick Access page is asked (in this order) by the pre-read
  // wait, the focus scan, the menu probe, then reads after the chord.
  const asked: Record<string, number> = {};
  let chordSent = false;
  const fake = await startFakeCdp(titles, (title) => {
    const n = (asked[title] = (asked[title] ?? -1) + 1);
    if (title === "Steam Big Picture Mode") return chordSent ? unfocusedPage : libraryTile;
    if (title === "QuickAccess_uid2") {
      if (n === 0 || n === 2) return MENU_SHUT; // the waits' / probe's own word
      if (n === 1) return unfocusedPage; // the scan
      return focusedPage;
    }
    return unfocusedPage;
  });
  const log: string[] = [];
  const rig = recorder();
  try {
    noteLoaderRestart("test-reload");
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 200, // the old limit is far shorter than the Deck's gap
      afterRestartSettleMs: 5000,
      restartMachine: "test-reload",
      pressFn: rig.pressFn,
      chordFn: async (hold, tap) => {
        log.push(`chord when the Quick Access page was ${qamListed() ? "listed" : "NOT listed"}`);
        chordSent = true;
        return rig.chordFn(hold, tap);
      },
    });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(log, ["chord when the Quick Access page was listed"], "one chord, and only after the page was readable");
    assert.ok(
      r.stages.some((s) => s.stage === "wait-qam-after-restart" && s.ok),
      "the wait is recorded as a stage",
    );
  } finally {
    clearLoaderRestart("test-reload");
    await fake.close();
  }
});

test("with no reload noted, the open tool does not add the wait: a late Quick Access page is refused at the old limit, nothing pressed", async () => {
  const qamBackAt = Date.now() + 900;
  const titles = (): string[] =>
    Date.now() >= qamBackAt
      ? ["SharedJSContext", "Steam Big Picture Mode", "QuickAccess_uid2"]
      : ["SharedJSContext", "Steam Big Picture Mode"];
  const fake = await startFakeCdp(titles, (title) =>
    title === "Steam Big Picture Mode"
      ? { ...unfocusedPage, hasGpfocus: true, gpfocus: { ...focusedPage.gpfocus, text: "Half-Life 2", ownerText: "Half-Life 2" } }
      : title === "QuickAccess_uid2"
        ? MENU_SHUT
        : unfocusedPage,
  );
  const rig = recorder();
  try {
    clearLoaderRestart("test-plain");
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 200,
      afterRestartSettleMs: 5000,
      restartMachine: "test-plain",
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(rig.log, [], "nothing was pressed");
    assert.equal(r.stages.find((s) => s.stage === "wait-qam-after-restart"), undefined);
  } finally {
    await fake.close();
  }
});

test("a reload note that is too old is ignored", () => {
  noteLoaderRestart("old-note", Date.now() - RESTART_WINDOW_MS - 1000);
  assert.equal(msSinceLoaderRestart("old-note"), null);
  noteLoaderRestart("fresh-note");
  assert.ok((msSinceLoaderRestart("fresh-note") ?? Infinity) < 1000);
  clearLoaderRestart("fresh-note");
  assert.equal(msSinceLoaderRestart("fresh-note"), null);
});

test("a menu that is slow to appear after the chord is waited for, not reported as a failure and left open", async () => {
  /*
   * Read order, no reload note: the scan (Big Picture carries a ring, the Quick
   * Access page n=0 does not); the menu probe (n=1, shut); -- chord -- ; the read
   * 900 ms later, where the menu has not drawn yet (n=2); then the re-reads,
   * where it has (n>=3). Before the fix the first read after the chord was the
   * only one, so this was "no quickaccess pane became visible" with the menu
   * open a moment later -- and the next call found it open.
   */
  const asked: Record<string, number> = {};
  let chordSent = false;
  const fake = await startFakeCdp(["SharedJSContext", "Steam Big Picture Mode", "QuickAccess_uid2"], (title) => {
    const n = (asked[title] = (asked[title] ?? -1) + 1);
    if (title === "Steam Big Picture Mode") {
      return chordSent
        ? unfocusedPage
        : { ...unfocusedPage, hasGpfocus: true, gpfocus: { ...focusedPage.gpfocus, text: "Half-Life 2", ownerText: "Half-Life 2" } };
    }
    if (title === "QuickAccess_uid2") {
      if (n === 1) return MENU_SHUT;
      if (n <= 2) return unfocusedPage;
      return focusedPage;
    }
    return unfocusedPage;
  });
  const rig = recorder();
  try {
    clearLoaderRestart("test-slow-menu");
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 200,
      restartMachine: "test-slow-menu",
      pressFn: rig.pressFn,
      chordFn: async (hold, tap) => {
        chordSent = true;
        return rig.chordFn(hold, tap);
      },
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(rig.log.filter((l) => l.startsWith("chord:")).length, 1, "the toggle chord is sent once, never again");
    assert.equal(r.stages.find((s) => s.stage === "open-qam")?.ok, true);
  } finally {
    await fake.close();
  }
});
