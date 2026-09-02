/**
 * Tests for the CDP client and the focus oracle.
 *
 * These run against a fake CDP server started in-process, so they need no Deck
 * and no network. That matters for two reasons: the hand-rolled WebSocket
 * framing in ws.ts is the riskiest code in this feature and needs a real
 * round-trip to prove it, and anyone without a Steam Deck still has to be able
 * to run the suite.
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

import { evaluate, listTargets, getVersion, rewriteWsHost, hasSteamUiTargets } from "./cdp.js";
import { readFocusAt, probeQuickAccess } from "./readFocus.js";
import { pressButton, pressChord, findPadTool, findBridgeTool } from "./pressButton.js";
import { assertFocusMove } from "./assertFocusMove.js";
import { openPluginDriven } from "./openPlugin.js";

test("lists targets and reads the browser version", async () => {
  const fake = await startFakeCdp(["SharedJSContext"], () => unfocusedPage);
  try {
    const targets = await listTargets(fake.base);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].title, "SharedJSContext");
    const v = await getVersion(fake.base);
    assert.match(v.browser ?? "", /Chrome/);
  } finally {
    await fake.close();
  }
});

test("Runtime.evaluate round-trips through the hand-rolled websocket", async () => {
  const fake = await startFakeCdp(["OnlyTarget"], () => focusedPage);
  try {
    const [t] = await listTargets(fake.base);
    const value = await evaluate<typeof focusedPage>(
      rewriteWsHost(t.webSocketDebuggerUrl!, fake.base),
      "1",
    );
    // A reply well over 125 bytes, so the 16-bit length path is what carried it.
    assert.equal(value.hasGpfocus, true);
    assert.equal(value.gpfocus?.text, "bonsAI");
  } finally {
    await fake.close();
  }
});

test("finds the target that carries gpfocus, not the first one", async () => {
  // Deliberately mirrors the live Deck: SharedJSContext is listed first and is
  // empty; the QAM target is the one that actually owns focus.
  const fake = await startFakeCdp(["SharedJSContext", "MainMenu_uid2", "QuickAccess_uid2"], (t) =>
    t === "QuickAccess_uid2" ? focusedPage : unfocusedPage,
  );
  try {
    const r = await readFocusAt(fake.base);
    assert.equal(r.ok, true);
    assert.equal(r.method, "cdp:QuickAccess_uid2");
    assert.equal(r.fidelity, "steam-owned");
    assert.deepEqual(r.targetsScanned, [
      "SharedJSContext",
      "MainMenu_uid2",
      "QuickAccess_uid2",
    ]);
  } finally {
    await fake.close();
  }
});

test("reports the gpfocus/activeElement disagreement", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => focusedPage);
  try {
    const r = await readFocusAt(fake.base);
    assert.equal(r.agree, false, "the trap: Steam and the browser disagree");
    assert.equal(r.gpfocus?.text, "bonsAI");
    assert.equal(r.activeElement?.text, "something else");
    assert.equal(r.deckyPluginRoot, true);
    assert.equal(r.quickAccessTab, "999");
  } finally {
    await fake.close();
  }
});

test("no gpfocus anywhere fails loudly rather than reporting null focus", async () => {
  // A renamed Steam class must never read as "nothing is focused".
  const fake = await startFakeCdp(["SharedJSContext", "MainMenu_uid2"], () => unfocusedPage);
  try {
    const r = await readFocusAt(fake.base);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /gpfocus marker not found/);
    assert.match(r.reason ?? "", /SharedJSContext, MainMenu_uid2/);
    assert.equal(r.fidelity, null);
  } finally {
    await fake.close();
  }
});

test("an unreachable endpoint returns the preflight remediation, not a socket error", async () => {
  const r = await readFocusAt("http://127.0.0.1:1", 1500);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /cef-enable-remote-debugging/);
  assert.match(r.reason ?? "", /ssh -N -L 8080/);
});

test("rewriteWsHost points a target's own address at the tunnel we dialled", () => {
  assert.equal(
    rewriteWsHost("ws://127.0.0.1:8080/devtools/page/AB", "http://127.0.0.1:18080"),
    "ws://127.0.0.1:18080/devtools/page/AB",
  );
});

// --------------------------------------------------------------------------
// Press + assert. These cover the refusal paths, which are the ones that must
// never quietly degrade -- a synthetic press that "succeeds" is the exact bug
// this feature exists to remove. The happy path needs a Deck and a bridge and
// is verified on hardware instead.
// --------------------------------------------------------------------------

test("pressButton refuses an unknown button instead of guessing", async () => {
  const r = await pressButton({ buttons: ["DIAGONAL"] });
  assert.equal(r.ok, false);
  assert.equal(r.fidelity, null);
  assert.match(r.reason ?? "", /Unknown button/);
  assert.match(r.reason ?? "", /UP, DOWN, LEFT, RIGHT/);
});

test("pressButton refuses an empty press", async () => {
  const r = await pressButton({ buttons: [] });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /No buttons given/);
});

test("pressButton normalises case before validating", async () => {
  // "down" is a real button; the refusal must not be about the name.
  const r = await pressButton({ buttons: ["down"], timeoutMs: 1 });
  assert.equal(r.buttons[0], "DOWN");
  assert.doesNotMatch(r.reason ?? "", /Unknown button/);
});

test("the bridge tool is findable from the built server", () => {
  // If this breaks, every press refuses with a confusing "not found" message.
  assert.ok(findPadTool(), "bridge/tools/pad.py should be locatable by walking up");
});

test("assertFocusMove refuses when the Deck cannot be reached", async () => {
  const r = await assertFocusMove({ press: "DOWN", cdpUrl: "http://127.0.0.1:1" });
  assert.equal(r.ok, false);
  assert.equal(r.moved, false);
  assert.equal(r.fidelity, null);
  assert.match(r.diagnosis, /nothing was pressed/);
});

test("assertFocusMove refuses when no real press can be delivered", async () => {
  // Focus reads fine; the press is what fails. Nothing may be concluded about
  // the wiring from that, and the result must say so rather than report a move.
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => focusedPage);
  try {
    const r = await assertFocusMove({
      press: "NOT_A_BUTTON",
      cdpUrl: fake.base,
    });
    assert.equal(r.ok, false);
    assert.equal(r.moved, false);
    assert.equal(r.fidelity, null);
    assert.ok(r.before?.ok, "focus before the press was read successfully");
    assert.match(r.diagnosis, /no press was delivered/);
    assert.match(r.reason ?? "", /Unknown button/);
  } finally {
    await fake.close();
  }
});

// --------------------------------------------------------------------------
// Chords. Separate from presses because they are not interchangeable, and
// treating them as if they were cost real time on hardware.
// --------------------------------------------------------------------------

test("chord.py is findable from the built server", () => {
  // Without this every QAM open refuses with a confusing "not found".
  assert.ok(findBridgeTool("chord.py"), "bridge/tools/chord.py should be locatable by walking up");
});

test("pressChord refuses an unknown button instead of guessing", async () => {
  const r = await pressChord("GUIDE", "DIAGONAL");
  assert.equal(r.ok, false);
  assert.equal(r.fidelity, null);
  assert.match(r.reason ?? "", /Unknown button/);
});

test("pressChord reports the chord method, not the press method", async () => {
  // A post-mortem has to be able to tell which of the two was actually sent:
  // GUIDE+A as one press opens the Steam main menu, as a chord it opens the QAM.
  const r = await pressChord("GUIDE", "NOPE");
  assert.equal(r.method, "usb-hid:bridge:chord");
  const p = await pressButton({ buttons: ["GUIDE", "A"], timeoutMs: 1 });
  assert.equal(p.method, "usb-hid:bridge");
});

test("openPlugin refuses when the Deck cannot be reached, and still hands back the checklist", async () => {
  const r = await openPluginDriven({ pluginName: "bonsAI", cdpUrl: "http://127.0.0.1:1" });
  assert.equal(r.ok, false);
  assert.equal(r.verified, false);
  assert.ok(r.checklist && r.checklist.length > 0, "a human must still be able to do it by hand");
  assert.match(r.summary, /could not read the Deck/);
});

/** Ring on the QAM's left rail with the Decky pane already on screen. */
const onRail = {
  hasGpfocus: true,
  elementCount: 300,
  gpfocus: {
    selector: null, selectorVerified: false, tag: "DIV", id: null,
    classes: ["Focusable"], ariaLabel: null, text: "", ownerText: "", rect: null,
  },
  gpfocusWithin: [],
  activeElement: null,
  agree: false,
  quickAccessTab: null,
  visibleQuickAccessTab: "999",
  deckyPluginRoot: false,
};

