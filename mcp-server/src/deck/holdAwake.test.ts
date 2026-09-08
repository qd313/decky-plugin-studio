/**
 * Tests for deck_holdAwake / deck_restorePowerSettings.
 *
 * THE EXEC LAYER IS FAKED. proc.execSync (deploy/deployHelpers.ts) is the
 * seam every ssh/scp call in this codebase goes through; tests replace it for
 * the duration of a case, exactly as deckDeploy.test.ts does. No network, no
 * hardware, ever.
 *
 * THE RUN-FILE DIRECTORY IS REDIRECTED TO A TEMP HOME, same trick
 * killswitch.test.ts uses: getConfigDir() derives from os.homedir(), read at
 * call time, so pointing USERPROFILE/HOME at a temp dir moves the run file
 * with it.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const realEnv = {
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
  DECK_IP: process.env.DECK_IP,
  DECK_USER: process.env.DECK_USER,
};
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dps-holdawake-"));
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
process.env.DECK_IP = "203.0.113.9";
process.env.DECK_USER = "deck";

const { proc } = await import("../deploy/deployHelpers.js");
const { snapshotPath, CorruptSnapshotError, StaleSnapshotError } = await import("./snapshotLease.js");
const {
  holdAwake,
  restorePowerSettings,
  parsePowerRead,
  readPowerCommand,
  writePowerCommand,
  POWER_READ_MARK,
  RESTORE_POWER_TOOL_HINT,
} = await import("./holdAwake.js");

function assertSandboxed(): void {
  assert.ok(
    snapshotPath("sandbox-check").startsWith(tempHome),
    `run file escaped the sandbox: ${snapshotPath("sandbox-check")} is not under ${tempHome}`
  );
}

before(() => assertSandboxed());
beforeEach(() => {
  assertSandboxed();
  fs.rmSync(snapshotPath("power-hold"), { force: true });
});
after(() => {
  process.env.USERPROFILE = realEnv.USERPROFILE;
  process.env.HOME = realEnv.HOME;
  process.env.DECK_IP = realEnv.DECK_IP;
  process.env.DECK_USER = realEnv.DECK_USER;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

/** Swaps proc.execSync for the duration of `fn`, always restoring it after. */
async function withFakeExec<T>(impl: (cmd: string) => string, fn: () => Promise<T> | T): Promise<T> {
  const original = proc.execSync;
  proc.execSync = ((cmd: string) => impl(cmd)) as unknown as typeof proc.execSync;
  try {
    return await fn();
  } finally {
    proc.execSync = original;
  }
}

function fakeReadAnswer(screenSec: number, suspendSec: number): string {
  return `${screenSec}\n${POWER_READ_MARK}\nIdleActionSec=${suspendSec}\n`;
}

// ---------------------------------------------------------------------------
// parsePowerRead / command shape (pure functions)
// ---------------------------------------------------------------------------

test("parsePowerRead reads both facts out of one round trip", () => {
  assert.deepEqual(parsePowerRead(fakeReadAnswer(600, 300)), {
    screenTimeoutSec: 600,
    suspendTimeoutSec: 300,
  });
});

test("parsePowerRead treats a missing IdleActionSec line as disabled (0)", () => {
  assert.deepEqual(parsePowerRead(`600\n${POWER_READ_MARK}\n`), {
    screenTimeoutSec: 600,
    suspendTimeoutSec: 0,
  });
});

test("parsePowerRead treats unreadable xset output as disabled (0), not a throw", () => {
  assert.deepEqual(parsePowerRead(`\n${POWER_READ_MARK}\nIdleActionSec=120`), {
    screenTimeoutSec: 0,
    suspendTimeoutSec: 120,
  });
  assert.deepEqual(parsePowerRead("garbage with no marker at all"), {
    screenTimeoutSec: 0,
    suspendTimeoutSec: 0,
  });
});

