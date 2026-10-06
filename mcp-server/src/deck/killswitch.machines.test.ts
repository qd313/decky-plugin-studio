/**
 * The killswitch's per-machine half (plan 10): a stand-in can be stopped on
 * its own, a stop releases a virtual pad, and re-arming clears everything.
 *
 * Same sandbox as killswitch.test.ts (temp HOME, DPS_NO_BRIDGE set by
 * default). The one case that clears the guard talks only to a fake vpad on
 * loopback and stops a machine whose transport is `vigem`, so no serial port
 * is opened and no python is spawned.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const realHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
const realDeckIp = process.env.DECK_IP;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dps-killswitch-machines-"));
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
delete process.env.DECK_IP;

const { automationStopped, stopAutomation, armAutomation, automationStatus, getLatchPath, machinesStopped, releaseVirtualPad } =
  await import("./killswitch.js");
const { getMachinesPath, resolveMachine } = await import("../machines.js");
const { registerTunnel, killAllTunnels } = await import("./killswitch.js");

function assertSandboxed(): void {
  assert.ok(getLatchPath().startsWith(tempHome), `latch path escaped the sandbox: ${getLatchPath()}`);
  assert.ok(getMachinesPath().startsWith(tempHome), `registry path escaped the sandbox: ${getMachinesPath()}`);
}

before(() => assertSandboxed());
beforeEach(() => {
  assertSandboxed();
  fs.mkdirSync(path.dirname(getLatchPath()), { recursive: true });
  for (const n of fs.readdirSync(path.dirname(getLatchPath()))) {
    if (n.startsWith("automation-stop")) fs.rmSync(path.join(path.dirname(getLatchPath()), n), { force: true });
  }
  fs.rmSync(getMachinesPath(), { force: true });
  fs.rmSync(path.join(path.dirname(getLatchPath()), "automation-tunnels"), { recursive: true, force: true });
});
after(() => {
  process.env.USERPROFILE = realHome.USERPROFILE;
  process.env.HOME = realHome.HOME;
  if (realDeckIp === undefined) delete process.env.DECK_IP;
  else process.env.DECK_IP = realDeckIp;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

function withGuard<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prior = process.env.DPS_NO_BRIDGE;
  if (value === undefined) delete process.env.DPS_NO_BRIDGE;
  else process.env.DPS_NO_BRIDGE = value;
  return fn().finally(() => {
    if (prior === undefined) delete process.env.DPS_NO_BRIDGE;
    else process.env.DPS_NO_BRIDGE = prior;
  });
}

test("a per-machine stop latches that machine only; the stop-all latch and other machines stay armed", async () => {
  const report = await stopAutomation({ by: "tool", reason: "standin-1 looks wrong", machine: "standin-1", skipTunnels: true });
  assert.equal(report.ok, true);
  assert.equal(report.record.machine, "standin-1");
  assert.equal(report.latchPath, getLatchPath("standin-1"));
  assert.match(report.summary, /automation on "standin-1" latched OFF/);

  assert.equal(automationStopped(), null, "the stop-all latch is clear");
  assert.equal(automationStopped("deck"), null, "the Deck is not stopped");
  const rec = automationStopped("standin-1");
  assert.ok(rec);
  assert.equal(rec!.machine, "standin-1");
  assert.equal(rec!.reason, "standin-1 looks wrong");

  assert.deepEqual(machinesStopped().map((r) => r.machine), ["standin-1"]);
  const status = automationStatus();
  assert.equal(status.armed, true, "armed overall...");
  assert.deepEqual(status.machinesStopped.map((s) => s.machine), ["standin-1"], "...but stopped on standin-1");
  assert.match(status.summary, /stopped on standin-1/);
});

test("the stop-all latch stops every machine, whatever their own latches say", async () => {
  await stopAutomation({ by: "tool", skipTunnels: true });
  assert.ok(automationStopped("standin-1"), "a machine with no latch of its own is still stopped by the stop-all");
  assert.ok(automationStopped("deck"));
});

test("re-arming clears the stop-all latch AND every per-machine latch, and says which", async () => {
  await stopAutomation({ by: "tool", machine: "standin-1", skipTunnels: true });
  await stopAutomation({ by: "tool", machine: "standin-2", skipTunnels: true });
  await stopAutomation({ by: "tool", skipTunnels: true });
  const armed = armAutomation();
  assert.equal(armed.ok, true);
  assert.equal(armed.wasStopped, true);
  assert.deepEqual(armed.machinesCleared.sort(), ["standin-1", "standin-2"]);
  assert.match(armed.summary, /also cleared per-machine stops on/);
  assert.equal(automationStopped(), null);
  assert.equal(automationStopped("standin-1"), null);
  assert.deepEqual(machinesStopped(), []);
});

test("re-arming with only per-machine latches set still counts as having been stopped", async () => {
  await stopAutomation({ by: "tool", machine: "standin-1", skipTunnels: true });
  const armed = armAutomation();
  assert.equal(armed.wasStopped, true);
  assert.deepEqual(armed.machinesCleared, ["standin-1"]);
  assert.match(armed.summary, /cleared per-machine stops on standin-1/);
});

test("a per-machine stop takes down only that machine's registered tunnels", () => {
  let closedA = 0;
  let closedB = 0;
  let closedUntagged = 0;
  registerTunnel("cdp", process.pid, "a", () => closedA++, "standin-1");
  registerTunnel("cdp", process.pid, "b", () => closedB++, "standin-2");
  registerTunnel("ingest", process.pid, "old server, no tag", () => closedUntagged++);
  const r = killAllTunnels("standin-1");
  assert.equal(r.closed, 1);
  assert.equal(closedA, 1);
  assert.equal(closedB, 0);
  assert.equal(closedUntagged, 0, "an untagged entry is left for the stop-all");
  const all = killAllTunnels();
  assert.equal(all.closed, 2);
  assert.equal(closedB, 1);
  assert.equal(closedUntagged, 1);
});

// ---- releasing a virtual pad ----------------------------------------------

function fakePad(): Promise<{ port: number; releases: number; close: () => Promise<void> }> {
  const state = { releases: 0 };
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => {
      for (const line of d.split("\n")) {
        if (!line.trim()) continue;
        const cmd = JSON.parse(line) as { t: string };
        if (cmd.t === "release") state.releases++;
        sock.write(JSON.stringify({ ok: true, t: cmd.t }) + "\n");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: (server.address() as net.AddressInfo).port,
        get releases() {
          return state.releases;
        },
        close: () => new Promise((r) => server.close(() => r())),
      }),
    ),
  );
}

test("releaseVirtualPad under DPS_NO_BRIDGE sends nothing and says so", async () => {
  fs.writeFileSync(getMachinesPath(), JSON.stringify({ machines: { pc: { os: "windows", local: true, press: "vigem" } } }));
  const r = await releaseVirtualPad(resolveMachine("pc"), () => ({ host: "127.0.0.1", port: 1 }));
  assert.equal(r.attempted, false);
  assert.match(r.detail, /DPS_NO_BRIDGE/);
});

test("a per-machine stop on a vigem machine releases its virtual pad through the injected endpoint", async () => {
  const pad = await fakePad();
  try {
    fs.writeFileSync(
      getMachinesPath(),
      JSON.stringify({ machines: { pc: { os: "windows", local: true, press: "vigem", padPort: pad.port } } }),
    );
    const report = await withGuard(undefined, () =>
      stopAutomation({
        by: "tool",
        machine: "pc",
        skipTunnels: true,
        padEndpointIfOpen: (m) => (m.name === "pc" ? { host: "127.0.0.1", port: pad.port } : null),
      }),
    );
    assert.equal(pad.releases, 1, "the fake daemon received exactly one release");
    assert.equal(report.release.attempted, true);
    assert.equal(report.release.ok, true);
    assert.match(report.summary, /pad on pc released/);
  } finally {
    await pad.close();
  }
});

test("with no open channel to a remote pad, the stop says the daemon's own watchdog covers it", async () => {
  fs.writeFileSync(getMachinesPath(), JSON.stringify({ machines: { "standin-1": { host: "standin-1", press: "uinput" } } }));
  const report = await withGuard(undefined, () =>
    stopAutomation({ by: "tool", machine: "standin-1", skipTunnels: true, padEndpointIfOpen: () => null }),
  );
  assert.equal(report.release.attempted, false);
  assert.match(report.release.detail, /releases on disconnect/);
  assert.match(report.summary, /release NOT confirmed/);
});
