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

import { evaluate, listTargets, getVersion, rewriteWsHost } from "./cdp.js";
import { readFocusAt } from "./readFocus.js";
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

test("openPlugin treats a visible pane as an open QAM even when the ring is on the rail", async () => {
  // The 2026-08-26 mistake: quickAccessTab is null on the rail, which read as
  // "QAM closed" and fired the open chord at an already-open menu. Here the ring
  // is on the rail (tab null) with the Decky pane showing, so the tool must skip
  // straight past opening and go looking for the plugin row.
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
