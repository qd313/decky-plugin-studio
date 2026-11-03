/**
 * The board says which program it runs (firmware 07_version), and the PC side
 * reads that instead of guessing from the resting axes. Everything here is the
 * desk half: parsing, the probe's three answers, the lease restraint, the
 * refusal text, the doctor check, and the firmware source carrying the field.
 * No serial port is opened; every runner is injected. What the real board does
 * after a flash is the Deck pass's to read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import {
  FIRMWARE_NOT_PROBED,
  FIRMWARE_NOT_READ,
  FIRMWARE_PRE_07,
  parseStatusFirmware,
} from "./bridgeTools.js";
import { oldFirmwareHint } from "./pressButton.js";
import { probeBridge, probeVirtualPad, readBridgeFirmware } from "../tools/deckAutonomy.js";
import { checkBridgeFirmware, ALL_CHECKS, type DoctorContext } from "../tools/doctor.js";
import type { Machine } from "../machines.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const STATUS_07 =
  '-> {"t":"status"}\n<- {"ok":true,"t":"status","fw":"07_version","buttons":0,"dirs":0,"ax":[0,0,-127,-127,0,0],"ms":4210,"detail":"live"}\n';
const STATUS_06 =
  '-> {"t":"status"}\n<- {"ok":true,"t":"status","buttons":0,"dirs":0,"ax":[0,0,-127,-127,0,0],"ms":4210,"detail":"live"}\n';

/** Clear (or set) DPS_NO_BRIDGE for one case, then put it back. Every case injects its runner. */
async function withBridgeGuard<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.DPS_NO_BRIDGE;
  if (value === undefined) delete process.env.DPS_NO_BRIDGE;
  else process.env.DPS_NO_BRIDGE = value;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.DPS_NO_BRIDGE;
    else process.env.DPS_NO_BRIDGE = prior;
  }
}

const boardMachine: Machine = { name: "deck", kind: "deck", os: "steamos", local: false, press: "bridge" };

// ---- parsing ---------------------------------------------------------------

test("the status reply's fw is read as the board wrote it", () => {
  assert.deepEqual(parseStatusFirmware(STATUS_07), { replied: true, firmware: "07_version" });
});

test("a status reply with no fw is a reply with no program name, which is not the same as no reply", () => {
  assert.deepEqual(parseStatusFirmware(STATUS_06), { replied: true, firmware: null });
  assert.deepEqual(parseStatusFirmware(""), { replied: false, firmware: null });
  assert.deepEqual(parseStatusFirmware("Traceback (most recent call last):\nSerialException"), {
    replied: false,
    firmware: null,
  });
});

test("only the reply counts: the echoed request, other replies and the boot banner are skipped", () => {
  const text =
    '{"boot":"deck-bridge 07_version","fw":"07_version","watchdog_ms":750}\n' +
    '-> {"t":"status"}\n' +
    '<- {"ok":true,"t":"press","fw":"nonsense"}\n' +
    "<- not json at all\r\n";
  assert.deepEqual(parseStatusFirmware(text), { replied: false, firmware: null });
});

test("an empty or non-string fw is no program name", () => {
  assert.equal(parseStatusFirmware('<- {"ok":true,"t":"status","fw":""}').firmware, null);
  assert.equal(parseStatusFirmware('<- {"ok":true,"t":"status","fw":7}').firmware, null);
});

// ---- the probe's answers -----------------------------------------------------

test("probeBridge carries the program the board named", () =>
  withBridgeGuard(undefined, async () => {
    const r = await probeBridge({ findPad: () => "C:/fake/pad.py", run: () => ({ ok: true, firmware: "07_version" }) });
    assert.equal(r.bridgeFirmware, "07_version");
    assert.equal(r.bridgePortOpen, true);
  }));

test("probeBridge says unknown (pre-07) when the board answered and named nothing, and never guesses from the axes", () =>
  withBridgeGuard(undefined, async () => {
    const r = await probeBridge({ findPad: () => "C:/fake/pad.py", run: () => ({ ok: true, firmware: null }) });
    assert.equal(r.bridgeFirmware, FIRMWARE_PRE_07);
    assert.equal(r.bridgeFirmware, "unknown (pre-07)");
  }));

