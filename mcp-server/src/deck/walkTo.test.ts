/**
 * Tests for deck.walkTo.
 *
 * The refusals and the matching rules are what can be pinned without a bridge
 * board, and they are the parts that caused real trouble on hardware: a
 * substring match landing one control short of the target, a toggle whose label
 * lives on an ancestor, and a dead end that quietly ate a whole budget.
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
import { walkTo, labelOf } from "./walkTo.js";
import type { PressOptions, PressResult } from "./pressButton.js";

/** A page whose ring sits on a control with the given label. */
function pageWith(text: string, ownerText = ""): unknown {
  return {
    hasGpfocus: true,
    elementCount: 300,
    gpfocus: {
      selector: null,
      selectorVerified: false,
      tag: "BUTTON",
      id: null,
      classes: ["Focusable"],
      ariaLabel: null,
      text,
      ownerText: ownerText || text,
      rect: null,
    },
    gpfocusWithin: [],
    activeElement: null,
    agree: false,
    quickAccessTab: "999",
    deckyPluginRoot: true,
  };
}

test("A, B and START are refused -- a walk must not be able to activate anything", async () => {
  for (const bad of ["A", "B", "START"]) {
    const r = await walkTo({ direction: bad as never, text: "anything" });
    assert.equal(r.ok, false);
    assert.equal(r.found, false);
    assert.match(r.reason ?? "", /must be one of UP, DOWN, LEFT, RIGHT/);
  }
});

test("an empty needle is refused rather than matching the first thing seen", async () => {
  const r = await walkTo({ direction: "DOWN", text: "   " });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /No text to look for/);
});

test("an unreachable Deck stops before any press", async () => {
  const r = await walkTo({ direction: "DOWN", text: "bonsAI", cdpUrl: "http://127.0.0.1:1" });
  assert.equal(r.ok, false);
  assert.equal(r.presses, 0);
  assert.match(r.summary, /could not read focus before the walk started/);
});

test("acquireFocus:false leaves an unowned ring alone and says what to do", async () => {
  // The state right after a plugin opens. With acquiring switched off nothing
  // is pressed at all, and the message has to point at the way forward.
  const fake = await startFakeCdp(["SharedJSContext"], () => unfocusedPage);
  try {
    const r = await walkTo({
      direction: "DOWN",
      text: "Retry",
      acquireFocus: false,
      cdpUrl: fake.base,
    });
    assert.equal(r.ok, false);
    assert.equal(r.presses, 0);
    assert.equal(r.acquired, false);
    assert.match(r.summary, /acquireFocus does that automatically/);
  } finally {
    await fake.close();
  }
});

test("acquiring an unowned ring needs the bridge, and says so when it is disabled", async () => {
  // With DPS_NO_BRIDGE set -- which the suite always sets -- the acquire press
  // cannot be delivered, so the walk must report that rather than pretending it
  // placed the ring. The press itself is verified on hardware, not here.
  const fake = await startFakeCdp(["SharedJSContext"], () => unfocusedPage);
  try {
    const r = await walkTo({ direction: "DOWN", text: "Retry", cdpUrl: fake.base });
    assert.equal(r.ok, false);
    assert.equal(r.acquired, false, "no press landed, so nothing was acquired");
    assert.equal(r.presses, 0);
  } finally {
    await fake.close();
  }
});

test("a match on the starting control costs no presses", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => focusedPage);
  try {
    const r = await walkTo({ direction: "DOWN", text: "bonsAI", cdpUrl: fake.base });
    assert.equal(r.found, true);
    assert.equal(r.presses, 0);
    assert.equal(r.matched, "bonsAI");
    assert.equal(r.fidelity, null, "nothing was pressed, so nothing was routed");
  } finally {
    await fake.close();
  }
});