test("openPlugin treats a visible pane as an open QAM even when the ring is on the rail", async () => {
  // The 2026-08-26 mistake: quickAccessTab is null on the rail, which read as
  // "QAM closed" and fired the open chord at an already-open menu. Here the ring
  // is on the rail (tab null) with the Decky pane showing, so the tool must
  // neither re-open the menu nor go hunting for a tab that is already up.
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => onRail);
  try {
    const r = await openPluginDriven({ pluginName: "bonsAI", cdpUrl: fake.base, listBudget: 1 });
    const names = r.stages.map((s) => s.stage);
    assert.ok(!names.includes("open-qam"), `must not try to open an open QAM: ${names.join(",")}`);
    assert.ok(!names.includes("find-decky-tab"), "the Decky pane is already showing");
  } finally {
    await fake.close();
  }
});

test("openPlugin steps INTO the Decky pane when the ring is stranded on the rail", async () => {
  /*
   * Found on the rig 2026-08-28, alongside P1-9. The Decky pane was already the
   * visible one and the ring was on the QAM's left rail -- the normal state
   * right after a game launches, which is exactly when you reach for this tool.
   * Every navigation step sat under one `visibleQuickAccessTab !== DECKY_TAB`
   * guard, so all of them were skipped, including the RIGHT press that enters
   * the pane. Stage 3 then walked DOWN the RAIL and gave up after 2 presses
   * ("walked 2 control(s) without finding bonsAI") when one RIGHT was all it
   * needed.
   *
   * The suite's hardware guard refuses real presses, so what is pinned here is
   * that the tool TRIES to enter the pane -- the failure must be the press not
   * being deliverable, not a walk that concluded the plugin is not there.
   */
  const pressed: string[] = [];
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => onRail);
  try {
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      listBudget: 25,
      // The suite refuses real presses, so without this seam every navigation
      // path collapses to the same "no press could be delivered" and the test
      // cannot tell RIGHT-into-the-pane from DOWN-along-the-rail.
      pressFn: async ({ buttons }) => {
        pressed.push(buttons.join("+"));
        return { ok: false, reason: "fake press", fidelity: null, method: "test", buttons, holdMs: 0 };
      },
    });

    assert.equal(pressed[0], "RIGHT", `the first press must enter the pane, not walk the rail: ${pressed.join(",")}`);
    assert.ok(!pressed.includes("A"), "and nothing may be activated while the ring is still outside the pane");
    assert.equal(r.ok, false, "the fake press fails, so the run cannot succeed -- the order is the point");
  } finally {
    await fake.close();
  }
});

