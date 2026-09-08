/**
 * Tests for the shared snapshot/lease state machine behind deck_holdAwake and
 * deck_snapshotSettings (see snapshotLease.ts's header for the design).
 *
 * THE RUN-FILE DIRECTORY IS REDIRECTED TO A TEMP HOME, same trick
 * killswitch.test.ts and gameSession.test.ts use: getConfigDir() derives from
 * os.homedir(), read at call time, so pointing USERPROFILE/HOME at a temp dir
 * moves every run file with it. Otherwise this suite would write into a
 * developer's real ~/.config/decky-plugin-studio/snapshots.
 *
 * These tests exercise the generic module directly with small fake
 * controllers -- no SSH, no Deck, nothing feature-specific. holdAwake.test.ts
 * and settingsSnapshot.test.ts cover the same guarantees again through the
 * real feature wrappers, with SSH faked.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const realHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dps-snapshotlease-"));
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;

const {
  takeSnapshot,
  restoreSnapshot,
  readSnapshotFile,
  writeSnapshotFile,
  snapshotPath,
  isExpired,
  CorruptSnapshotError,
  StaleSnapshotError,
} = await import("./snapshotLease.js");
import type { SnapshotController } from "./snapshotLease.js";

function assertSandboxed(): void {
  assert.ok(
    snapshotPath("sandbox-check").startsWith(tempHome),
    `snapshot path escaped the sandbox: ${snapshotPath("sandbox-check")} is not under ${tempHome}`
  );
}

before(() => assertSandboxed());
beforeEach(() => assertSandboxed());
after(() => {
  process.env.USERPROFILE = realHome.USERPROFILE;
  process.env.HOME = realHome.HOME;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

let kindCounter = 0;
/** A fresh kind per test, so one test's run file can never leak into another. */
function freshKind(): string {
  return `unit-${++kindCounter}`;
}

/** Escapes a literal string (e.g. a Windows path full of backslashes) for use
 * inside a RegExp constructed at runtime. */