test("found, but COVERED: a match the ring is on and a person cannot see is shouted", async () => {
  /*
   * The 2026-08-31 incident at the level a caller sees. The walk is right that
   * the ring is on "bonsAI" -- found: true stays true -- and a human could not
   * have seen it. The summary is the line a run log shows, so it says so, in
   * capitals, naming what is in the way.
   */
  const coveredPage = {
    ...focusedPage,
    visibility: {
      verdict: "covered",
      visiblePercent: 0,
      coveredBy: "div.bonsai-main-tab-dock > button.Focusable.bonsai-chip",
      clippedBy: null,
      points: { visible: 0, covered: 9, clipped: 0, offscreen: 0 },
    },
  };
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => coveredPage);
  try {
    const r = await walkTo({ direction: "DOWN", text: "bonsAI", cdpUrl: fake.base });
    assert.equal(r.found, true, "the ring IS on it; visibility is a second fact, not a retraction");
    assert.equal(r.visibility?.verdict, "covered");
    assert.match(r.summary, /found after 0 press\(es\).*but COVERED by div\.bonsai-main-tab-dock/);
  } finally {
    await fake.close();
  }
});

test("a visible match carries its verdict and a quiet summary", async () => {
  const visiblePage = {
    ...focusedPage,
    visibility: { verdict: "visible", visiblePercent: 100, coveredBy: null, clippedBy: null, points: { visible: 9, covered: 0, clipped: 0, offscreen: 0 } },
  };
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => visiblePage);
  try {
    const r = await walkTo({ direction: "DOWN", text: "bonsAI", cdpUrl: fake.base });
    assert.equal(r.visibility?.verdict, "visible");
    assert.doesNotMatch(r.summary, /COVERED|OFFSCREEN|PARTIALLY/);
  } finally {
    await fake.close();
  }
});

test("a substring match is flagged so a near miss cannot pass silently", async () => {
  // The real one: walking to "ask" stopped on "Attach screenshot to Ask", one
  // control before the send button. Pressing A there attaches a screenshot.
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => pageWith("Attach screenshot to Ask"));
  try {
    const r = await walkTo({ direction: "DOWN", text: "ask", cdpUrl: fake.base });
    assert.equal(r.found, true);
    assert.equal(r.matched, "Attach screenshot to Ask");
    assert.match(r.summary, /matched as a substring/);
  } finally {
    await fake.close();
  }
});

test("exact matching refuses the near miss", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => pageWith("Attach screenshot to Ask"));
  try {
    const r = await walkTo({
      direction: "DOWN",
      text: "ask",
      exact: true,
      budget: 2,
      cdpUrl: fake.base,
    });
    assert.equal(r.found, false, "exact mode must not accept the longer label");
  } finally {
    await fake.close();
  }
});

test("a control labelled only by its ancestor is still findable", () => {
  // Every Decky ToggleField. Without ownerText the ring reads as an anonymous DIV.
  const toggle = {
    ok: true,
    gpfocus: { text: "", ariaLabel: null, ownerText: "Hybrid retrieval (meaning search)" },
  } as never;
  assert.equal(labelOf(toggle), "Hybrid retrieval (meaning search)");
});

test("a control's own aria-label names it, ahead of its subtree text", () => {
  /*
   * P1-10, the cheaper half. Walking to "Move gemma4:e2b-it-qat up" landed the
   * ring exactly on that button and still returned found:false, matched:null --
   * the element was recorded in `seen` as "Up", because full-subtree text was
   * ranked ahead of the element's own aria-label. That shape is the norm for a
   * compact icon button in a repeated row, not an exotic case.
   */
  const upButton = {
    ok: true,
    gpfocus: {
      text: "Up",
      ariaLabel: "Move gemma4:e2b-it-qat up",
      ownerText: "",
      label: "Move gemma4:e2b-it-qat up",
      labelSource: "aria-label",
    },
  } as never;
  assert.equal(labelOf(upButton), "Move gemma4:e2b-it-qat up");
});