// --------------------------------------------------------------------------
// Already-open panels. The list search only ever checks a control's own
// text, which is exactly what fails right after a plugin opens: doc 03
// measured the ring landing on an unlabelled Back button. Before this fix
// openPlugin walked the (nonexistent) list and reported "not found" even
// though its own read already proved the panel was open.
// --------------------------------------------------------------------------

/*
 * Ring on a control inside an already-open panel.
 *
 * The identifying evidence is `deckyPanelLabels`: Decky renders the open
 * plugin's name as a discrete label in the panel header, and that is the only
 * thing on the page saying WHICH plugin is open (deckyPluginRoot is just
 * "tab 999", true of every plugin alike). Measured on the live rig 2026-08-27.
 *
 * The focused control here deliberately carries prose that MENTIONS the plugin
 * name without being its label -- the real suggestion chip that made the first
 * version of this misfire.
 */
const bonsaiPanelOpen = {
  hasGpfocus: true,
  elementCount: 350,
  gpfocus: {
    selector: null,
    selectorVerified: false,
    tag: "BUTTON",
    id: null,
    classes: ["Focusable"],
    ariaLabel: null,
    text: "write a long detailed explanation of how bonsai trees are pruned",
    ownerText: "write a long detailed explanation of how bonsai trees are pruned",
    rect: null,
  },
  gpfocusWithin: [],
  activeElement: null,
  agree: false,
  quickAccessTab: "999",
  visibleQuickAccessTab: "999",
  deckyPluginRoot: true,
  deckyPanelLabels: ["bonsAI", "v0.5.0", "ask", "Show diagnostics"],
};

