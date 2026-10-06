/**
 * Tests for the per-machine driving lease (lease.ts).
 *
 * Sandboxed like killswitch.test.ts: the lease files live under the config
 * dir, which derives from os.homedir(), which follows USERPROFILE/HOME.
 * "Another process" is a hand-written lease record with a foreign pid and an
 * injected liveness probe, so no second process is ever spawned.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const realHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dps-lease-"));
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;

const {
  acquireLease,
  renewLease,
  releaseLease,
  readLease,
  leasePath,
  leaseHeldByOther,
  leaseHeldByMe,
  listLeases,
  releaseLeasesHeldByThisProcess,
  withLease,
  LeaseRefusedError,
  DEFAULT_LEASE_TTL_MS,
} = await import("./lease.js");

function assertSandboxed(): void {
  assert.ok(leasePath("x").startsWith(tempHome), `lease path escaped the sandbox: ${leasePath("x")}`);
}

before(() => assertSandboxed());
beforeEach(() => {
  assertSandboxed();
  fs.rmSync(path.dirname(leasePath("x")), { recursive: true, force: true });
});
after(() => {
  process.env.USERPROFILE = realHome.USERPROFILE;
  process.env.HOME = realHome.HOME;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

const alive = () => true;
const dead = () => false;

/** A lease held by some other process on this host. */
function foreignLease(machine: string, opts: { expiresInMs?: number; pid?: number } = {}): void {
  const now = Date.now();
  const rec = {
    machine,
    ownerPid: opts.pid ?? 999_999,
    ownerHost: os.hostname(),
    owner: `pid ${opts.pid ?? 999_999} on ${os.hostname()}`,
    purpose: "deck_sweep",
    since: new Date(now - 60_000).toISOString(),
    heartbeatAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + (opts.expiresInMs ?? 60_000)).toISOString(),
  };
  fs.mkdirSync(path.dirname(leasePath(machine)), { recursive: true });
  fs.writeFileSync(leasePath(machine), JSON.stringify(rec));
}

test("a free machine is acquired, and acquiring again renews rather than restarts", () => {
  const first = acquireLease("deck", { purpose: "deck_pressButton" });
  assert.ok(first.ok);
  assert.equal(first.renewed, false);
  assert.equal(first.lease.ownerPid, process.pid);
  assert.equal(first.lease.purpose, "deck_pressButton");
  assert.ok(fs.existsSync(leasePath("deck")));

  const second = acquireLease("deck", { purpose: "deck_walkTo" });
  assert.ok(second.ok);
  assert.equal(second.renewed, true);
  assert.equal(second.lease.since, first.lease.since, "the lease started when the session first took it");
  assert.equal(second.lease.purpose, "deck_walkTo", "the purpose follows the latest call");
  assert.equal(leaseHeldByMe("deck"), true);
  assert.equal(leaseHeldByOther("deck"), null);
});

test("a live lease held by another process refuses, naming the holder and how to take over", () => {
  foreignLease("deck");
  const r = acquireLease("deck", { purpose: "deck_pressButton", pidAlive: alive });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.holder.ownerPid, 999_999);
  assert.match(r.reason, /being driven by another session/);
  assert.match(r.reason, /deck_sweep/);
  assert.match(r.reason, /deck_releaseMachine\(\{ machine: "deck", force: true \}\)/);
  assert.equal(leaseHeldByOther("deck", { pidAlive: alive })?.ownerPid, 999_999);
  // Nothing was written over the holder's record.
  assert.equal(readLease("deck")?.ownerPid, 999_999);
});

test("an expired lease is taken over, and the takeover is reported", () => {
  foreignLease("deck", { expiresInMs: -1 });
  const r = acquireLease("deck", { purpose: "deck_deploy", pidAlive: alive });
  assert.ok(r.ok);
  assert.equal(r.tookOverFrom?.ownerPid, 999_999);
  assert.equal(readLease("deck")?.ownerPid, process.pid);
});

