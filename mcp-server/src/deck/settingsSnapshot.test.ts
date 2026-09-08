/**
 * Tests for deck_snapshotSettings / deck_restoreSettings.
 *
 * THE EXEC LAYER IS FAKED. proc.execSync (deploy/deployHelpers.ts) is the seam
 * every ssh/scp call in this codebase goes through; tests replace it for the
 * duration of a case, exactly as deckDeploy.test.ts does. No network, no
 * hardware, ever -- the "tar archive" pulled off "the Deck" in these tests is
 * a plain in-memory buffer the fake hands back as base64 text.
 *
 * THE RUN-FILE / WORKSPACE DIRECTORIES ARE REDIRECTED, same tricks
 * killswitch.test.ts and deckDeploy.test.ts use: getConfigDir() derives from
 * os.homedir() and detectPlugin() from DECKY_STUDIO_WORKSPACE, both read at
 * call time.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const realEnv = {
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
  DECK_IP: process.env.DECK_IP,
  DECK_USER: process.env.DECK_USER,
  WORKSPACE: process.env.DECKY_STUDIO_WORKSPACE,
};
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dps-settingssnap-home-"));
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
process.env.DECK_IP = "203.0.113.9";
process.env.DECK_USER = "deck";

const { proc } = await import("../deploy/deployHelpers.js");
const { snapshotPath, CorruptSnapshotError, StaleSnapshotError } = await import("./snapshotLease.js");
const {
  snapshotSettings,
  restoreSettings,
  pullSettingsCommand,
  pushSettingsCommand,
  RESTORE_SETTINGS_TOOL_HINT,
} = await import("./settingsSnapshot.js");

function makeFixturePlugin(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dps-settingssnap-plugin-"));
  fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ name, version: "1.0.0" }));
  return root;
}

let pluginRoot = makeFixturePlugin("bonsAI");
process.env.DECKY_STUDIO_WORKSPACE = pluginRoot;

function assertSandboxed(): void {
  assert.ok(
    snapshotPath("sandbox-check").startsWith(tempHome),
    `run file escaped the sandbox: ${snapshotPath("sandbox-check")} is not under ${tempHome}`
  );
}

before(() => assertSandboxed());
beforeEach(() => {
  assertSandboxed();
  fs.rmSync(snapshotPath("settings-hold"), { force: true });
});
after(() => {
  process.env.USERPROFILE = realEnv.USERPROFILE;
  process.env.HOME = realEnv.HOME;
  process.env.DECK_IP = realEnv.DECK_IP;
  process.env.DECK_USER = realEnv.DECK_USER;
  process.env.DECKY_STUDIO_WORKSPACE = realEnv.WORKSPACE;
  fs.rmSync(tempHome, { recursive: true, force: true });
  fs.rmSync(pluginRoot, { recursive: true, force: true });
});

interface FakeCall {
  cmd: string;
  input?: string;
}

/** Swaps proc.execSync for the duration of `fn`, capturing both the command
 * and any stdin `input` (the push path sends the archive that way), always
 * restoring the real function after. */
async function withFakeExec<T>(
  impl: (cmd: string, input?: string) => string,
  fn: () => Promise<T> | T
): Promise<{ result: T; calls: FakeCall[] }> {
  const calls: FakeCall[] = [];
  const original = proc.execSync;
  proc.execSync = ((cmd: string, opts?: { input?: string }) => {
    calls.push({ cmd, input: opts?.input });
    return impl(cmd, opts?.input);
  }) as unknown as typeof proc.execSync;
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    proc.execSync = original;
  }
}

const FAKE_TAR_BYTES = Buffer.from("FAKE-TAR-CONTENTS-not-a-real-archive");
const FAKE_TAR_B64 = FAKE_TAR_BYTES.toString("base64");

// ---------------------------------------------------------------------------
// Command shape (pure functions)
// ---------------------------------------------------------------------------