test("openPlugin recognises its own panel already open instead of walking the list for nothing", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => bonsaiPanelOpen);
  try {
    const r = await openPluginDriven({ pluginName: "bonsAI", cdpUrl: fake.base, listBudget: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.verified, true);
    assert.equal(r.alreadyOpen, true);
    assert.match(r.summary, /already open/);
    const findPlugin = r.stages.find((s) => s.stage === "already-open");
    assert.ok(findPlugin, "must record the stage that made the call, for post-mortems");
    assert.equal(findPlugin?.presses, 0, "detecting this must not cost a press");
  } finally {
    await fake.close();
  }
});

test("a different plugin's panel being open still fails rather than being waved through", async () => {
  // Conservative by design: only the requested plugin's own evidence may
  // short-circuit the search. TabMaster's panel being open must not be read
  // as bonsAI being open.
  const otherPluginOpen = {
    ...bonsaiPanelOpen,
    // Neutral control text: this case is about the PANEL being someone else's,
    // so the focused control must not itself mention bonsAI -- that is a
    // separate defect, covered by its own test below.
    gpfocus: { ...bonsaiPanelOpen.gpfocus, text: "Enable overlay", ownerText: "Enable overlay" },
    deckyPanelLabels: ["TabMaster", "v1.2.0", "Settings"],
  };
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => otherPluginOpen);
  try {
    // listBudget:0 so the walk never presses -- the suite's hardware guard
    // refuses real presses, and the point here is the pre-walk check, not the
    // walk itself.
    const r = await openPluginDriven({ pluginName: "bonsAI", cdpUrl: fake.base, listBudget: 0 });
    assert.equal(r.ok, false);
    assert.equal(r.alreadyOpen, undefined);
    assert.match(r.summary, /walked \d+ control\(s\) on the Decky tab/);
  } finally {
    await fake.close();
  }
});

test("prose that merely mentions the plugin's name is not the plugin's panel", async () => {
  /*
   * The regression the live rig taught, 2026-08-27. The first detector asked
   * whether the focused control's text CONTAINED the plugin name, and the ring
   * was sitting on a chip reading "...how bonsai trees are pruned". That made
   * isPluginRow claim it had found the plugin's list row, so openPlugin pressed
   * A on a suggestion chip. Here the panel header label is absent, so nothing
   * identifies this as bonsAI's panel and the tool must not claim it is.
   */
  const proseOnly = {
    ...bonsaiPanelOpen,
    deckyPanelLabels: ["TabMaster", "Settings"],
  };
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => proseOnly);
  try {
    const r = await openPluginDriven({ pluginName: "bonsAI", cdpUrl: fake.base, listBudget: 2 });
    assert.notEqual(r.alreadyOpen, true, "a chip mentioning the name is not the panel header");
  } finally {
    await fake.close();
  }
});

test("the panel label match is whole-label, not a substring of a longer label", async () => {
  const nearMiss = {
    ...bonsaiPanelOpen,
    deckyPanelLabels: ["bonsAI Helper", "v0.5.0"],
  };
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => nearMiss);
  try {
    const r = await openPluginDriven({ pluginName: "bonsAI", cdpUrl: fake.base, listBudget: 2 });
    assert.notEqual(r.alreadyOpen, true, '"bonsAI Helper" is a different plugin from "bonsAI"');
  } finally {
    await fake.close();
  }
});