test("P1-10: a container's text cannot satisfy a walk", async () => {
  /*
   * THE FALSE SUCCESS, pinned at the level a caller sees.
   *
   * On the rig, deck_walkTo({direction:"RIGHT", text:"bonsAI"}) returned found
   * after ZERO presses without the ring moving, because the focused tab icon had
   * no name of its own and inherited the whole Quick Access Menu's text --
   * "NotificationsQuick SettingsPerformanceSoundtracksHelpDeckybonsAITabMaster..."
   * -- which contains "bonsAI". It did not stall, error or warn; it reported the
   * ring somewhere it was not, and every assertion after it inherited that.
   *
   * The page now refuses to name a container, so the label arrives empty with
   * labelOverflow set. A miss is the correct answer here; the walk must also not
   * claim to have seen anything it could not name.
   */
  const paneDump =
    "NotificationsQuick SettingsPerformanceSoundtracksHelpDeckybonsAITabMasterMagicPods";
  const containerPage = {
    hasGpfocus: true,
    elementCount: 300,
    gpfocus: {
      selector: null,
      selectorVerified: false,
      tag: "DIV",
      id: null,
      classes: ["Focusable"],
      ariaLabel: null,
      text: paneDump,
      ownerText: "",
      label: "",
      labelSource: null,
      labelOverflow: true,
      rect: { x: 8, y: 40, w: 59, h: 56 },
    },
    gpfocusWithin: [],
    activeElement: null,
    agree: false,
    quickAccessTab: "999",
    visibleQuickAccessTab: "999",
    deckyPluginRoot: true,
  };

  const fake = await startFakeCdp(["QuickAccess_uid2"], () => containerPage);
  try {
    const r = await walkTo({ direction: "RIGHT", text: "bonsAI", budget: 1, cdpUrl: fake.base });
    assert.equal(r.found, false, "a pane dump must never satisfy a walk for a control");
    assert.equal(r.matched, null);
    assert.deepEqual(r.seen, [], "an unnameable stop is not reported under a container's text");
    assert.equal(r.overshot, true, "and the caller is told the ring was on a container");
  } finally {
    await fake.close();
  }
});

test("a walk that cannot press says so rather than reporting a miss", async () => {
  /*
   * Stall detection -- giving up when the ring stops moving instead of spending
   * the whole budget -- cannot be unit tested, because exercising the loop needs
   * real presses and the suite is forbidden from sending them. An earlier
   * version of this test did press, on a real Deck, for eight seconds, which is
   * how the DPS_NO_BRIDGE guard came to exist.
   *
   * It is verified on hardware instead: at the bottom of the bonsAI panel the
   * shipped tool gives up after 3 presses with "this is the end of the line
   * going DOWN" rather than the 16 an earlier build spent there.
   *
   * What IS pinned here is that a walk which cannot press reports the refusal,
   * rather than walking zero controls and calling it "not found" -- those two
   * mean very different things to a caller.
   */
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => pageWith("Save chat to Desktop"));
  try {
    const r = await walkTo({ direction: "DOWN", text: "Retry", budget: 40, cdpUrl: fake.base });
    assert.equal(r.found, false);
    assert.match(r.reason ?? "", /DPS_NO_BRIDGE/);
    assert.match(r.summary, /no press could be delivered/);
    assert.deepEqual(r.seen, ["Save chat to Desktop"], "it still reports what it did see");
  } finally {
    await fake.close();
  }
});

