/**
 * Tests for deck_holdAwake / deck_restorePowerSettings, second implementation
 * (a logind block inhibitor, not two settings written over SSH).
 *
 * THE EXEC LAYER IS FAKED. proc.execSync (deploy/deployHelpers.ts) is the seam
 * every ssh/scp call in this codebase goes through; tests replace it for the
 * duration of a case, exactly as deckDeploy.test.ts does. No network, no
 * hardware, ever.
 *
 * THE RUN-FILE DIRECTORY IS REDIRECTED TO A TEMP HOME, same trick
 * killswitch.test.ts uses: getConfigDir() derives from os.homedir(), read at
 * call time, so pointing USERPROFILE/HOME at a temp dir moves the file with it.
 *
 * WHAT THESE TESTS CANNOT PROVE, stated plainly: a faked exec layer answers
 * whatever the test wrote, so none of this establishes that a block inhibitor
 * stops a real Steam Deck sleeping. That was settled separately, on hardware,
 * by holding the lock and calling SteamClient.System.SuspendPC() -- Steam
 * refused with "Access denied due to active block inhibitor". What IS pinned
 * here is the part that made v1 dishonest and the part that made the first
 * spike run lie: that `held` is decided ONLY by reading the lock back, and that
 * the lock is taken in system scope.
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
const { snapshotPath, writeSnapshotFile } = await import("./snapshotLease.js");
const {
  holdAwake,
  restorePowerSettings,
  buildWhy,
  clampTtlMinutes,
  holdCommand,
  releaseCommand,
  parseHoldOutput,
  HOLD_UNIT,
  HOLD_MARKER,
} = await import("./holdAwake.js");

function assertSandboxed(): void {
  assert.ok(
    snapshotPath("sandbox-check").startsWith(tempHome),
    `run file escaped the sandbox: ${snapshotPath("sandbox-check")} is not under ${tempHome}`,
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

const LOCK_LINE = `sleep 1800     0    root 4242   systemd-inhibit sleep ${HOLD_MARKER}: run 12    block`;

/** What the Deck answers: the three marked sections, in order. */
function deckSays(opts: { wasActive?: boolean; runOutput?: string; listed?: string | null }): string {
  return (
    "---DPS-HOLD-PRE---\n" +
    (opts.wasActive ? "active\n" : "inactive\n") +
    "---DPS-HOLD-RUN---\n" +
    (opts.runOutput ?? `Running as unit: ${HOLD_UNIT}.service\n`) +
    "---DPS-HOLD-LIST---\n" +
    (opts.listed === undefined ? LOCK_LINE : (opts.listed ?? "")) +
    "\n"
  );
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("buildWhy strips anything that could break out of the quoted ssh argument", () => {
  // The note is caller-supplied and lands inside a single-quoted argument
  // nested in a double-quoted remote command.
  const why = buildWhy("run 12'; rm -rf / #`whoami`$(id)");
  assert.ok(why.startsWith(HOLD_MARKER), why);
  for (const bad of ["'", '"', ";", "`", "$", "(", ")", "#", "&", "|"]) {
    assert.ok(!why.includes(bad), `"${bad}" survived sanitisation in: ${why}`);
  }
});

test("buildWhy with no note is just the marker, so the lock is still findable", () => {
  assert.equal(buildWhy(), HOLD_MARKER);
  assert.equal(buildWhy("   "), HOLD_MARKER);
});

test("clampTtlMinutes defaults to 30 and refuses absurd values in both directions", () => {
  assert.equal(clampTtlMinutes(undefined), 30);
  assert.equal(clampTtlMinutes(Number.NaN), 30);
  assert.equal(clampTtlMinutes(0), 1);
  assert.equal(clampTtlMinutes(-5), 1);
  assert.equal(clampTtlMinutes(99999), 480);
  assert.equal(clampTtlMinutes(45), 45);
});

test("the hold is taken in SYSTEM scope, which is the whole reason this works", () => {
  /*
   * The trap that made the first hardware spike report a false negative:
   * SteamOS ships logind.conf.d/killuserprocesses.conf with
   * KillUserProcesses=True, so anything launched from an SSH session dies when
   * that session ends -- including a setsid-detached process, which escapes
   * the controlling terminal but NOT the systemd session scope. The lock was
   * therefore already gone by the time the suspend arrived, and the Deck slept.
   * If this ever regresses to a plain background process, the tool silently
   * stops holding anything again.
   */
  const cmd = holdCommand("deck", "203.0.113.9", `${HOLD_MARKER}: x`, 1800);
  assert.match(cmd, /systemd-run --unit=dps-hold-awake/, "must be a transient system unit");
  assert.ok(!/setsid/.test(cmd), "setsid does not survive KillUserProcesses -- system scope is required");
  assert.ok(!/nohup/.test(cmd), "nohup does not survive KillUserProcesses either");
});

test("the hold asks for exactly the lock that stops Steam: what=sleep, mode=block", () => {
  const cmd = holdCommand("deck", "203.0.113.9", `${HOLD_MARKER}: x`, 1800);
  assert.match(cmd, /--what=sleep/);
  assert.match(cmd, /--mode=block/, "a delay inhibitor postpones a suspend; only block refuses it");
  assert.match(cmd, /sleep 1800/, "the TTL is the lease length, in seconds");
  assert.match(cmd, /ssh -o BatchMode=yes[^"]*deck@203\.0\.113\.9/);
});

test("a stale unit from a previous run is cleared before a new hold is taken", () => {
  // systemd-run refuses a unit name that already exists, so a failed leftover
  // would make every later hold fail for an unrelated reason.
  const cmd = holdCommand("deck", "203.0.113.9", HOLD_MARKER, 60);
  assert.match(cmd, /systemctl stop dps-hold-awake/);
  assert.match(cmd, /systemctl reset-failed dps-hold-awake/);
});

test("both commands read the lock back, so neither reports from intent alone", () => {
  assert.match(holdCommand("deck", "h", HOLD_MARKER, 60), /systemd-inhibit --list/);
  assert.match(releaseCommand("deck", "h"), /systemd-inhibit --list/);
});

test("parseHoldOutput finds the lock, and notices a hold that was already running", () => {
  const probe = parseHoldOutput(deckSays({ wasActive: true }));
  assert.equal(probe.wasActive, true);
  assert.ok(probe.evidence?.includes(HOLD_MARKER));
});

test("parseHoldOutput reports no evidence when the list is empty", () => {
  const probe = parseHoldOutput(deckSays({ listed: "" }));
  assert.equal(probe.evidence, null);
  assert.equal(probe.wasActive, false);
});

test("a DELAY inhibitor carrying our marker is not accepted as a hold", () => {
  // NetworkManager, rtkit, UPower and cecd all hold `sleep` delay locks on a
  // stock Deck. A delay lock postpones a suspend by a few seconds; it does not
  // refuse one, so matching the marker alone would be a false positive.
  const delayLine = `sleep 1800  0  root 4242 systemd-inhibit sleep ${HOLD_MARKER}: x   delay`;
  assert.equal(parseHoldOutput(deckSays({ listed: delayLine })).evidence, null);
});

// ---------------------------------------------------------------------------
// holdAwake
// ---------------------------------------------------------------------------

test("a hold is reported ONLY when the lock is read back from the Deck", async () => {
  const r = await withFakeExec(() => deckSays({}), () => holdAwake({ ttlMinutes: 30, note: "run 12" }));
  assert.equal(r.ok, true);
  assert.equal(r.held, true);
  assert.equal(r.unit, HOLD_UNIT);
  assert.ok(r.evidence?.includes(HOLD_MARKER), "the proving line is returned, not just a boolean");
  assert.ok(r.expiresAt, "a lease says when it lapses");
  assert.match(r.summary, /lease, not a setting/);
});

test("systemd-run claiming success does not make a hold -- an unlisted lock is held: false", async () => {
  /*
   * The exact failure v1 shipped: reporting success for a hold it never took.
   * Here systemd-run says the unit started and the inhibitor list is empty, so
   * nothing is held -- and the result must say so rather than trust the
   * hopeful half of the output.
   */
  const r = await withFakeExec(
    () => deckSays({ runOutput: `Running as unit: ${HOLD_UNIT}.service\n`, listed: "" }),
    () => holdAwake(),
  );
  assert.equal(r.held, false);
  assert.equal(r.ok, false);
  assert.equal(r.evidence, null);
  assert.match(r.summary, /NOT holding this Deck awake/);
  assert.match(r.summary, /can still sleep mid-run/);
});

test("the TTL reaches the Deck in seconds, and comes back as a wall-clock expiry", async () => {
  let sent = "";
  const r = await withFakeExec(
    (cmd) => {
      sent = cmd;
      return deckSays({});
    },
    () => holdAwake({ ttlMinutes: 45, now: () => 1_000_000 }),
  );
  assert.match(sent, /sleep 2700\b/, "45 minutes must arrive as 2700 seconds");
  assert.equal(r.ttlMinutes, 45);
  assert.equal(r.expiresAt, new Date(1_000_000 + 45 * 60_000).toISOString());
});

test("replacing a hold that was already running is reported, not hidden", async () => {
  const r = await withFakeExec(() => deckSays({ wasActive: true }), () => holdAwake());
  assert.equal(r.held, true);
  assert.equal(r.replaced, true);
  assert.match(r.summary, /earlier hold was already running and was replaced/);
});

test("an unreachable Deck is an honest failure, never a silent hold", async () => {
  const r = await withFakeExec(
    () => {
      throw Object.assign(new Error("ssh: connect to host ... port 22: Connection timed out"), { stdout: "" });
    },
    () => holdAwake(),
  );
  assert.equal(r.ok, false);
  assert.equal(r.held, false);
  assert.match(r.summary, /could not reach the Deck/);
});

// ---------------------------------------------------------------------------
// restorePowerSettings (release)
// ---------------------------------------------------------------------------

test("releasing with nothing held is a clean no-op, and says nothing was changed", async () => {
  const r = await withFakeExec(() => deckSays({ wasActive: false, listed: "" }), () => restorePowerSettings());
  assert.equal(r.ok, true);
  assert.equal(r.wasHeld, false);
  assert.equal(r.released, true);
  assert.match(r.summary, /nothing was holding this Deck awake/);
  assert.match(r.summary, /nothing to put back/);
});

test("a released hold is confirmed by the lock being gone from the list", async () => {
  const r = await withFakeExec(() => deckSays({ wasActive: true, listed: "" }), () => restorePowerSettings());
  assert.equal(r.ok, true);
  assert.equal(r.wasHeld, true);
  assert.equal(r.released, true);
  assert.match(r.summary, /sleeps normally again/);
});

test("a lock still listed after the stop is a failure, not a success", async () => {
  // The mirror of the hold case: releasing must not be reported from intent
  // either. A Deck that cannot sleep is a battery problem someone must know of.
  const r = await withFakeExec(() => deckSays({ wasActive: true }), () => restorePowerSettings());
  assert.equal(r.ok, false);
  assert.equal(r.released, false);
  assert.match(r.summary, /STILL held/);
});

test("releasing twice is safe -- the second call is the no-op branch", async () => {
  await withFakeExec(() => deckSays({ wasActive: true, listed: "" }), () => restorePowerSettings());
  const second = await withFakeExec(
    () => deckSays({ wasActive: false, listed: "" }),
    () => restorePowerSettings(),
  );
  assert.equal(second.ok, true);
  assert.equal(second.released, true);
});

// ---------------------------------------------------------------------------
// The v1 leftover
// ---------------------------------------------------------------------------

test("a v1 run file is reported and cleared, and its values are NOT pushed back", async () => {
  /*
   * v1 recorded an ABSENT IdleActionSec as 0, so "restoring" its snapshot is
   * precisely how Decks ended up carrying an explicit IdleActionSec=0 they
   * never had. Finding one must warn a human, not replay the corruption.
   */
  writeSnapshotFile("power-hold", { screenTimeoutSec: 0, suspendTimeoutSec: 0 }, 30, { note: "v1 hold" });
  assert.ok(fs.existsSync(snapshotPath("power-hold")));

  const sent: string[] = [];
  const r = await withFakeExec(
    (cmd) => {
      sent.push(cmd);
      return deckSays({});
    },
    () => holdAwake(),
  );

  assert.ok(r.legacy, "the leftover must be surfaced");
  assert.match(r.legacy!.warning, /NOT pushed back/);
  assert.match(r.summary, /logind\.conf/, "the human is told where to look");
  assert.equal(fs.existsSync(snapshotPath("power-hold")), false, "the landmine is cleared");
  assert.ok(
    !sent.some((c) => /IdleActionSec|xset/.test(c)),
    "no v1-era setting may be written to the Deck",
  );
});

test("with no v1 run file, nothing is invented", async () => {
  const r = await withFakeExec(() => deckSays({}), () => holdAwake());
  assert.equal(r.legacy, null);
  assert.ok(!/logind\.conf/.test(r.summary));
});