/*
 * P1-9: the mirror image, and a direct cost of the fix above.
 *
 * Decky's plugin LIST advertises every installed plugin's name as a label of its
 * own, so "the requested name is among the pane's labels" is true of the list
 * exactly as it is of the plugin's open panel. Three times in one session --
 * each after a plugin_loader restart, which closes the panel -- the tool
 * returned ok/verified/alreadyOpen with the ring on a 40x28 button in the DECKY
 * PANE HEADER and no .bonsai-scope anywhere in the document. The caller then
 * spent three read-and-navigate rounds acting on a panel that was not there.
 *
 * The label set in the payload that claimed success is reproduced verbatim.
 */
const deckyListShowing = {
  ...bonsaiPanelOpen,
  gpfocus: {
    ...bonsaiPanelOpen.gpfocus,
    text: "",
    ownerText: "",
    label: "",
    labelSource: null,
    labelOverflow: false,
    rect: { x: 320, y: 20, w: 40, h: 28 },
  },
  deckyPanelLabels: ["Decky", "bonsAI", "TabMaster", "MagicPods"],
};

test("P1-9: a plugin's name in the Decky LIST is not that plugin's panel being open", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => deckyListShowing);
  try {
    const r = await openPluginDriven({ pluginName: "bonsAI", cdpUrl: fake.base, listBudget: 0 });
    assert.notEqual(r.alreadyOpen, true, "the list showing every plugin's name is not any of them being open");
    assert.ok(
      !r.stages.some((s) => s.stage === "already-open"),
      "and it must not record the stage that would have made that claim",
    );
  } finally {
    await fake.close();
  }
});

test("a rootSelector settles already-open in both directions, overriding the labels", async () => {
  /*
   * The definitive answer, and the one the ROADMAP asks for: the plugin's own
   * markup rather than an inference about Decky's. Both directions matter --
   * absent means NOT open however convincing the labels are, present means open.
   *
   * The fake CDP answers every evaluate with the same value, so the page read
   * for the selector gets this boolean too; that is enough to pin which of the
   * two signals wins.
   */
  const rootAbsent = await startFakeCdp(["QuickAccess_uid2"], (_t, i) =>
    // Read 0 is the focus read, and everything after is the selector probe.
    i === 0 ? bonsaiPanelOpen : false,
  );
  try {
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: rootAbsent.base,
      listBudget: 0,
      rootSelector: ".bonsai-scope",
    });
    assert.notEqual(r.alreadyOpen, true, "labels said open; the plugin's own root says otherwise and wins");
    const check = r.stages.find((s) => s.stage === "check-panel-root");
    assert.ok(check, "the check must be recorded, for post-mortems");
    assert.match(check!.detail, /not in the document/);
  } finally {
    await rootAbsent.close();
  }

  const rootPresent = await startFakeCdp(["QuickAccess_uid2"], (_t, i) =>
    i === 0 ? deckyListShowing : true,
  );
  try {
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: rootPresent.base,
      listBudget: 0,
      rootSelector: ".bonsai-scope",
    });
    assert.equal(r.alreadyOpen, true, "the plugin's root is mounted and on screen, so the panel IS open");
    assert.equal(r.ok, true);
  } finally {
    await rootPresent.close();
  }
});

// --------------------------------------------------------------------------
// Issue #3 (bonsAI, 2026-08-30): the seconds after deck_deploy restarts
// plugin_loader. CEF lists SharedJSContext and nothing else while Steam
// rebuilds its UI pages; a read then scanned that one page and reported the
// ring unowned, and deck_openPlugin fired its toggle chord on a null read
// from a page that has no Quick Access panes in it, closing an open menu.
// --------------------------------------------------------------------------

test("issue #3: hasSteamUiTargets is false for a SharedJSContext-only list, true once any UI page is listed", () => {
  const ws = "ws://127.0.0.1:1/devtools/page/x";
  const t = (title: string) => ({ id: title, type: "page", title, url: "", webSocketDebuggerUrl: ws });
  assert.equal(hasSteamUiTargets([]), false);
  assert.equal(hasSteamUiTargets([t("SharedJSContext")]), false);
  assert.equal(hasSteamUiTargets([t("SharedJSContext"), t("QuickAccess_uid2")]), true);
  assert.equal(
    hasSteamUiTargets([{ id: "x", type: "page", title: "MainMenu_uid2", url: "" }]),
    false,
    "a page with no debugger URL cannot be read, so it does not count",
  );
});

