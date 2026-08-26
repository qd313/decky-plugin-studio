/**
 * Tests for deck.walkTo.
 *
 * The refusals and the matching rules are what can be pinned without a bridge
 * board, and they are the parts that caused real trouble on hardware: a
 * substring match landing one control short of the target, a toggle whose label
 * lives on an ancestor, and a dead end that quietly ate a whole budget.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { startFakeCdp, focusedPage, unfocusedPage } from "./__testutil__/fakeCdp.js";
import { walkTo, labelOf } from "./walkTo.js";

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

test("an unowned ring explains itself instead of pressing blind", async () => {
  // The state right after a plugin opens. Telling the caller one press places
  // the ring is the difference between a usable message and a dead end.
  const fake = await startFakeCdp(["SharedJSContext"], () => unfocusedPage);
  try {
    const r = await walkTo({ direction: "DOWN", text: "Retry", cdpUrl: fake.base });
    assert.equal(r.ok, false);
    assert.equal(r.presses, 0);
    assert.match(r.summary, /one press places it/);
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

test("a dead end stops the walk instead of spending the whole budget", async () => {
  // Bottom of a list: the ring stops moving. Found on hardware, where sixteen
  // further presses cost sixteen round trips and learned nothing.
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => pageWith("Save chat to Desktop"));
  try {
    const r = await walkTo({
      direction: "DOWN",
      text: "Retry",
      budget: 40,
      stallLimit: 2,
      cdpUrl: fake.base,
    });
    assert.equal(r.found, false);
    assert.equal(r.stalled, true);
    assert.ok(r.presses <= 3, `should give up quickly, took ${r.presses}`);
    assert.match(r.summary, /end of the line going DOWN/);
    assert.deepEqual(r.seen, ["Save chat to Desktop"]);
  } finally {
    await fake.close();
  }
});
