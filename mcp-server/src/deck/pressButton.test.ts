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