test("an internally-paged container is not mistaken for a dead end", async () => {
  /*
   * The stall check used to compare only focusKey -- the focused element's
   * DOM identity -- between presses. A container that handles its own
   * direction presses internally (a context-chip strip, say) keeps the ring
   * on that SAME element while paging what it announces, so every press
   * "moved" nothing as far as focusKey was concerned even though the plugin
   * was responding correctly. Measured shape: walkTo reported stalled: true
   * after 3 presses when 2 more would have walked out of the strip onto the
   * next real control, which reads as a focus-trap bug in the plugin under
   * test when the plugin is fine.
   *
   * This uses the pressFn test seam (new, alongside AcquireFocusOptions'
   * existing one) to drive the walk's own loop through a scripted sequence
   * of reads without a bridge board -- the general stall test above could
   * only pin the "cannot press" refusal, because pressButton() itself always
   * refuses under DPS_NO_BRIDGE with no way to substitute it. That is an
   * honest tradeoff to flag: this test exercises the exact comparison the
   * fix changed (focusKey() and labelOf(), the shared accessible-name
   * resolver), over a fake CDP server, but the presses themselves are
   * simulated, not sent through pad.py -- the happy path still wants
   * confirming on a Deck against a real chip strip.
   */
  const STRIP_SELECTOR = "#chip-strip .chip";
  const STRIP_RECT = { x: 10, y: 20, w: 300, h: 40 };
  const chipPage = (label: string): unknown => ({
    hasGpfocus: true,
    elementCount: 300,
    gpfocus: {
      selector: STRIP_SELECTOR,
      selectorVerified: true,
      tag: "DIV",
      id: null,
      classes: ["Focusable", "chip-strip"],
      ariaLabel: label,
      text: label,
      ownerText: label,
      rect: STRIP_RECT,
    },
    gpfocusWithin: [],
    activeElement: null,
    agree: false,
    quickAccessTab: "999",
    deckyPluginRoot: true,
  });
  const nextControlPage: unknown = {
    hasGpfocus: true,
    elementCount: 300,
    gpfocus: {
      selector: "#retry-button",
      selectorVerified: true,
      tag: "BUTTON",
      id: null,
      classes: ["Focusable"],
      ariaLabel: null,
      text: "Retry",
      ownerText: "Retry",
      rect: { x: 10, y: 80, w: 120, h: 40 },
    },
    gpfocusWithin: [],
    activeElement: null,
    agree: false,
    quickAccessTab: "999",
    deckyPluginRoot: true,
  };
  // Read sequence: idx0 is the read before the first press, one more per
  // press after that. The strip announces chips 1..4 (same node, changing
  // label -- movement) then repeats chip 4 once for real (no change at all --
  // a genuine stall), before the ring finally leaves the strip.
  const reads = [
    chipPage("Chip 1 of 4"), // idx0: initial read
    chipPage("Chip 2 of 4"), // idx1: after press 1
    chipPage("Chip 3 of 4"), // idx2: after press 2
    chipPage("Chip 4 of 4"), // idx3: after press 3 -- old code stalls HERE
    chipPage("Chip 4 of 4"), // idx4: after press 4 -- a real repeat (1 stall)
    nextControlPage, // idx5: after press 5 -- escaped the strip
  ];
  const fake = await startFakeCdp(["QuickAccess_uid2"], (_title, idx) => reads[Math.min(idx, reads.length - 1)]);
  const fakePress = async (o: PressOptions): Promise<PressResult> => ({
    ok: true,
    fidelity: "steam-routed",
    method: "test-seam",
    buttons: o.buttons,
    holdMs: o.holdMs ?? 80,
  });
  try {
    const r = await walkTo({ direction: "RIGHT", text: "Retry", cdpUrl: fake.base, pressFn: fakePress });
    assert.equal(r.stalled, false, "a label change on the same node must count as movement, not a stall");
    assert.equal(r.found, true, r.summary);
    assert.equal(r.matched, "Retry");
    assert.equal(r.presses, 5, "3 presses paging the strip, 1 genuine repeat, 1 that finally left it");
    assert.equal(
      r.fidelity,
      "wire-sent",
      "press 4 moved nothing, so the walk may not claim steam-routed for the run -- and note the fake press reports steam-routed at the wire, so this also pins that walkTo EARNS the value from its own focus reads rather than passing pressButton's through",
    );
  } finally {
    await fake.close();
  }
});

test("a walk whose every press moved focus keeps steam-routed", async () => {
  /*
   * The companion to the chip-strip case above. Same seam, same fake press,
   * but every read differs from the one before it -- so every press earned the
   * stronger value and the fold has nothing to drag it down. Without this, a
   * fold that simply always answered "wire-sent" would pass the test above.
   */
  const control = (label: string, y: number): unknown => ({
    hasGpfocus: true,
    elementCount: 300,
    gpfocus: {
      selector: `#control-${y}`,
      selectorVerified: true,
      tag: "BUTTON",
      id: null,
      classes: ["Focusable"],
      ariaLabel: null,
      text: label,
      ownerText: label,
      rect: { x: 10, y, w: 120, h: 40 },
    },
    gpfocusWithin: [],
    activeElement: null,
    agree: false,
    quickAccessTab: "999",
    deckyPluginRoot: true,
  });
  const reads = [
    control("First", 10),
    control("Second", 50),
    control("Retry", 90),
  ];
  const fake = await startFakeCdp(["QuickAccess_uid2"], (_t, idx) => reads[Math.min(idx, reads.length - 1)]);
  const fakePress = async (o: PressOptions): Promise<PressResult> => ({
    ok: true,
    fidelity: "steam-routed",
    method: "test-seam",
    buttons: o.buttons,
    holdMs: o.holdMs ?? 80,
  });
  try {
    const r = await walkTo({ direction: "DOWN", text: "Retry", cdpUrl: fake.base, pressFn: fakePress });
    assert.equal(r.found, true, r.summary);
    assert.equal(r.presses, 2);
    assert.equal(r.fidelity, "steam-routed", "every press moved focus, so the run earned it");
  } finally {
    await fake.close();
  }
});