test("a lease whose owner pid is dead on this host is free", () => {
  foreignLease("deck");
  assert.equal(leaseHeldByOther("deck", { pidAlive: dead }), null);
  const r = acquireLease("deck", { purpose: "x", pidAlive: dead });
  assert.ok(r.ok);
  assert.equal(r.tookOverFrom?.ownerPid, 999_999);
});

test("expiry follows the heartbeat: a renewed lease moves its expiresAt forward", () => {
  let t = 1_000_000;
  const now = () => t;
  const first = acquireLease("deck", { purpose: "x", now });
  assert.ok(first.ok);
  assert.equal(Date.parse(first.lease.expiresAt), t + DEFAULT_LEASE_TTL_MS);
  t += 5 * 60_000;
  assert.equal(renewLease("deck", { now }), true);
  assert.equal(Date.parse(readLease("deck")!.expiresAt), t + DEFAULT_LEASE_TTL_MS);
});

test("renewLease on a lease this process does not hold is a no-op", () => {
  foreignLease("deck");
  assert.equal(renewLease("deck", { pidAlive: alive }), false);
  assert.equal(readLease("deck")?.ownerPid, 999_999);
});

test("release: own always; dead always; another's live lease only with force, and the result says so", () => {
  acquireLease("deck", { purpose: "x" });
  let r = releaseLease("deck");
  assert.equal(r.released, true);
  assert.equal(r.forced, false);
  assert.equal(readLease("deck"), null);

  foreignLease("deck");
  r = releaseLease("deck", { pidAlive: alive });
  assert.equal(r.released, false);
  assert.match(r.note, /force: true/);
  assert.equal(readLease("deck")?.ownerPid, 999_999, "still theirs");

  r = releaseLease("deck", { pidAlive: alive, force: true });
  assert.equal(r.released, true);
  assert.equal(r.forced, true);
  assert.match(r.note, /evicted/);
  assert.equal(readLease("deck"), null);

  foreignLease("deck", { expiresInMs: -1 });
  r = releaseLease("deck", { pidAlive: alive });
  assert.equal(r.released, true);
  assert.equal(r.forced, false, "removing a dead lease is not an eviction");

  r = releaseLease("deck");
  assert.equal(r.released, false);
  assert.match(r.note, /no lease/);
});

test("withLease refuses before running when another live holder exists, and keeps the lease after running", async () => {
  foreignLease("standin-1");
  let ran = false;
  await assert.rejects(
    withLease("standin-1", "deck_sweep", async () => {
      ran = true;
    }, { pidAlive: alive }),
    LeaseRefusedError,
  );
  assert.equal(ran, false, "the body never ran");

  const out = await withLease("deck", "deck_sweep", async () => {
    assert.equal(leaseHeldByMe("deck"), true, "held while the body runs");
    return 42;
  });
  assert.equal(out, 42);
  assert.equal(leaseHeldByMe("deck"), true, "the lease belongs to the session, not the call");
  assert.equal(readLease("deck")?.purpose, "deck_sweep");
});

test("listLeases reports live/mine, and releaseLeasesHeldByThisProcess drops only ours", () => {
  acquireLease("deck", { purpose: "a" });
  acquireLease("standin-1", { purpose: "b" });
  foreignLease("standin-2");
  const all = listLeases({ pidAlive: alive });
  assert.deepEqual(
    all.map((l) => [l.machine, l.live, l.mine]).sort(),
    [
      ["deck", true, true],
      ["standin-1", true, true],
      ["standin-2", true, false],
    ],
  );
  const released = releaseLeasesHeldByThisProcess();
  assert.deepEqual(released.sort(), ["deck", "standin-1"]);
  assert.equal(readLease("standin-2")?.ownerPid, 999_999, "the foreign lease is untouched");
});

test("an unreadable lease file counts as held until its (unknown) expiry, which reads as already expired", () => {
  fs.mkdirSync(path.dirname(leasePath("deck")), { recursive: true });
  fs.writeFileSync(leasePath("deck"), "{ half a record");
  const rec = readLease("deck");
  assert.ok(rec);
  assert.match(rec!.owner, /unreadable/);
  // Its expiry cannot be parsed, so it does not get to block anyone.
  const r = acquireLease("deck", { purpose: "x" });
  assert.ok(r.ok);
});