test("issue #3: a read asked to wait sees the Quick Access page appear and answers from it", async () => {
  // /json/list names only SharedJSContext for the first two polls, then the
  // rebuilt Quick Access page shows up -- the post-restart sequence.
  let polls = 0;
  const fake = await startFakeCdp(
    () => (++polls <= 2 ? ["SharedJSContext"] : ["SharedJSContext", "QuickAccess_uid2"]),
    (t) => (t === "QuickAccess_uid2" ? focusedPage : unfocusedPage),
  );
  try {
    const r = await readFocusAt(fake.base, 10_000, undefined, { targetsSettleMs: 5000, targetsPollMs: 50 });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.method, "cdp:QuickAccess_uid2");
    assert.ok((r.waitedForTargetsMs ?? 0) > 0, "the wait must be reported");
    assert.ok(fake.lists() >= 3, `expected the list to be polled until the page appeared, got ${fake.lists()}`);
  } finally {
    await fake.close();
  }
});

test("issue #3: a list that stays partial is reported as 'not enumerable', never as an unowned ring", async () => {
  const fake = await startFakeCdp(["SharedJSContext"], () => unfocusedPage);
  try {
    const r = await readFocusAt(fake.base, 10_000, undefined, { targetsSettleMs: 200, targetsPollMs: 50 });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /not enumerable/);
    assert.match(r.reason ?? "", /plugin_loader restart/);
    // The phrase every caller reads as "press a D-pad direction to place the ring".
    assert.doesNotMatch(r.reason ?? "", /gpfocus marker not found/);
    assert.equal(fake.evaluations(), 0, "nothing may be scanned: that page never carries the ring");
    assert.ok((r.waitedForTargetsMs ?? 0) >= 200, `waited ${r.waitedForTargetsMs}`);
  } finally {
    await fake.close();
  }
});

test("issue #3: with no wait asked for, a partial list is read exactly as before", async () => {
  const fake = await startFakeCdp(["SharedJSContext"], () => unfocusedPage);
  try {
    const r = await readFocusAt(fake.base);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /gpfocus marker not found/);
    assert.equal(fake.lists(), 1);
    assert.equal(r.waitedForTargetsMs, undefined);
  } finally {
    await fake.close();
  }
});

/** What the Quick Access page itself says when the menu is open on Decky's pane, or shut. */
const qamOpenOnDecky = { visiblePane: "999", ownsFocus: false };
const qamShut = { visiblePane: null, ownsFocus: false };

test("issue #3: probeQuickAccess answers from the Quick Access page, waiting for it to be listed", async () => {
  let polls = 0;
  const fake = await startFakeCdp(
    () => (++polls <= 2 ? ["SharedJSContext"] : ["SharedJSContext", "QuickAccess_uid2"]),
    () => qamOpenOnDecky,
  );
  try {
    const p = await probeQuickAccess(fake.base, { targetsSettleMs: 5000, targetsPollMs: 50 });
    assert.equal(p.listed, true);
    assert.equal(p.answered, true);
    assert.equal(p.target, "QuickAccess_uid2");
    assert.equal(p.visiblePane, "999");
    assert.ok(p.waitedMs > 0);
  } finally {
    await fake.close();
  }
});

test("issue #3: probeQuickAccess with no Quick Access page listed is unanswered, and says why", async () => {
  const fake = await startFakeCdp(["SharedJSContext", "Steam Big Picture Mode"], () => qamShut);
  try {
    const p = await probeQuickAccess(fake.base, { targetsSettleMs: 200, targetsPollMs: 50 });
    assert.equal(p.listed, false);
    assert.equal(p.answered, false);
    assert.match(p.reason ?? "", /no Quick Access page is listed/);
    assert.match(p.reason ?? "", /Steam Big Picture Mode/);
    assert.equal(fake.evaluations(), 0);
  } finally {
    await fake.close();
  }
});