test("readPowerCommand and writePowerCommand target the configured Deck over ssh", () => {
  const readCmd = readPowerCommand("deck", "203.0.113.9");
  assert.match(readCmd, /^ssh .*deck@203\.0\.113\.9 "/);
  assert.match(readCmd, /xset q/);
  assert.match(readCmd, /IdleActionSec=/);
  assert.ok(readCmd.includes(POWER_READ_MARK));

  const writeCmd = writePowerCommand("deck", "203.0.113.9", { screenTimeoutSec: 0, suspendTimeoutSec: 0 });
  assert.match(writeCmd, /xset dpms 0 0 0/);
  assert.match(writeCmd, /IdleActionSec=0/);
  assert.match(writeCmd, /sudo/);
});

// ---------------------------------------------------------------------------
// holdAwake: write-before-change, and the shape of the result
// ---------------------------------------------------------------------------

test("holdAwake persists the previous values to the run file BEFORE the disable command is sent", async () => {
  const calls: string[] = [];
  let sawRunFileDuringDisable: unknown = "not reached";

  const result = await withFakeExec((cmd) => {
    calls.push(cmd);
    if (cmd.includes("xset dpms")) {
      // The disable command itself -- the run file must already exist here.
      sawRunFileDuringDisable = fs.existsSync(snapshotPath("power-hold"))
        ? JSON.parse(fs.readFileSync(snapshotPath("power-hold"), "utf8"))
        : null;
      return "";
    }
    return fakeReadAnswer(600, 300); // the read command
  }, () => holdAwake());

  assert.notEqual(sawRunFileDuringDisable, "not reached", "the disable command was never sent");
  assert.ok(sawRunFileDuringDisable, "the run file did not exist yet when the disable command ran");
  assert.deepEqual((sawRunFileDuringDisable as { values: unknown }).values, {
    screenTimeoutSec: 600,
    suspendTimeoutSec: 300,
  });

  assert.deepEqual(result.previous, { screenTimeoutSec: 600, suspendTimeoutSec: 300 });
  assert.deepEqual(result.changed, { screenTimeoutSec: 0, suspendTimeoutSec: 0 });
  assert.match(result.summary, /600s/);
  assert.match(result.summary, /300s/);

  const readIdx = calls.findIndex((c) => c.includes("xset q"));
  const writeIdx = calls.findIndex((c) => c.includes("xset dpms"));
  assert.ok(readIdx >= 0 && writeIdx > readIdx, "the read must happen strictly before the write");
});

test("a second holdAwake over an unrestored hold is refused, naming the stale hold and deck_restorePowerSettings", async () => {
  await withFakeExec(() => fakeReadAnswer(600, 300), () => holdAwake());

  await assert.rejects(
    () => withFakeExec(() => fakeReadAnswer(600, 300), () => holdAwake()),
    (err: unknown) => {
      assert.ok(err instanceof StaleSnapshotError);
      assert.match((err as Error).message, new RegExp(RESTORE_POWER_TOOL_HINT));
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// restorePowerSettings: safe no-op, idempotent, restores exact values
// ---------------------------------------------------------------------------

test("restorePowerSettings with nothing held is a clean no-op and sends nothing to the Deck", async () => {
  const calls: string[] = [];
  const result = await withFakeExec(
    (cmd) => {
      calls.push(cmd);
      return "";
    },
    () => restorePowerSettings()
  );

  assert.equal(result.ok, true);
  assert.equal(result.restored, false);
  assert.equal(calls.length, 0, `expected no ssh calls, got: ${JSON.stringify(calls)}`);
});

test("restorePowerSettings puts back exactly the captured values, and is idempotent", async () => {
  await withFakeExec(() => fakeReadAnswer(450, 900), () => holdAwake());

  const writeCalls: string[] = [];
  const first = await withFakeExec((cmd) => {
    if (cmd.includes("xset dpms")) writeCalls.push(cmd);
    return "";
  }, () => restorePowerSettings());

  assert.equal(first.restored, true);
  assert.deepEqual(first.values, { screenTimeoutSec: 450, suspendTimeoutSec: 900 });
  assert.equal(writeCalls.length, 1);
  assert.match(writeCalls[0], /xset dpms 450 450 450/);
  assert.match(writeCalls[0], /IdleActionSec=900/);
  assert.equal(fs.existsSync(snapshotPath("power-hold")), false);

  const secondCalls: string[] = [];
  const second = await withFakeExec((cmd) => {
    secondCalls.push(cmd);
    return "";
  }, () => restorePowerSettings());

  assert.equal(second.restored, false);
  assert.equal(secondCalls.length, 0, "a second restore must not touch the Deck at all");
});

// ---------------------------------------------------------------------------
// A corrupt run file is detected at the feature layer too
// ---------------------------------------------------------------------------

test("a corrupt power-hold run file is detected, not silently treated as absent", async () => {
  fs.mkdirSync(path.dirname(snapshotPath("power-hold")), { recursive: true });
  fs.writeFileSync(snapshotPath("power-hold"), "{ not json", "utf8");

  await assert.rejects(() => withFakeExec(() => fakeReadAnswer(1, 1), () => holdAwake()), CorruptSnapshotError);
  await assert.rejects(() => withFakeExec(() => "", () => restorePowerSettings()), CorruptSnapshotError);
});

// ---------------------------------------------------------------------------
// Expiry restores the original power values automatically
// ---------------------------------------------------------------------------

test("an expired hold is auto-restored, pushing the ORIGINAL screen/suspend values, the next time holdAwake runs", async () => {
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const writeCalls: string[] = [];

  await withFakeExec((cmd) => {
    if (cmd.includes("xset dpms")) writeCalls.push(cmd);
    return fakeReadAnswer(300, 600);
  }, () => holdAwake({ ttlMinutes: 1, now }));

  clock += 5 * 60_000; // well past the 1-minute lease

  const result = await withFakeExec((cmd) => {
    if (cmd.includes("xset dpms")) writeCalls.push(cmd);
    return fakeReadAnswer(300, 600); // the Deck's live values, if asked again
  }, () => holdAwake({ ttlMinutes: 1, now }));

  assert.ok(result.autoRestoredExpired, "the expired hold was not auto-restored");
  assert.deepEqual(result.autoRestoredExpired!.values, { screenTimeoutSec: 300, suspendTimeoutSec: 600 });
  assert.match(result.summary, /had expired and was/);

  // Three writes total: the first hold's disable, the auto-restore of the
  // original 300/600, and the second hold's fresh disable.
  assert.equal(writeCalls.length, 3, JSON.stringify(writeCalls));
  assert.match(writeCalls[0], /xset dpms 0 0 0/);
  assert.match(writeCalls[1], /xset dpms 300 300 300/);
  assert.match(writeCalls[2], /xset dpms 0 0 0/);
});
