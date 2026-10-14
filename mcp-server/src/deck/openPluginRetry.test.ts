/**
 * Tests for deck_openPlugin's one automatic second try (plan 93, lane R).
 *
 * On the Deck night of 2026-10-12 the first deck_openPlugin after a plugin
 * reload failed in 3 of 3 rounds and the next call always worked: once on the
 * connection to Steam's debugger (ECONNRESET, nothing pressed), twice because
 * the open chord went out and no Quick Access pane appeared. The two earlier
 * fixes (59d1698 waits for the Quick Access page, 28e7325 reads for 3 s after
 * the chord) did not cure it. These tests state what a person looking at one
 * call of the tool needs: ONE call ends with the panel open, and the result
 * says it needed a second try.
 *
 * The fake Steam here is driven by state (how many chords were sent, whether
 * the debugger is accepting connections), not by read counts, so a second try
 * that reads in a different order still gets honest answers.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { startFakeCdp, focusedPage, unfocusedPage } from "./__testutil__/fakeCdp.js";
import { openPluginDriven } from "./openPlugin.js";
import { probeQuickAccess } from "./readFocus.js";
import { openPluginWithRetry, isRetryableOpenFailure } from "./openPluginRetry.js";
import type { OpenPluginResult } from "./openPlugin.js";
import type { PressOptions, PressResult } from "./pressButton.js";

const TARGETS = ["SharedJSContext", "QuickAccess_uid2"];
/** The Quick Access page with the menu shut: no ring, no pane (answers the focus scan and the probe alike). */
const SHUT = { ...unfocusedPage, visiblePane: null, ownsFocus: false };
/** The same page with the menu open on bonsAI's row. */
const OPEN = { ...focusedPage, visiblePane: "999", ownsFocus: true };

function recorder(onChord?: (n: number) => void) {
  const log: string[] = [];
  let chords = 0;
  const ok = (buttons: string[], method: string): PressResult => ({
    ok: true,
    fidelity: "steam-routed",
    method,
    buttons,
    holdMs: 80,
  });
  return {
    log,
    chords: () => chords,
    pressFn: async ({ buttons }: PressOptions): Promise<PressResult> => {
      log.push(`press:${buttons.join("+")}`);
      return ok(buttons, "fake");
    },
    chordFn: async (hold: string, tap: string): Promise<PressResult> => {
      chords++;
      log.push(`chord:${hold}>${tap}`);
      onChord?.(chords);
      return ok([hold, tap], "fake:chord");
    },
  };
}

/** A TCP front for the fake debugger that resets every connection while `down()` is true. */
async function startFlakyFront(targetBase: string, down: () => boolean) {
  const target = new URL(targetBase);
  const sockets = new Set<net.Socket>();
  let resets = 0;
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => {});
    if (down()) {
      resets++;
      client.destroy();
      return;
    }
    const up = net.connect(Number(target.port), target.hostname);
    sockets.add(up);
    up.on("close", () => sockets.delete(up));
    up.on("error", () => client.destroy());
    client.pipe(up);
    up.pipe(client);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    resets: () => resets,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