/**
 * Ring on a library tile in Steam's main page: the read that lied about the
 * menu on attempt 2 of every deploy cycle. Its visibleQuickAccessTab is null
 * because this document has no quickaccess panes in it, not because the
 * menu is shut.
 */
const libraryTile = {
  hasGpfocus: true,
  elementCount: 346,
  gpfocus: {
    selector: null, selectorVerified: false, tag: "DIV", id: null,
    classes: ["Focusable"], ariaLabel: null, text: "Hades", ownerText: "Hades", rect: null,
  },
  gpfocusWithin: [],
  activeElement: null,
  agree: false,
  quickAccessTab: null,
  visibleQuickAccessTab: null,
  deckyPluginRoot: false,
};

/** The recording press seam every openPlugin case below shares. */
function recordingPress(pressed: string[]): NonNullable<Parameters<typeof openPluginDriven>[0]["pressFn"]> {
  return async ({ buttons }) => {
    pressed.push(buttons.join("+"));
    return { ok: false, reason: "fake press", fidelity: null, method: "test", buttons, holdMs: 0 };
  };
}

test("issue #3: openPlugin does NOT fire the toggle chord on a null read from another page when the QAM page says the menu is open", async () => {
  /*
   * The exact attempt-2 shape. The Quick Access page has been rebuilt and has
   * no ring in it yet; Steam's main page still carries one on a library tile;
   * the menu is open on Decky's pane. The old code read visibleQuickAccessTab
   * null from the main page and fired GUIDE+A, closing the menu. Now the QAM
   * page is asked, it reports pane 999 on screen, the ring is re-read until it
   * settles into that page, and the first press is the RIGHT that enters the
   * pane -- no chord anywhere.
   */
  const qamReads: number[] = [];
  const pressed: string[] = [];
  const fake = await startFakeCdp(
    ["SharedJSContext", "QuickAccess_uid2", "Steam Big Picture Mode"],
    (title) => {
      if (title === "Steam Big Picture Mode") return libraryTile;
      if (title !== "QuickAccess_uid2") return unfocusedPage;
      qamReads.push(qamReads.length);
      if (qamReads.length === 1) return unfocusedPage; // the initial scan: rebuilt page, no ring yet
      if (qamReads.length === 2) return qamOpenOnDecky; // the probe: pane 999 is on screen
      return onRail; // the ring has settled into the menu, on its rail
    },
  );
  try {
    const r = await openPluginDriven({ pluginName: "bonsAI", cdpUrl: fake.base, pressFn: recordingPress(pressed) });
    const names = r.stages.map((s) => s.stage);
    assert.ok(!names.includes("open-qam"), `the chord must not be fired at an open menu: ${names.join(",")}`);
    const probe = r.stages.find((s) => s.stage === "probe-qam");
    assert.ok(probe?.ok, JSON.stringify(probe));
    assert.match(probe!.detail, /pane 999 on screen/);
    assert.match(probe!.detail, /came from Steam Big Picture Mode/);
    const settled = r.stages.find((s) => s.stage === "settle-qam-focus");
    assert.ok(settled?.ok, JSON.stringify(settled));
    assert.equal(pressed[0], "RIGHT", `the first press enters the pane, nothing else: ${pressed.join(",")}`);
  } finally {
    await fake.close();
  }
});