test("pullSettingsCommand tars settings only by default, both dirs when includeData is true", () => {
  const settingsOnly = pullSettingsCommand("deck", "203.0.113.9", "bonsAI", false);
  assert.match(settingsOnly, /^ssh .*deck@203\.0\.113\.9 "/);
  assert.match(settingsOnly, /tar cf -/);
  assert.match(settingsOnly, /settings\/bonsAI/);
  assert.doesNotMatch(settingsOnly, /data\/bonsAI/);
  assert.match(settingsOnly, /base64 -w0/);

  const both = pullSettingsCommand("deck", "203.0.113.9", "bonsAI", true);
  assert.match(both, /settings\/bonsAI/);
  assert.match(both, /data\/bonsAI/);
});

test("pushSettingsCommand stages into a temp dir and only removes/replaces the given remote dirs", () => {
  const cmd = pushSettingsCommand(
    "deck",
    "203.0.113.9",
    ["~/homebrew/settings/bonsAI"],
    "/tmp/decky-studio-settings-restore-123"
  );
  assert.match(cmd, /base64 -d \| tar xf -/);
  assert.match(cmd, /decky-studio-settings-restore-123/);
  assert.match(cmd, /rm -rf ~\/'homebrew\/settings\/bonsAI'/);
  assert.match(cmd, /mv '\/tmp\/decky-studio-settings-restore-123\/settings\/bonsAI'/);
  // The staging extract must happen before anything real is removed.
  assert.ok(cmd.indexOf("tar xf -") < cmd.indexOf("rm -rf ~"), "extract must run before the live dir is touched");
});

// ---------------------------------------------------------------------------
// snapshotSettings: captures before anything changes, refuses a stale hold
// ---------------------------------------------------------------------------

test("snapshotSettings pulls the settings dir into a local archive, hashed and recorded in the run file", async () => {
  const { result } = await withFakeExec((cmd) => {
    assert.doesNotMatch(cmd, /data\/bonsAI/, "data dir must not be requested when includeData is false");
    return FAKE_TAR_B64;
  }, () => snapshotSettings());

  assert.equal(result.previous.pluginName, "bonsAI");
  assert.equal(result.previous.remoteSettingsDir, "~/homebrew/settings/bonsAI");
  assert.equal(result.previous.remoteDataDir, null);
  assert.equal(result.previous.sizeBytes, FAKE_TAR_BYTES.length);
  assert.equal(result.previous.sha256, crypto.createHash("sha256").update(FAKE_TAR_BYTES).digest("hex"));

  const onDisk = fs.readFileSync(result.previous.archivePath);
  assert.deepEqual(onDisk, FAKE_TAR_BYTES);

  const envelope = JSON.parse(fs.readFileSync(snapshotPath("settings-hold"), "utf8"));
  assert.equal(envelope.values.archivePath, result.previous.archivePath);
});

test("snapshotSettings(includeData: true) also pulls and records the data directory", async () => {
  const { result } = await withFakeExec(() => FAKE_TAR_B64, () => snapshotSettings({ includeData: true }));
  assert.equal(result.previous.remoteDataDir, "~/homebrew/data/bonsAI");
});

test("a second snapshotSettings over an unrestored one is refused, naming deck_restoreSettings", async () => {
  await withFakeExec(() => FAKE_TAR_B64, () => snapshotSettings());

  await assert.rejects(
    () => withFakeExec(() => FAKE_TAR_B64, () => snapshotSettings()),
    (err: unknown) => {
      assert.ok(err instanceof StaleSnapshotError);
      assert.match((err as Error).message, new RegExp(RESTORE_SETTINGS_TOOL_HINT));
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// restoreSettings: safe no-op, idempotent, verifies before pushing
// ---------------------------------------------------------------------------

test("restoreSettings with nothing snapshotted is a clean no-op and sends nothing to the Deck", async () => {
  const { result, calls } = await withFakeExec(() => "", () => restoreSettings());
  assert.equal(result.ok, true);
  assert.equal(result.restored, false);
  assert.equal(calls.length, 0);
});

test("restoreSettings pushes back exactly the captured bytes (verified by checksum) and is idempotent", async () => {
  const { result: taken } = await withFakeExec(() => FAKE_TAR_B64, () => snapshotSettings());
  const archivePath = taken.previous.archivePath;

  const { result: first, calls: firstCalls } = await withFakeExec(() => "", () => restoreSettings());
  assert.equal(first.restored, true);
  assert.deepEqual(first.values?.remoteSettingsDir, "~/homebrew/settings/bonsAI");

  const pushCall = firstCalls.find((c) => c.cmd.includes("tar xf -"));
  assert.ok(pushCall, `expected a push command among: ${JSON.stringify(firstCalls.map((c) => c.cmd))}`);
  assert.equal(pushCall!.input, FAKE_TAR_B64, "the exact captured bytes must be sent back, unmodified");
  assert.match(pushCall!.cmd, /rm -rf ~\/'homebrew\/settings\/bonsAI'/);

  // The archive is cleaned up after a successful restore.
  assert.equal(fs.existsSync(archivePath), false);
  assert.equal(fs.existsSync(snapshotPath("settings-hold")), false);

  const { result: second, calls: secondCalls } = await withFakeExec(() => "", () => restoreSettings());
  assert.equal(second.restored, false);
  assert.equal(secondCalls.length, 0, "a second restore must not touch the Deck at all");
});

test("a tampered archive is detected by checksum BEFORE anything is pushed to the Deck", async () => {
  const { result: taken } = await withFakeExec(() => FAKE_TAR_B64, () => snapshotSettings());
  // Simulate corruption: the archive file on disk no longer matches the hash
  // recorded in the run file when it was taken.
  fs.writeFileSync(taken.previous.archivePath, Buffer.from("something else entirely"));

  const calls: FakeCall[] = [];
  const original = proc.execSync;
  proc.execSync = ((cmd: string, opts?: { input?: string }) => {
    calls.push({ cmd, input: opts?.input });
    return "";
  }) as unknown as typeof proc.execSync;
  try {
    await assert.rejects(() => restoreSettings(), /checksum/i);
  } finally {
    proc.execSync = original;
  }

  assert.equal(calls.length, 0, "nothing should be sent to the Deck once the checksum fails locally");
  // The run file must still be there -- a failed, refused restore is not a
  // successful one, and must not be silently cleared.
  assert.equal(fs.existsSync(snapshotPath("settings-hold")), true);
});

// ---------------------------------------------------------------------------
// A partially-written run file is detected, never trusted
// ---------------------------------------------------------------------------

test("a corrupt settings-hold run file is detected, not silently treated as absent", async () => {
  fs.mkdirSync(path.dirname(snapshotPath("settings-hold")), { recursive: true });
  fs.writeFileSync(snapshotPath("settings-hold"), "{ not json", "utf8");

  await assert.rejects(() => withFakeExec(() => FAKE_TAR_B64, () => snapshotSettings()), CorruptSnapshotError);
  await assert.rejects(() => withFakeExec(() => "", () => restoreSettings()), CorruptSnapshotError);
});

// ---------------------------------------------------------------------------
// Expiry restores the original settings archive automatically
// ---------------------------------------------------------------------------

test("an expired settings snapshot is auto-restored onto the Deck the next time snapshotSettings runs", async () => {
  let clock = 1_700_000_000_000;
  const now = () => clock;

  const { result: taken } = await withFakeExec(
    () => FAKE_TAR_B64,
    () => snapshotSettings({ ttlMinutes: 1, now })
  );

  clock += 5 * 60_000; // well past the 1-minute lease

  const { result: second, calls } = await withFakeExec(() => FAKE_TAR_B64, () =>
    snapshotSettings({ ttlMinutes: 1, now })
  );

  assert.ok(second.autoRestoredExpired, "the expired settings snapshot was not auto-restored");
  assert.equal(second.autoRestoredExpired!.values.archivePath, taken.previous.archivePath);

  const pushCall = calls.find((c) => c.cmd.includes("tar xf -"));
  assert.ok(pushCall, "expected the expired snapshot's archive to be pushed back automatically");
  assert.equal(pushCall!.input, FAKE_TAR_B64, "the auto-restore must push the ORIGINAL captured bytes");
});