test("probeBridge does not call a board pre-07 when no status reply was read at all", () =>
  withBridgeGuard(undefined, async () => {
    const r = await probeBridge({ findPad: () => "C:/fake/pad.py", run: () => ({ ok: true }) });
    assert.equal(r.bridgeFirmware, FIRMWARE_NOT_READ);
  }));

test("probeBridge reads the firmware as unknown whenever the board was not reached", () =>
  withBridgeGuard(undefined, async () => {
    const closed = await probeBridge({
      findPad: () => "C:/fake/pad.py",
      run: () => ({ ok: false, reason: "could not open port" }),
    });
    assert.equal(closed.bridgeFirmware, FIRMWARE_NOT_READ);
    const noPad = await probeBridge({ findPad: () => null, run: () => ({ ok: true, firmware: "07_version" }) });
    assert.equal(noPad.bridgeFirmware, FIRMWARE_NOT_READ);
  }));

test("with DPS_NO_BRIDGE set nothing is asked and the firmware is unknown", () =>
  withBridgeGuard("1", async () => {
    const r = await probeBridge({ findPad: () => "x", run: () => ({ ok: true, firmware: "07_version" }) });
    assert.equal(r.bridgeFirmware, FIRMWARE_NOT_READ);
  }));

// ---- restraint: the lease and the machine kind ---------------------------------

test("readBridgeFirmware stays off a serial port another session holds", async () => {
  let probed = 0;
  const r = await readBridgeFirmware({
    machine: boardMachine,
    heldByOther: () => ({ owner: "other-session", purpose: "a sweep" }),
    probe: async () => {
      probed += 1;
      throw new Error("must not probe a leased port");
    },
  });
  assert.equal(probed, 0);
  assert.equal(r.probed, false);
  assert.equal(r.firmware, FIRMWARE_NOT_PROBED);
  assert.match(r.reason ?? "", /leased by other-session/);
});

test("readBridgeFirmware does not ask a machine that presses through a virtual pad", async () => {
  const standin: Machine = { name: "this-pc", kind: "standin", os: "windows", local: true, press: "vigem" };
  const r = await readBridgeFirmware({
    machine: standin,
    heldByOther: () => null,
    probe: async () => {
      throw new Error("a stand-in has no board to ask");
    },
  });
  assert.equal(r.probed, false);
  assert.equal(r.firmware, FIRMWARE_NOT_PROBED);
  assert.match(r.reason ?? "", /virtual pad \(vigem\)/);
});

test("readBridgeFirmware asks a free board once and returns its program", async () => {
  let probed = 0;
  const r = await readBridgeFirmware({
    machine: boardMachine,
    heldByOther: () => null,
    probe: async () => {
      probed += 1;
      return { bridgePortOpen: true, bridgeReady: true, bridgeFirmware: "07_version", port: "COM7" };
    },
  });
  assert.equal(probed, 1);
  assert.deepEqual(r, { probed: true, firmware: "07_version", port: "COM7" });
});

// ---- a stand-in's virtual pad names itself, so the field is never absent -----------

test("probeVirtualPad carries the daemon's fw, and says so when an older daemon sends none", () =>
  withBridgeGuard(undefined, async () => {
    const m: Machine = { name: "this-pc", kind: "standin", os: "windows", local: true, press: "vigem" };
    const ep = async () => ({ host: "127.0.0.1", port: 7690, close: () => {} }) as never;
    const withFw = await probeVirtualPad(m, {
      endpoint: ep,
      status: async () =>
        ({ ack: { ok: true, t: "status", fw: "vpad", backend: "vigem", held: [] }, lines: [] }) as never,
    });
    assert.equal(withFw.firmware, "vpad");
    const without = await probeVirtualPad(m, {
      endpoint: ep,
      status: async () => ({ ack: { ok: true, t: "status", backend: "vigem", held: [] }, lines: [] }) as never,
    });
    assert.equal(without.firmware, "unknown (no fw field)");
  }));

// ---- the refusal ---------------------------------------------------------------

