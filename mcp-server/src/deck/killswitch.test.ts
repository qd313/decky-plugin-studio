/**
 * Tests for the killswitch.
 *
 * This is a safety feature, which changes what the tests are for. Everywhere
 * else in this suite a failing test means a tool reports the wrong thing; here
 * a failing test means the stop did not stop, and the way you find out is that
 * a real board presses a real button on a real Deck. So the tests are written
 * to be safe even when the thing they are testing is broken:
 *
 *   THE LATCH IS REDIRECTED TO A TEMP DIRECTORY. getConfigDir() derives from
 *   os.homedir(), which Node reads from USERPROFILE/HOME at call time, so
 *   pointing those at a temp dir moves the latch with them. Every test asserts
 *   the redirect took before it writes anything -- a test that latched the
 *   developer's real killswitch would silently disable their rig, and they
 *   would find out the next time a press mysteriously refused.
 *
 *   THE ONE TEST THAT CALLS pressButton PASSES A SERIAL PORT THAT DOES NOT
 *   EXIST. That test has to run with DPS_NO_BRIDGE cleared, because the point
 *   of it is that the LATCH refuses -- with the env guard in place it would
 *   pass whether or not the latch works at all. The bogus port is the backstop:
 *   if the latch check regresses, pad.py fails to open the port and presses
 *   nothing, the assertion still fails, and nobody's Deck moves.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * Hardware guard, as everywhere else in this suite. Set before the imports
 * below so releaseAllButtons never spawns pad.py.
 */
process.env.DPS_NO_BRIDGE ??= "1";

const realHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dps-killswitch-"));
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;

const {
  automationStopped,
  stopAutomation,
  armAutomation,
  automationStatus,
  registerTunnel,
  unregisterTunnel,
  killAllTunnels,
  releaseAllButtons,
  getLatchPath,
  stoppedMessage,
} = await import("./killswitch.js");
const { bridgeDisabled, pressButton } = await import("./pressButton.js");
const { runSequence } = await import("./runSequence.js");
const { startFakeCdp, focusedPage } = await import("./__testutil__/fakeCdp.js");

/**
 * The guard every test leans on. If the redirect ever stops working -- a Node
 * change to homedir(), a refactor that caches the config dir at import time --
 * this fails loudly instead of writing a latch into the developer's real
 * config directory.
 */
function assertSandboxed(): void {
  assert.ok(
    getLatchPath().startsWith(tempHome),
    `latch path escaped the sandbox: ${getLatchPath()} is not under ${tempHome}`,
  );
}

before(() => assertSandboxed());

beforeEach(() => {
  assertSandboxed();
  fs.rmSync(getLatchPath(), { force: true });
});

