/**
 * Tests for the parts of deck.pressButton that do not need a board.
 *
 * The press itself is hardware and stays untested here (DPS_NO_BRIDGE makes
 * sure of it). What can be pinned is the one failure a press may retry -- the
 * serial port held by another opener -- and that nothing else qualifies. A
 * retry classifier that is too broad would quietly re-press on a real failure,
 * which is exactly the "no retries" rule this rig keeps.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";

import { pressButton, portBusy, failureDetail } from "./pressButton.js";
import { startFakeCdp, focusedPage } from "./__testutil__/fakeCdp.js";

/**
 * Temporarily clears DPS_NO_BRIDGE for one case -- same pattern as
 * deckAutonomy.test.ts's withBridgeGuard, and safe for the same reason: every
 * case that uses this also injects `sendRaw` (the serial layer) and a fake
 * `cdpUrl` (the CDP layer), so there is no real spawn or SSH left to reach
 * even with the guard off.
 */
function withBridgeGuard<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.DPS_NO_BRIDGE;
  if (value === undefined) delete process.env.DPS_NO_BRIDGE;
  else process.env.DPS_NO_BRIDGE = value;
  return fn().finally(() => {
    if (prior === undefined) delete process.env.DPS_NO_BRIDGE;
    else process.env.DPS_NO_BRIDGE = prior;
  });
}

/** A fake wire-send that always succeeds, standing in for a real bridge ack. */
function fakeAck(): NonNullable<Parameters<typeof pressButton>[0]["sendRaw"]> {
  return async (o) => ({
    ok: true,
    fidelity: "wire-sent",
    method: "usb-hid:bridge",
    buttons: o.buttons.map((b) => b.trim().toUpperCase()),
    holdMs: o.holdMs ?? 80,
    ack: '{"ok":true,"t":"press"}',
  });
}

/** focusedPage's gpfocus, but on a different control -- a real focus move. */
const movedFocusPage = {
  ...focusedPage,
  gpfocus: {
    ...focusedPage.gpfocus,
    selector: "#quickaccess_content_999 > button.OtherButton",
    text: "a different control entirely",
  },
};

const COLLISION =
  "Traceback (most recent call last):\n" +
  '  File "C:\\Users\\still\\decky-plugin-studio\\bridge\\tools\\pad.py", line 201, in <module>\n' +
  "    main()\n" +
  '  File "C:\\Users\\still\\AppData\\Roaming\\Python\\Python312\\site-packages\\serial\\serialwin32.py", line 64, in open\n' +
  "    raise SerialException(\"could not open port {!r}: {!r}\".format(self.portstr, ctypes.WinError()))\n" +
  "serial.serialutil.SerialException: could not open port 'COM7': PermissionError(13, 'Access is denied.', None, 5)\n";

test("the measured COM7 collision is the one failure a press may retry", () => {
  // Captured 2026-08-31 by opening the port twice at once -- the shape the
  // extension's 30 s status poll produces against a sweep in progress.
  assert.equal(portBusy(failureDetail(COLLISION, "")), true);
});

test("no other failure qualifies for a retry", () => {
  for (const detail of [
    "serial.serialutil.SerialException: could not open port 'COM7': FileNotFoundError(2, 'The system cannot find the file specified.', None, 2)",
    'ModuleNotFoundError: No module named "serial"',
    "pad.py did not answer within 15000ms",
    "firmware refused: {\"ok\":false}",
    "",
  ]) {
    assert.equal(portBusy(detail), false, `must not retry on: ${detail || "<empty>"}`);
  }
});

test("failureDetail keeps the exception line, not the head of the traceback", () => {
  // The first field report of the collision ended in `File "C:\Users\sti` --
  // 300 characters of traceback with the actual error cut off.
  const d = failureDetail(COLLISION, "");
  assert.match(d, /^serial\.serialutil\.SerialException: could not open port 'COM7'/);
  assert.doesNotMatch(d, /Traceback/);
  assert.equal(failureDetail("", "  <- something  "), "<- something");
  assert.equal(failureDetail("", ""), "no output");
});