test("the LT/RT refusal says what the board said, and names the program only when it gave one", () => {
  const refused = '-> {"t":"press","b":["LT"],"ms":80}\n<- {"ok":false,"error":"unknown button name"}\n';
  const bare = oldFirmwareHint(refused, ["LT"]) ?? "";
  assert.match(bare, /reports no program name/);
  assert.match(bare, /before 05_triggers/);
  assert.match(bare, /flash\.ps1 deck_bridge/);
  const named = oldFirmwareHint(refused, ["LT"], "07_version") ?? "";
  assert.match(named, /says it runs 07_version/);
  assert.doesNotMatch(named, /reports no program name/);
  assert.equal(oldFirmwareHint(refused, ["A"], "07_version"), undefined, "an A refusal is not about the triggers");
});

// ---- the doctor check ----------------------------------------------------------

function ctxWith(bridgeFirmware?: DoctorContext["bridgeFirmware"]): DoctorContext {
  return {
    workspace: repoRoot,
    mcpServerRoot: path.resolve(here, "..", ".."),
    ingestPort: 0,
    findBridgeTool: (n) => `/fake/${n}`,
    probePython: () => "ok",
    ingestRunningHere: () => false,
    bridgeFirmware,
  };
}

test("doctor reports the firmware when the port was free", async () => {
  const c = await checkBridgeFirmware(ctxWith(async () => ({ probed: true, firmware: "07_version", port: "COM7" })));
  assert.equal(c.ok, true);
  assert.match(c.saw, /says it runs 07_version/);
});

test("doctor says a pre-07 board answered and named nothing, without calling it unreachable", async () => {
  const c = await checkBridgeFirmware(ctxWith(async () => ({ probed: true, firmware: FIRMWARE_PRE_07, port: "COM7" })));
  assert.equal(c.ok, true);
  assert.match(c.saw, /no program name/);
});

test("doctor is unknown, never a pass, when the port was not free or not asked", async () => {
  const leased = await checkBridgeFirmware(
    ctxWith(async () => ({
      probed: false,
      firmware: FIRMWARE_NOT_PROBED,
      port: "COM7",
      reason: "not probed: leased by someone",
    })),
  );
  assert.equal(leased.ok, "unknown");
  assert.match(leased.saw, /leased by someone/);
  const unplugged = await checkBridgeFirmware(
    ctxWith(async () => ({
      probed: true,
      firmware: FIRMWARE_NOT_READ,
      port: "COM7",
      reason: "could not open port 'COM7'",
    })),
  );
  assert.equal(unplugged.ok, "unknown");
  assert.match(unplugged.saw, /could not open port/);
  assert.equal((await checkBridgeFirmware(ctxWith())).ok, "unknown", "a context that cannot ask is unknown");
});

test("the firmware check is part of the doctor's list", () => {
  assert.ok(ALL_CHECKS.some(([n]) => n === "Bridge board's firmware"));
});

// ---- the source the board is built from ------------------------------------------

test("the firmware source names its program in the status reply and the boot banner, and keeps the trigger rest at -127", () => {
  const ino = fs.readFileSync(path.join(repoRoot, "bridge", "firmware", "deck_bridge", "deck_bridge.ino"), "utf8");
  assert.match(ino, /#define FW_PROGRAM "07_version"/);
  // The status reply asks for the field; the reply function prints it from the one define.
  assert.match(ino, /reply\("status",[^;]*,\s*true\)/);
  assert.ok(ino.includes('"\\"fw\\":\\"%s\\","'), "reply() prints fw from FW_PROGRAM");
  assert.ok(ino.includes("FW_PROGRAM);"), "reply() passes FW_PROGRAM to it");
  // The boot banner carries it too, built from the same define so the two cannot disagree.
  assert.ok(ino.includes('deck-bridge " FW_PROGRAM "\\",\\"fw\\":\\"" FW_PROGRAM "'), "the banner carries fw");
  assert.match(ino, /TRIGGER_REST = -127/);
  assert.ok(!ino.includes('deck-bridge 06_trigger_rest'), "the old program name is not left in the banner");
});

test("the virtual pad's status carries fw, so a stand-in never lacks the field", () => {
  const py = fs.readFileSync(path.join(repoRoot, "bridge", "tools", "vpad.py"), "utf8");
  assert.ok(py.includes('return {"fw": "vpad",'));
});