after(() => {
  process.env.USERPROFILE = realHome.USERPROFILE;
  process.env.HOME = realHome.HOME;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The latch
// ---------------------------------------------------------------------------

test("no latch file means armed", () => {
  assert.equal(automationStopped(), null);
  assert.equal(automationStatus().armed, true);
});

test("stopping latches off, and the latch survives being read from scratch", async () => {
  const report = await stopAutomation({ by: "command", reason: "ring was on Play", skipTunnels: true });
  assert.equal(report.ok, true);
  assert.equal(report.alreadyStopped, false);

  // Read back through the public accessor rather than the returned object: the
  // whole design rests on a second process seeing this, and the only thing a
  // second process has is the file.
  const rec = automationStopped();
  assert.ok(rec, "the latch was not visible after stopAutomation");
  assert.equal(rec.by, "command");
  assert.equal(rec.reason, "ring was on Play");
  assert.equal(automationStatus().armed, false);
});

test("a second stop keeps the original timestamp rather than restarting the clock", async () => {
  const first = await stopAutomation({ by: "tool", reason: "first", skipTunnels: true });
  const second = await stopAutomation({ by: "status-bar", reason: "hit it again", skipTunnels: true });

  assert.equal(second.alreadyStopped, true);
  // When automation actually stopped is the fact worth keeping. Hitting the
  // button again because you were not sure must not rewrite history.
  assert.equal(second.record.at, first.record.at);
  assert.equal(second.record.by, "tool");
  assert.match(second.summary, /already stopped/);
});

test("a corrupt latch file counts as stopped, not as armed", () => {
  fs.mkdirSync(path.dirname(getLatchPath()), { recursive: true });
  fs.writeFileSync(getLatchPath(), "{ this is not json", "utf8");

  // Ambiguity resolves towards not pressing buttons. The only reason that file
  // exists is that somebody asked for a stop.
  const rec = automationStopped();
  assert.ok(rec, "an unparseable latch was treated as no latch");
  assert.equal(automationStatus().armed, false);
});

test("arming clears the latch and reports what it cleared", async () => {
  await stopAutomation({ by: "keybinding", reason: "taking over", skipTunnels: true });
  const armed = armAutomation();

  assert.equal(armed.ok, true);
  assert.equal(armed.wasStopped, true);
  assert.equal(armed.previous?.reason, "taking over");
  assert.equal(automationStopped(), null);
  assert.equal(fs.existsSync(getLatchPath()), false);
});

test("arming an already-armed rig is not an error", () => {
  const armed = armAutomation();
  assert.equal(armed.ok, true);
  assert.equal(armed.wasStopped, false);
  assert.match(armed.summary, /already armed/);
});

// ---------------------------------------------------------------------------
// What the latch actually forbids
// ---------------------------------------------------------------------------

/**
 * Run one assertion with the env guard lifted, so the LATCH is what refuses.
 *
 * Only the assertion. Setting the latch has to happen with the guard still on,
 * because stopAutomation releases the board, and with the guard lifted that
 * spawns pad.py against a real COM port -- which the first version of these
 * tests did, adding 3.2 seconds and a live serial round trip to a test that was
 * meant to be pure. A release is the safe direction, so nothing moved, but a
 * test suite reaching for the hardware at all is the thing DPS_NO_BRIDGE exists
 * to stop.
 */
function withoutEnvGuard<T>(fn: () => T): T {
  const saved = process.env.DPS_NO_BRIDGE;
  delete process.env.DPS_NO_BRIDGE;
  try {
    return fn();
  } finally {
    if (saved !== undefined) process.env.DPS_NO_BRIDGE = saved;
  }
}

test("bridgeDisabled reports the killswitch, and says a human must clear it", async () => {
  withoutEnvGuard(() => {
    assert.equal(bridgeDisabled(), null, "should be permitted with no latch and no env guard");
  });

  await stopAutomation({ by: "status-bar", skipTunnels: true });

  withoutEnvGuard(() => {
    const refusal = bridgeDisabled();
    assert.ok(refusal, "a set latch did not forbid the press");
    assert.match(refusal, /STOPPED/);
    // The refusal has to tell the reader who can undo it. An agent that reads
    // "stopped" and nothing else will go looking for a tool to un-stop it.
    assert.match(refusal, /re-arm/i);
  });
});

test("the env guard is reported as the env guard, not blamed on the killswitch", () => {
  process.env.DPS_NO_BRIDGE = "1";
  const refusal = bridgeDisabled();
  assert.ok(refusal);
  assert.match(refusal, /DPS_NO_BRIDGE/);
  assert.doesNotMatch(refusal, /killswitch/i);
});

test("pressButton refuses on the latch before it spawns anything", async () => {
  // Latch first, with the env guard still on, so the release inside this call
  // stays a no-op instead of opening a serial port.
  await stopAutomation({ by: "command", skipTunnels: true });

  // The bogus port is the backstop, not the subject. If the latch check ever
  // regresses this reaches pad.py, which cannot open COM_DOES_NOT_EXIST and so
  // presses nothing -- the assertion below still fails, and no ring moves.
  const r = await withoutEnvGuard(() =>
    pressButton({ buttons: ["DOWN"], port: "COM_DOES_NOT_EXIST" }),
  );

  assert.equal(r.ok, false);
  assert.equal(r.fidelity, null);
  assert.match(r.reason ?? "", /STOPPED/);
  assert.doesNotMatch(
    r.reason ?? "",
    /pad\.py|serial|COM_DOES_NOT_EXIST/i,
    "the press reached the bridge before checking the latch",
  );
});

test("release is skipped, and says so, when DPS_NO_BRIDGE is set", async () => {
  process.env.DPS_NO_BRIDGE = "1";
  const r = await releaseAllButtons();
  assert.equal(r.attempted, false);
  assert.equal(r.ok, false);
  assert.match(r.detail, /DPS_NO_BRIDGE/);
  // An unattempted release must not read as a successful one, and must say what
  // covers the gap.
  assert.match(r.detail, /750 ms/);
});

test("a stop with no release still reports the firmware backstop", async () => {
  const report = await stopAutomation({ by: "cli", skipTunnels: true });
  assert.equal(report.release.ok, false);
  assert.match(report.summary, /latched OFF/);
  assert.match(report.summary, /watchdog/);
});

test("stoppedMessage names the time, the source, and the reason", () => {
  const msg = stoppedMessage({
    at: "2026-08-26T12:00:00.000Z",
    by: "status-bar",
    reason: "one press from launching a game",
    pid: 1,
    host: "test",
  });
  assert.match(msg, /2026-08-26T12:00:00\.000Z/);
  assert.match(msg, /status-bar/);
  assert.match(msg, /one press from launching a game/);
});

// ---------------------------------------------------------------------------
// The tunnel registry
// ---------------------------------------------------------------------------

test("a registered tunnel is visible in status and closed by its own process", () => {
  let closed = 0;
  const id = registerTunnel("cdp", process.pid, "test forward", () => closed++);

  const before = automationStatus().tunnels;
  assert.equal(before.length, 1);
  assert.equal(before[0].kind, "cdp");
  assert.equal(before[0].ownerPid, process.pid);

  const report = killAllTunnels();
  assert.equal(closed, 1, "the owning process's closer was not called");
  assert.equal(report.closed, 1);
  assert.equal(report.byKind.cdp, 1);
  assert.equal(automationStatus().tunnels.length, 0, "the entry outlived the tunnel");

  unregisterTunnel(id); // idempotent
});

test("cdp and ingest tunnels are counted separately", () => {
  registerTunnel("cdp", process.pid, "forward", () => {});
  registerTunnel("cdp", process.pid, "forward 2", () => {});
  registerTunnel("ingest", process.pid, "reverse", () => {});

  const report = killAllTunnels();
  // Reported separately because they mean different things: a live cdp forward
  // is the automation path, a live ingest tunnel is only log traffic.
  assert.equal(report.byKind.cdp, 2);
  assert.equal(report.byKind.ingest, 1);
  assert.equal(report.closed, 3);
});

test("unregistering removes the entry so a stop does not try to kill it", () => {
  let closed = 0;
  const id = registerTunnel("cdp", process.pid, "short-lived", () => closed++);
  unregisterTunnel(id);

  assert.equal(automationStatus().tunnels.length, 0);
  const report = killAllTunnels();
  assert.equal(report.closed, 0);
  assert.equal(closed, 0, "a tunnel that already closed was closed again");
});

test("an entry naming a dead pid is pruned, never killed", () => {
  // No local closer, and a pid nothing can be running under. The registry has
  // to notice that rather than firing process.kill at whatever holds it now.
  const dir = path.join(tempHome, ".config", "decky-plugin-studio", "automation-tunnels");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "orphan.json"),
    JSON.stringify({
      id: "orphan",
      kind: "cdp",
      pid: 0,
      ownerPid: 999999,
      since: new Date().toISOString(),
    }),
    "utf8",
  );

  const report = killAllTunnels();
  assert.equal(report.stale, 1);
  assert.equal(report.closed, 0);
  assert.equal(report.failed, 0);
  assert.match(report.details.join(" "), /already gone/);
});