test("issue #3: openPlugin refuses, with no press, when the QAM page says open but the ring never settles into it", async () => {
  const pressed: string[] = [];
  const fake = await startFakeCdp(
    ["SharedJSContext", "QuickAccess_uid2", "Steam Big Picture Mode"],
    (title) => {
      if (title === "Steam Big Picture Mode") return libraryTile;
      if (title === "QuickAccess_uid2") return { ...unfocusedPage, ...qamOpenOnDecky };
      return unfocusedPage;
    },
  );
  try {
    const r = await openPluginDriven({ pluginName: "bonsAI", cdpUrl: fake.base, pressFn: recordingPress(pressed) });
    assert.equal(r.ok, false);
    assert.deepEqual(pressed, [], "nothing may be pressed on a menu whose ring is elsewhere");
    const names = r.stages.map((s) => s.stage);
    assert.ok(!names.includes("open-qam"), names.join(","));
    assert.match(r.summary, /nothing was pressed/);
    assert.match(r.reason ?? "", /open \(pane 999 on screen\) but Steam's focus ring is not inside it/);
  } finally {
    await fake.close();
  }
});

test("issue #3: openPlugin still fires the chord when the QAM page itself says the menu is shut", async () => {
  // The legitimate case must survive the gate: the probe answers "no pane on
  // screen", so the chord is attempted. The suite's hardware guard refuses
  // the chord, and that refusal -- an open-qam stage -- is the proof.
  const pressed: string[] = [];
  const fake = await startFakeCdp(
    ["SharedJSContext", "QuickAccess_uid2", "Steam Big Picture Mode"],
    (title) => {
      if (title === "Steam Big Picture Mode") return libraryTile;
      if (title === "QuickAccess_uid2") return { ...unfocusedPage, ...qamShut };
      return unfocusedPage;
    },
  );
  try {
    const r = await openPluginDriven({ pluginName: "bonsAI", cdpUrl: fake.base, pressFn: recordingPress(pressed) });
    const probe = r.stages.find((s) => s.stage === "probe-qam");
    assert.ok(probe?.ok, JSON.stringify(probe));
    assert.match(probe!.detail, /menu is shut/);
    const chord = r.stages.find((s) => s.stage === "open-qam");
    assert.ok(chord, `the chord must be attempted once the QAM page says shut: ${r.stages.map((s) => s.stage).join(",")}`);
    assert.equal(r.ok, false, "the guard refuses the real chord, so the run cannot succeed -- the attempt is the point");
  } finally {
    await fake.close();
  }
});

test("issue #3: openPlugin refuses, with no press, while the Quick Access page is not listed at all", async () => {
  const pressed: string[] = [];
  const fake = await startFakeCdp(["SharedJSContext", "Steam Big Picture Mode"], (title) =>
    title === "Steam Big Picture Mode" ? libraryTile : unfocusedPage,
  );
  try {
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 200,
      pressFn: recordingPress(pressed),
    });
    assert.equal(r.ok, false);
    assert.deepEqual(pressed, []);
    const probe = r.stages.find((s) => s.stage === "probe-qam");
    assert.equal(probe?.ok, false, JSON.stringify(probe));
    assert.ok(!r.stages.some((s) => s.stage === "open-qam"));
    assert.match(r.summary, /not enumerable .* nothing was pressed/);
    assert.ok(r.checklist && r.checklist.length > 0);
  } finally {
    await fake.close();
  }
});

test("issue #3: openPlugin's first read waits out the restart instead of placing a ring that is not missing", async () => {
  /*
   * The attempt-1 shape: called seconds after deck_deploy, /json/list names
   * only SharedJSContext for a while. The old code scanned it, read "unowned",
   * pressed DOWN blind and then failed at read-initial. Now the read waits,
   * the rebuilt Quick Access page appears with the ring on its rail, and the
   * first press is the RIGHT that enters the Decky pane.
   */
  let polls = 0;
  const pressed: string[] = [];
  const fake = await startFakeCdp(
    () => (++polls <= 2 ? ["SharedJSContext"] : ["SharedJSContext", "QuickAccess_uid2"]),
    (title) => (title === "QuickAccess_uid2" ? onRail : unfocusedPage),
  );
  try {
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 5000,
      pressFn: recordingPress(pressed),
    });
    const names = r.stages.map((s) => s.stage);
    assert.ok(!names.includes("acquire-focus"), `no blind DOWN: ${names.join(",")}`);
    const initial = r.stages.find((s) => s.stage === "read-initial");
    assert.ok(initial?.ok, JSON.stringify(initial));
    assert.ok((r.focus?.waitedForTargetsMs ?? 0) > 0 || polls >= 3, "the read must have waited for the page");
    assert.equal(pressed[0], "RIGHT", pressed.join(","));
  } finally {
    await fake.close();
  }
});