test("the hardware guard refuses before any retry logic can run", async () => {
  const r = await pressButton({ buttons: ["DOWN"] });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /DPS_NO_BRIDGE/);
  assert.equal(r.retried, undefined);
});

// --------------------------------------------------------------------------
// fidelity honesty. Found 2026-08-27: with the bridge board plugged into this
// PC but its OTHER USB lead unplugged from the Deck, the firmware still acks
// every press -- it has no way to know its HID side reached anything -- and
// pressButton used to report `fidelity: "steam-routed"` off that ack alone.
// The serial layer is faked via `sendRaw` (child_process's exports are
// non-configurable, so `spawn` cannot be mocked directly -- same reason
// deployHelpers.ts has its own `proc` seam); the CDP layer is faked via
// startFakeCdp, exactly as cdp.test.ts does for readFocus/assertFocusMove.
// --------------------------------------------------------------------------

test("a plain press (no verify) reports wire-sent on success, and never steam-routed", async () => {
  const r = await pressButton({ buttons: ["A"], sendRaw: fakeAck() });
  assert.equal(r.ok, true);
  assert.equal(r.fidelity, "wire-sent");
  assert.notEqual(r.fidelity, "steam-routed");
});

test("verify refuses under DPS_NO_BRIDGE before opening any CDP tunnel or sending anything", async () => {
  // No cdpUrl and no sendRaw given: if this reached either layer for real it
  // would try a real SSH tunnel or a real spawn. It must not get that far.
  const r = await pressButton({ buttons: ["DOWN"], verify: true });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /DPS_NO_BRIDGE/);
});

test("verify earns steam-routed only when a real before/after focus read shows a change", () =>
  withBridgeGuard(undefined, async () => {
    const fake = await startFakeCdp(["QuickAccess_uid2"], (_t, i) =>
      i === 0 ? focusedPage : movedFocusPage,
    );
    try {
      const r = await pressButton({
        buttons: ["DOWN"],
        verify: true,
        cdpUrl: fake.base,
        verifySettleMs: 200,
        sendRaw: fakeAck(),
      });
      assert.equal(r.ok, true);
      assert.equal(r.fidelity, "steam-routed");
      assert.equal(r.verified, true);
    } finally {
      await fake.close();
    }
  }));

test("verify does NOT report steam-routed for a dead board -- board acks, Deck-side focus never changes", () =>
  withBridgeGuard(undefined, async () => {
    // Every read returns the SAME page: this is what "board plugged into the
    // PC, unplugged from the Deck" looks like from here -- the wire-send
    // below still succeeds (the firmware still acks), but nothing on the
    // Deck ever moves. A verify implementation that just checked
    // `pressed.ok` and stamped steam-routed on top of it -- the exact shape
    // of the original bug, one level up -- would pass this scenario
    // incorrectly; this pins that it must not.
    const fake = await startFakeCdp(["QuickAccess_uid2"], () => focusedPage);
    try {
      const r = await pressButton({
        buttons: ["DOWN"],
        verify: true,
        cdpUrl: fake.base,
        verifySettleMs: 150,
        sendRaw: fakeAck(),
      });
      assert.equal(r.ok, false, "a press that never reached the Deck must not be reported as ok");
      assert.notEqual(r.fidelity, "steam-routed");
      assert.equal(r.fidelity, "wire-sent");
      assert.equal(r.verified, true);
      assert.match(r.reason ?? "", /focus did not change/);
    } finally {
      await fake.close();
    }
  }));

test("verify reports an honest failure, not steam-routed, when the underlying press itself fails", () =>
  withBridgeGuard(undefined, async () => {
    const fake = await startFakeCdp(["QuickAccess_uid2"], () => focusedPage);
    try {
      const r = await pressButton({
        buttons: ["DOWN"],
        verify: true,
        cdpUrl: fake.base,
        sendRaw: async (o) => ({
          ok: false,
          fidelity: null,
          method: "usb-hid:bridge",
          buttons: o.buttons,
          holdMs: o.holdMs ?? 80,
          reason: "fake: bridge refused",
        }),
      });
      assert.equal(r.ok, false);
      assert.equal(r.fidelity, null);
      assert.match(r.reason ?? "", /fake: bridge refused/);
    } finally {
      await fake.close();
    }
  }));