test("an entry older than the TTL is pruned without killing, because pids get reused", () => {
  const dir = path.join(tempHome, ".config", "decky-plugin-studio", "automation-tunnels");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "ancient.json"),
    JSON.stringify({
      id: "ancient",
      kind: "cdp",
      // This process is definitely alive, so only the age can save whatever pid
      // this names from being killed.
      pid: process.pid,
      ownerPid: 999999,
      since: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    }),
    "utf8",
  );

  const report = killAllTunnels();
  assert.equal(report.stale, 1);
  assert.equal(report.closed, 0);
  assert.match(report.details.join(" "), /older than 6h/);
  assert.equal(automationStatus().tunnels.length, 0);
});

test("a stop tears down the tunnels it can see", async () => {
  let closed = 0;
  registerTunnel("cdp", process.pid, "run forward", () => closed++);
  registerTunnel("ingest", process.pid, "ingest", () => closed++);

  const report = await stopAutomation({ by: "status-bar", reason: "stop everything" });
  assert.equal(closed, 2);
  assert.equal(report.tunnels.closed, 2);
  assert.match(report.summary, /1 cdp \+ 1 ingest closed/);
});

// ---------------------------------------------------------------------------
// Aborting a run that is already going
// ---------------------------------------------------------------------------

test("a latch set mid-run stops the run and is reported as a stop, not as failures", async () => {
  /*
   * The interesting case, and the one that needed a way to be deterministic.
   * Refusing a run that starts latched is easy; the branch worth pinning is a
   * stop that lands while a run is already walking, because that is what
   * actually happens when somebody reaches for the button.
   *
   * The fake CDP calls pageValue once per read with a counter, so the latch can
   * be set from inside a specific read rather than from a timer racing the
   * loop. No sleeps, no flake.
   *
   * DPS_NO_BRIDGE is on throughout, so every press refuses and no hardware is
   * involved; with stopOnFailure off the run would otherwise walk all six steps.
   * What is being measured is that it does not, and how it says so.
   */
  let latchedAtRead = -1;
  const fake = await startFakeCdp(["QuickAccess_uid2"], (_title, readIndex) => {
    if (readIndex === 2 && latchedAtRead < 0) {
      latchedAtRead = readIndex;
      fs.writeFileSync(
        getLatchPath(),
        JSON.stringify({
          at: new Date().toISOString(),
          by: "status-bar",
          reason: "mid-run stop",
          pid: process.pid,
          host: "test",
        }),
        "utf8",
      );
    }
    return focusedPage;
  });

  try {
    const result = await runSequence({
      steps: Array.from({ length: 6 }, (_, i) => ({ press: "DOWN", label: `step ${i + 1}` })),
      stopOnFailure: false,
      cdpUrl: fake.base,
      writeEvidence: false,
    });

    assert.ok(latchedAtRead >= 0, "the latch was never set, so this tested nothing");
    assert.equal(result.stopped, true, "a mid-run latch was not reported as a stop");
    assert.equal(result.ok, false);
    assert.ok(result.ranSteps < 6, `the run ignored the latch and ran ${result.ranSteps}/6 steps`);
    // Distinguishes the loop-top abort from the pre-flight refusal: the run has
    // to have genuinely started before the latch caught it, or this test has
    // quietly become a duplicate of the "refuses before the tunnel" one.
    assert.ok(result.ranSteps >= 1, "the run never started, so the mid-run branch was not the one taken");

    // The wording is the point of the loop-top check. Without it this run would
    // read as six failed presses -- indistinguishable from a broken bridge or a
    // broken focus graph, and the wrong thing entirely to go and investigate.
    assert.match(result.summary, /KILLSWITCH/);
    assert.match(result.summary, /never attempted/);
    assert.match(result.reason ?? "", /STOPPED/);
  } finally {
    await fake.close();
  }
});