test("the first chord does nothing (no pane appears): ONE call still ends with the panel open, and says it tried twice", async () => {
  // Menu opens only on the SECOND chord -- the 2026-10-12 rounds 2 and 3, where
  // the chord went out, no pane appeared, and the next call worked.
  let chords = 0;
  const fake = await startFakeCdp(TARGETS, (title) => (title === "QuickAccess_uid2" ? (chords >= 2 ? OPEN : SHUT) : unfocusedPage));
  const rig = recorder((n) => (chords = n));
  try {
    const r = await openPluginWithRetry({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 300,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
      retryDelayMs: 50,
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(rig.chords(), 2, "the second try sent the chord again, after reading that the menu was still shut");
    assert.equal(r.retried?.attempts, 2);
    assert.match(r.retried?.firstReason ?? "", /no quickaccess pane appeared/);
    assert.match(r.summary, /second try/i);
  } finally {
    await fake.close();
  }
});

test("a menu that did open late is NOT toggled shut by the second try", async () => {
  // The first attempt gives up, but the menu is up when the second one looks:
  // the chord is a toggle, so the second try must read first and press nothing.
  let firstGaveUp = false;
  const fake = await startFakeCdp(TARGETS, (title) => {
    if (title !== "QuickAccess_uid2") return unfocusedPage;
    // Shut for the whole first attempt; up once it has finished.
    return firstGaveUp ? OPEN : SHUT;
  });
  const rig = recorder();
  try {
    const r = await openPluginWithRetry({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 300,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
      retryDelayMs: 50,
      onFirstAttemptFailed: () => (firstGaveUp = true),
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(rig.chords(), 1, "exactly one chord across both tries");
    assert.equal(r.retried?.attempts, 2);
  } finally {
    await fake.close();
  }
});

test("the debugger refuses the connection for longer than the wait: the tool tries once more and succeeds in the same call", async () => {
  // 2026-10-12 round 1, try 1: "Could not reach Steam's CEF debugger (read
  // ECONNRESET)" 3 s after the reload, nothing pressed.
  const downUntil = Date.now() + 700;
  const fake = await startFakeCdp(TARGETS, (title) => (title === "QuickAccess_uid2" ? OPEN : unfocusedPage));
  const front = await startFlakyFront(fake.base, () => Date.now() < downUntil);
  const rig = recorder();
  try {
    const r = await openPluginWithRetry({
      pluginName: "bonsAI",
      cdpUrl: front.base,
      targetsSettleMs: 100,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
      retryDelayMs: 900,
    });
    assert.ok(front.resets() > 0, "the debugger really did reset a connection");
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.retried?.attempts, 2);
    assert.match(r.retried?.firstReason ?? "", /ECONNRESET|socket hang up|Could not reach/i);
    assert.equal(rig.chords(), 0, "the menu was open, so no chord");
  } finally {
    await front.close();
    await fake.close();
  }
});

test("a reset that clears inside the wait is absorbed by the first try: no second try, nothing to report", async () => {
  const downUntil = Date.now() + 600;
  const fake = await startFakeCdp(TARGETS, (title) => (title === "QuickAccess_uid2" ? OPEN : unfocusedPage));
  const front = await startFlakyFront(fake.base, () => Date.now() < downUntil);
  const rig = recorder();
  try {
    const r = await openPluginWithRetry({
      pluginName: "bonsAI",
      cdpUrl: front.base,
      targetsSettleMs: 5000,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
      retryDelayMs: 50,
    });
    assert.ok(front.resets() > 0);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.retried, undefined, "the first try carried through the reset by itself");
  } finally {
    await front.close();
    await fake.close();
  }
});

test("a call that works the first time is returned untouched, with no retry note", async () => {
  const fake = await startFakeCdp(TARGETS, (title) => (title === "QuickAccess_uid2" ? OPEN : unfocusedPage));
  const rig = recorder();
  try {
    const r = await openPluginWithRetry({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 300,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
      retryDelayMs: 50,
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.retried, undefined);
  } finally {
    await fake.close();
  }
});

test("two failed tries are one honest failure that names the number of tries, and never a third", async () => {
  const fake = await startFakeCdp(TARGETS, (title) => (title === "QuickAccess_uid2" ? SHUT : unfocusedPage));
  const rig = recorder();
  try {
    const r = await openPluginWithRetry({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 300,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
      retryDelayMs: 50,
    });
    assert.equal(r.ok, false);
    assert.equal(r.retried?.attempts, 2);
    assert.equal(rig.chords(), 2, "one chord per try, no third try");
    assert.ok(r.checklist?.length, "the manual steps are still handed back");
  } finally {
    await fake.close();
  }
});

test("which failures earn a second try: nothing pressed, or only the open chord; never a stopped rig or a half-done walk", () => {
  const base: OpenPluginResult = {
    ok: false, pluginName: "bonsAI", verified: false, fidelity: "wire-sent", stages: [], seen: [],
    focus: null, stopped: false, summary: "",
  };
  assert.equal(isRetryableOpenFailure({ ...base }), true, "nothing pressed");
  assert.equal(
    isRetryableOpenFailure({ ...base, stages: [{ stage: "open-qam", ok: false, detail: "", presses: 1 }] }),
    true,
    "the chord was the only press",
  );
  assert.equal(
    isRetryableOpenFailure({ ...base, stages: [{ stage: "open-qam-blind", ok: false, detail: "", presses: 1 }] }),
    true,
  );
  assert.equal(isRetryableOpenFailure({ ...base, stopped: true }), false, "a stopped rig stays stopped");
  assert.equal(
    isRetryableOpenFailure({
      ...base,
      stages: [
        { stage: "open-qam", ok: true, detail: "", presses: 1 },
        { stage: "reach-rail", ok: false, detail: "", presses: 1 },
      ],
    }),
    false,
    "a walk that got somewhere is not repeated blindly",
  );
  assert.equal(isRetryableOpenFailure({ ...base, ok: true }), false);
});

test("the plain tool entry (openPluginDriven) is unchanged: one try, no retry field", async () => {
  const fake = await startFakeCdp(TARGETS, (title) => (title === "QuickAccess_uid2" ? SHUT : unfocusedPage));
  const rig = recorder();
  try {
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 300,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
    });
    assert.equal(r.ok, false);
    assert.equal((r as { retried?: unknown }).retried, undefined);
  } finally {
    await fake.close();
  }
});

test("a chord that opens nothing records what the Quick Access page says about itself, so the next failure can be told apart", async () => {
  // Two readings of the 2026-10-12 failures fit the evidence: the overlay was never shown, or it was
  // shown with its panes not drawn yet. The page's own visibilityState and pane count separate them.
  const hidden = { ...SHUT, visibilityState: "hidden", paneCount: 0 };
  const fake = await startFakeCdp(TARGETS, (title) => (title === "QuickAccess_uid2" ? hidden : unfocusedPage));
  const rig = recorder();
  try {
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      targetsSettleMs: 300,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
    });
    assert.equal(r.ok, false);
    const stage = r.stages.find((s) => s.stage === "open-qam-blind" || s.stage === "open-qam");
    assert.match(stage?.detail ?? "", /visibilityState=hidden/);
    assert.match(stage?.detail ?? "", /0 pane\(s\) mounted/);
  } finally {
    await fake.close();
  }
});

test("probeQuickAccess keeps polling through a reset inside its wait, and reports it only when the wait is spent", async () => {
  const downUntil = Date.now() + 500;
  const fake = await startFakeCdp(TARGETS, () => ({ visiblePane: null, ownsFocus: false }));
  const front = await startFlakyFront(fake.base, () => Date.now() < downUntil);
  try {
    const patient = await probeQuickAccess(front.base, { targetsSettleMs: 5000, targetsPollMs: 100 });
    assert.equal(patient.answered, true, patient.reason);
    assert.ok(front.resets() > 0);
  } finally {
    await front.close();
  }
  const dead = await startFlakyFront(fake.base, () => true);
  try {
    const impatient = await probeQuickAccess(dead.base, { targetsSettleMs: 300, targetsPollMs: 100 });
    assert.equal(impatient.answered, false);
    assert.match(impatient.reason ?? "", /Could not reach Steam's CEF debugger/);
    assert.ok(impatient.waitedMs >= 250, "it waited out the window before giving up");
  } finally {
    await dead.close();
    await fake.close();
  }
});
