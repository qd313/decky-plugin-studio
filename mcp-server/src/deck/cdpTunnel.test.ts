/**
 * Tests for the shared CDP tunnel (cdpTunnel.ts).
 *
 * cdpTunnel.ts used to open a fresh ssh forward for every single call and
 * tear it down again, which is safe but slow: a full SSH handshake plus a
 * 300ms-step readiness poll ahead of every ~150ms CDP round trip. This suite
 * pins the replacement -- one tunnel, shared for the life of the process --
 * and, more importantly, pins every failure mode that a shared tunnel adds
 * and a per-call one never had to worry about: a dead tunnel getting reused,
 * two callers racing to create the first one, a stop leaking the ssh process,
 * and a changed Deck IP still pointing at yesterday's forward.
 *
 * NO NETWORK, NO REAL SSH. `proc.spawn` (cdpTunnel.ts's seam over
 * child_process, the same pattern deployHelpers.ts uses for execSync) is
 * replaced with a fake that hands back an EventEmitter standing in for a
 * ChildProcess -- trackable, killable, and able to fire `exit` on command to
 * simulate the Deck sleeping or the link dropping. `proc.freePort` is pointed
 * at a real fake CDP server (__testutil__/fakeCdp.ts, the same one cdp.test.ts
 * and runSequence.test.ts use) running on loopback, so the readiness poll
 * inside createTunnel() has something real to succeed against without ever
 * touching an actual ssh process or an actual Deck.
 *
 * Sandboxing note, same as killswitch.test.ts: getConfigDir() derives from
 * os.homedir(), which Node reads from USERPROFILE/HOME at call time, so
 * pointing those at a temp dir moves both the killswitch's latch file and its
 * cross-process tunnel registry with them. Every test asserts the redirect
 * took before writing anything, because a test that reached the real registry
 * could register (and then kill) something that was not ours to touch.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

const realHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dps-cdptunnel-"));
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;

const realDeckEnv = { DECK_IP: process.env.DECK_IP, DECK_USER: process.env.DECK_USER };

const { startFakeCdp } = await import("./__testutil__/fakeCdp.js");
const { openCdpTunnel, withCdpTunnel, closeSharedCdpTunnel, proc, DeckNotConfiguredError } = await import(
  "./cdpTunnel.js"
);
const { killAllTunnels, stopAutomation, armAutomation, getLatchPath } = await import("./killswitch.js");

const realSpawn = proc.spawn;
const realFreePort = proc.freePort;

function assertSandboxed(): void {
  assert.ok(
    getLatchPath().startsWith(tempHome),
    `latch path escaped the sandbox: ${getLatchPath()} is not under ${tempHome}`,
  );
}

// ---------------------------------------------------------------------------
// The fake ssh child. Just enough of ChildProcess's surface for cdpTunnel.ts:
// stderr (readable, setEncoding), `on`/`emit` for "exit", `pid`, `killed`,
// and a `kill()` that flips `killed` and fires `exit` asynchronously, the way
// a real process does.
// ---------------------------------------------------------------------------
let nextPid = 9000;

function makeFakeChild(): ChildProcess {
  const raw = new EventEmitter() as unknown as Record<string, unknown>;
  raw.pid = nextPid++;
  raw.killed = false;
  const stderr = new EventEmitter() as unknown as Record<string, unknown>;
  stderr.setEncoding = () => {};
  raw.stderr = stderr;
  raw.kill = (): boolean => {
    if (raw.killed) return true;
    raw.killed = true;
    setImmediate(() => (raw as unknown as EventEmitter).emit("exit", null, null));
    return true;
  };
  return raw as unknown as ChildProcess;
}

let spawnArgs: string[][] = [];
let spawnedChildren: ChildProcess[] = [];
let fakePort = 0;

function installFakes(): void {
  spawnArgs = [];
  spawnedChildren = [];
  proc.spawn = ((_cmd: string, args: string[]) => {
    spawnArgs.push(args);
    const child = makeFakeChild();
    spawnedChildren.push(child);
    return child;
  }) as unknown as typeof proc.spawn;
  proc.freePort = (async () => fakePort) as unknown as typeof proc.freePort;
}

let fake: Awaited<ReturnType<typeof startFakeCdp>>;

before(async () => {
  assertSandboxed();
  fake = await startFakeCdp(["SharedJSContext"], () => ({ ok: true }));
  fakePort = Number(new URL(fake.base).port);
});

beforeEach(() => {
  assertSandboxed();
  closeSharedCdpTunnel();
  fs.rmSync(getLatchPath(), { force: true });
  installFakes();
  process.env.DECK_IP = "10.0.0.50";
  process.env.DECK_USER = "deck";
});

after(async () => {
  closeSharedCdpTunnel();
  proc.spawn = realSpawn;
  proc.freePort = realFreePort;
  process.env.USERPROFILE = realHome.USERPROFILE;
  process.env.HOME = realHome.HOME;
  if (realDeckEnv.DECK_IP === undefined) delete process.env.DECK_IP;
  else process.env.DECK_IP = realDeckEnv.DECK_IP;
  if (realDeckEnv.DECK_USER === undefined) delete process.env.DECK_USER;
  else process.env.DECK_USER = realDeckEnv.DECK_USER;
  fs.rmSync(tempHome, { recursive: true, force: true });
  await fake.close();
});

// ---------------------------------------------------------------------------

test("N sequential opens create one tunnel, not N", async () => {
  const N = 5;
  const bases = new Set<string>();
  for (let i = 0; i < N; i++) {
    const tunnel = await openCdpTunnel();
    bases.add(tunnel.base);
    tunnel.close();
  }
  assert.equal(spawnArgs.length, 1, "ssh should be spawned exactly once for 5 sequential opens");
  assert.equal(bases.size, 1, "every call should get back the same forward");
});

test("withCdpTunnel does not close the shared tunnel afterwards", async () => {
  await withCdpTunnel(async (base) => {
    assert.ok(base.startsWith("http://127.0.0.1:"));
  });
  assert.equal(spawnArgs.length, 1);
  assert.equal(spawnedChildren[0].killed, false, "close() after a call must be a no-op now");

  await withCdpTunnel(async () => {});
  assert.equal(spawnArgs.length, 1, "a second call should reuse the same tunnel, not reopen it");
});

test("a dead tunnel is detected and rebuilt on the next call", async () => {
  const first = await openCdpTunnel();
  assert.equal(spawnArgs.length, 1);
  const firstChild = spawnedChildren[0];
  assert.ok(first.base);

  // Simulate the Deck sleeping / the network dropping: ssh notices (its own
  // ServerAliveInterval/ExitOnForwardFailure) and exits on its own, without
  // anyone calling kill().
  firstChild.emit("exit", 1, null);

  const second = await openCdpTunnel();
  assert.equal(spawnArgs.length, 2, "a dead tunnel must be rebuilt, not reused");
  assert.notEqual(spawnedChildren[1], firstChild, "the rebuild must be a distinct ssh process");
  assert.ok(second.base);
});

test("concurrent first-calls create exactly one tunnel", async () => {
  const [a, b, c] = await Promise.all([openCdpTunnel(), openCdpTunnel(), openCdpTunnel()]);
  assert.equal(spawnArgs.length, 1, "three concurrent first-callers must share one ssh spawn");
  assert.equal(a.base, b.base);
  assert.equal(b.base, c.base);
});

test("closeSharedCdpTunnel (server shutdown) kills the ssh child and forces a fresh tunnel next time", async () => {
  await openCdpTunnel();
  assert.equal(spawnArgs.length, 1);
  const child = spawnedChildren[0];
  assert.equal(child.killed, false);

  closeSharedCdpTunnel();
  assert.equal(child.killed, true, "shutdown must not leave the ssh process behind");

  await openCdpTunnel();
  assert.equal(spawnArgs.length, 2, "a released tunnel must not be reused");
});

test("closeSharedCdpTunnel is a harmless no-op when nothing is open", () => {
  assert.doesNotThrow(() => closeSharedCdpTunnel());
});

test("the killswitch (stopAutomation) tears down the shared tunnel", async () => {
  await openCdpTunnel();
  assert.equal(spawnArgs.length, 1);
  const child = spawnedChildren[0];
  assert.equal(child.killed, false);

  const report = await stopAutomation({ by: "tool", reason: "test" });
  assert.equal(report.tunnels.byKind.cdp, 1, "the killswitch should report closing one cdp tunnel");
  assert.equal(child.killed, true, "the killswitch must kill the ssh process, not just forget about it");

  const after = await openCdpTunnel();
  assert.equal(spawnArgs.length, 2, "a killswitch-torn-down tunnel must not be reused");
  assert.ok(after.base);

  armAutomation();
});

test("killAllTunnels leaves nothing behind for the registry to still see", async () => {
  await openCdpTunnel();
  killAllTunnels();
  const second = killAllTunnels();
  assert.equal(second.closed, 0, "the tunnel should already be gone by the second call");
  assert.equal(second.details.length, 0);
});

test("a changed Deck IP invalidates the shared tunnel", async () => {
  await openCdpTunnel();
  assert.equal(spawnArgs.length, 1);
  assert.ok(spawnArgs[0].some((a) => a.includes("10.0.0.50")), "first tunnel should target the original IP");
  const firstChild = spawnedChildren[0];

  process.env.DECK_IP = "10.0.0.99";
  await openCdpTunnel();
  assert.equal(spawnArgs.length, 2, "a changed Deck IP must open a fresh tunnel, not reuse the old one");
  assert.equal(firstChild.killed, true, "the stale tunnel to the old IP must be closed");
  assert.ok(spawnArgs[1].some((a) => a.includes("10.0.0.99")), "the new tunnel should target the new IP");
});

test("a changed Deck user (same host) also invalidates the shared tunnel", async () => {
  await openCdpTunnel();
  assert.equal(spawnArgs.length, 1);
  const firstChild = spawnedChildren[0];

  process.env.DECK_USER = "someoneelse";
  await openCdpTunnel();
  assert.equal(spawnArgs.length, 2);
  assert.equal(firstChild.killed, true);
});

test("throws DeckNotConfiguredError with no Deck IP, without touching an existing tunnel", async () => {
  await openCdpTunnel();
  assert.equal(spawnArgs.length, 1);

  delete process.env.DECK_IP;
  await assert.rejects(() => openCdpTunnel(), DeckNotConfiguredError);

  process.env.DECK_IP = "10.0.0.50";
  const tunnel = await openCdpTunnel();
  assert.equal(spawnArgs.length, 1, "the existing tunnel should still be there once DECK_IP comes back");
  assert.ok(tunnel.base);
});