function reEscape(literal: string): RegExp {
  return new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

interface Fixture {
  n: number;
}

function makeController(
  kind: string,
  current: Fixture,
  apply: (v: Fixture) => void | Promise<void> = () => {}
): SnapshotController<Fixture> {
  return {
    kind,
    restoreToolHint: `restore_${kind}`,
    ttlMinutes: 30,
    readCurrent: () => current,
    apply,
  };
}

// ---------------------------------------------------------------------------
// Values are persisted before the change is applied
// ---------------------------------------------------------------------------

test("takeSnapshot writes the run file with the previous value before applyNew's result is ever applied", async () => {
  const kind = freshKind();
  let sawOnDiskDuringApply: unknown = "not called";
  const ctrl = makeController(kind, { n: 5 }, () => {
    // At the moment `apply` runs, the run file must already exist on disk
    // with the ORIGINAL value -- proving the write happened first.
    sawOnDiskDuringApply = readSnapshotFile<Fixture>(kind);
  });

  const report = await takeSnapshot(ctrl, () => ({ n: 0 }));

  assert.notEqual(sawOnDiskDuringApply, "not called", "apply() was never invoked");
  const envelope = sawOnDiskDuringApply as ReturnType<typeof readSnapshotFile<Fixture>>;
  assert.ok(envelope, "the run file did not exist yet when apply() ran");
  assert.deepEqual(envelope!.values, { n: 5 });

  assert.deepEqual(report.previous, { n: 5 });
  assert.deepEqual(report.changed, { n: 0 });
  assert.equal(fs.existsSync(snapshotPath(kind)), true);
});

test("a snapshot-only controller (no applyNew) never calls apply() at take time", async () => {
  const kind = freshKind();
  let applyCalls = 0;
  const ctrl = makeController(kind, { n: 7 }, () => {
    applyCalls++;
  });

  const report = await takeSnapshot(ctrl); // no applyNew -- deck_snapshotSettings's shape

  assert.equal(applyCalls, 0, "apply() ran even though nothing was supposed to change at take time");
  assert.equal(report.changed, null);
  assert.deepEqual(report.previous, { n: 7 });
  assert.deepEqual(readSnapshotFile<Fixture>(kind)?.values, { n: 7 });
});

// ---------------------------------------------------------------------------
// Refuse a second snapshot over an unrestored one
// ---------------------------------------------------------------------------

test("a second take() over an unrestored snapshot is refused, naming the stale one and how to restore it", async () => {
  const kind = freshKind();
  const ctrl = makeController(kind, { n: 1 });
  await takeSnapshot(ctrl, () => ({ n: 0 }));

  await assert.rejects(
    () => takeSnapshot(ctrl, () => ({ n: 0 })),
    (err: unknown) => {
      assert.ok(err instanceof StaleSnapshotError, `expected StaleSnapshotError, got ${err}`);
      assert.match((err as Error).message, new RegExp(`restore_${kind}`));
      assert.match((err as Error).message, /never restored/);
      assert.match((err as Error).message, reEscape(snapshotPath(kind)));
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Restore: safe no-op, and idempotent
// ---------------------------------------------------------------------------

test("restoring with nothing ever snapshotted is a clean no-op, not an error", async () => {
  const kind = freshKind();
  const ctrl = makeController(kind, { n: 1 }, () => {
    throw new Error("apply() must never be called when there is nothing to restore");
  });

  const report = await restoreSnapshot(ctrl);
  assert.equal(report.ok, true);
  assert.equal(report.restored, false);
  assert.equal(report.values, null);
  assert.match(report.note, /nothing to restore/);
});

test("restore is safe to call twice: the second call is also a no-op", async () => {
  const kind = freshKind();
  const applied: Fixture[] = [];
  const ctrl = makeController(kind, { n: 9 }, (v) => {
    applied.push(v);
  });

  await takeSnapshot(ctrl, () => ({ n: 0 }));
  const first = await restoreSnapshot(ctrl);
  const second = await restoreSnapshot(ctrl);

  assert.equal(first.restored, true);
  assert.deepEqual(first.values, { n: 9 });
  assert.equal(second.restored, false);
  assert.equal(second.values, null);
  // One apply from take() pushing the new value, one from the single real
  // restore -- the second restore call must not push anything at all.
  assert.deepEqual(applied, [{ n: 0 }, { n: 9 }]);
  assert.equal(fs.existsSync(snapshotPath(kind)), false, "the run file must be gone after a restore");
});

test("restore puts back exactly the captured value, unrelated to whatever readCurrent() would return now", async () => {
  const kind = freshKind();
  let currentOnDevice = { n: 100 };
  const applied: Fixture[] = [];
  const ctrl: SnapshotController<Fixture> = {
    kind,
    restoreToolHint: "x",
    ttlMinutes: 30,
    readCurrent: () => currentOnDevice,
    apply: (v) => {
      applied.push(v);
    },
  };

  await takeSnapshot(ctrl, () => ({ n: 0 }));
  currentOnDevice = { n: 999 }; // something else changed the device meanwhile
  const report = await restoreSnapshot(ctrl);

  assert.deepEqual(report.values, { n: 100 });
  assert.deepEqual(applied[applied.length - 1], { n: 100 });
});

// ---------------------------------------------------------------------------
// A partially-written / corrupt run file is detected, never trusted
// ---------------------------------------------------------------------------

test("invalid JSON in the run file is detected, not treated as absent", async () => {
  const kind = freshKind();
  fs.mkdirSync(path.dirname(snapshotPath(kind)), { recursive: true });
  fs.writeFileSync(snapshotPath(kind), '{"kind":"' + kind + '","takenAt":"2020-01-01T00:00:00.000Z"', "utf8");

  const ctrl = makeController(kind, { n: 1 });
  assert.throws(() => readSnapshotFile(kind), CorruptSnapshotError);
  await assert.rejects(() => takeSnapshot(ctrl, () => ({ n: 0 })), CorruptSnapshotError);
  await assert.rejects(() => restoreSnapshot(ctrl), CorruptSnapshotError);
});

test("valid JSON missing a required field is detected, not treated as absent", async () => {
  const kind = freshKind();
  fs.mkdirSync(path.dirname(snapshotPath(kind)), { recursive: true });
  fs.writeFileSync(
    snapshotPath(kind),
    JSON.stringify({ kind, takenAt: new Date().toISOString(), values: { n: 1 } }), // no expiresAt/pid/host/sig
    "utf8"
  );

  assert.throws(() => readSnapshotFile(kind), CorruptSnapshotError);
});

test("a run file whose checksum does not match its own values is rejected, never restored", async () => {
  const kind = freshKind();
  const envelope = {
    kind,
    takenAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 9_000_000).toISOString(),
    pid: 1,
    host: "test-host",
    values: { n: 42 },
    sig: "0000000000000000not-the-real-checksum",
  };
  fs.mkdirSync(path.dirname(snapshotPath(kind)), { recursive: true });
  fs.writeFileSync(snapshotPath(kind), JSON.stringify(envelope), "utf8");

  const ctrl = makeController(kind, { n: 1 }, () => {
    throw new Error("apply() must never run against unverified values");
  });
  await assert.rejects(() => restoreSnapshot(ctrl), CorruptSnapshotError);
});

test("a genuine round trip through writeSnapshotFile passes its own checksum check", () => {
  const kind = freshKind();
  writeSnapshotFile(kind, { n: 3 }, 30);
  const back = readSnapshotFile<Fixture>(kind);
  assert.deepEqual(back?.values, { n: 3 });
});

// ---------------------------------------------------------------------------
// Expiry restores the original values automatically
// ---------------------------------------------------------------------------

test("an expired snapshot is auto-restored the next time take() runs for that kind, with the ORIGINAL values", async () => {
  const kind = freshKind();
  const applied: Fixture[] = [];
  let clock = 1_700_000_000_000;
  const now = () => clock;

  const ctrl: SnapshotController<Fixture> = {
    kind,
    restoreToolHint: "x",
    ttlMinutes: 1, // expires after 1 minute of (fake) wall clock
    readCurrent: () => ({ n: 2 }),
    apply: (v) => {
      applied.push(v);
    },
  };

  const first = await takeSnapshot(ctrl, () => ({ n: 0 }), { now });
  assert.equal(first.autoRestoredExpired, null);

  clock += 2 * 60_000; // 2 minutes later -- well past the 1-minute lease

  const second = await takeSnapshot(ctrl, () => ({ n: 0 }), { now });

  assert.ok(second.autoRestoredExpired, "the expired snapshot was not auto-restored");
  assert.deepEqual(second.autoRestoredExpired!.values, { n: 2 });
  // First apply (from the first take()) pushed the disabled value; the second
  // take() call auto-restores the ORIGINAL {n:2} before taking its own new
  // snapshot and disabling again.
  assert.deepEqual(applied, [{ n: 0 }, { n: 2 }, { n: 0 }]);

  // And the new snapshot it took afterwards is a normal, live one.
  await assert.rejects(() => takeSnapshot(ctrl, () => ({ n: 0 }), { now }), StaleSnapshotError);
});

test("a snapshot that has NOT yet expired is refused as stale, not auto-restored", async () => {
  const kind = freshKind();
  const applied: Fixture[] = [];
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const ctrl: SnapshotController<Fixture> = {
    kind,
    restoreToolHint: "x",
    ttlMinutes: 30,
    readCurrent: () => ({ n: 2 }),
    apply: (v) => {
      applied.push(v);
    },
  };

  await takeSnapshot(ctrl, () => ({ n: 0 }), { now });
  clock += 5 * 60_000; // 5 minutes later -- inside the 30-minute lease

  await assert.rejects(() => takeSnapshot(ctrl, () => ({ n: 0 }), { now }), StaleSnapshotError);
  assert.deepEqual(applied, [{ n: 0 }], "an unexpired snapshot must not be auto-restored");
});

test("isExpired is a pure function of the envelope and the clock", () => {
  const kind = freshKind();
  const env = writeSnapshotFile(kind, { n: 1 }, 10, { now: () => 1_000_000 });
  assert.equal(isExpired(env, () => 1_000_000), false);
  assert.equal(isExpired(env, () => 1_000_000 + 5 * 60_000), false);
  assert.equal(isExpired(env, () => 1_000_000 + 11 * 60_000), true);
});
