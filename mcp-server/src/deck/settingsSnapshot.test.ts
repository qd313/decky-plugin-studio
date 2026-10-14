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
import { execSync as realExecSync, spawn } from "node:child_process";

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
  streamProc,
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

// ---------------------------------------------------------------------------
// A big settings folder (saved chats) must never fail for output size.
//
// 2026-10-11: deck_snapshotSettings died with `spawnSync cmd.exe ENOBUFS` on a
// ~72 MB folder. The tar is base64-encoded for the buffered path, so 72 MB of
// tar is ~96 MB of text, past the 64 MB maxBuffer of the one execSync call that
// reads it. These tests use the REAL child_process behind the fake seam so the
// overflow is node's own, not a pretend one.
// ---------------------------------------------------------------------------

const STANDIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dps-settingssnap-standin-"));
after(() => fs.rmSync(STANDIN_DIR, { recursive: true, force: true }));

/** A stand-in for `ssh deck@host "<remote script>"`: for a tar-out script it
 * writes `bytes` of deterministic data to stdout; for a tar-in script it copies
 * stdin to a capture file. The last argument lets a case simulate a dropped
 * link (ssh itself exits 255). */
const STANDIN_SCRIPT = path.join(STANDIN_DIR, "fake-ssh.js");
fs.writeFileSync(
  STANDIN_SCRIPT,
  [
    'const fs = require("fs");',
    "const [mode, arg, exitCode, claimSize, claimSha] = process.argv.slice(2);",
    'if (mode === "out") {',
    "  const total = Number(arg);",
    "  let sent = 0;",
    "  const chunk = Buffer.alloc(64 * 1024);",
    "  (function pump() {",
    "    while (sent < total) {",
    "      const n = Math.min(chunk.length, total - sent);",
    "      for (let i = 0; i < n; i++) chunk[i] = (sent + i) % 251;",
    "      sent += n;",
    '      if (!process.stdout.write(Buffer.from(chunk.subarray(0, n)))) return process.stdout.once("drain", pump);',
    "    }",
    // What the Deck's own side says it sent (see verifiedTarOutScript). Absent: no trailer at all.
    "    if (claimSize) process.stderr.write('DECKSUM size=' + claimSize + ' sha=' + claimSha + '\\n');",
    "    process.stdout.end(() => process.exit(Number(exitCode || 0)));",
    "  })();",
    "} else {",
    "  const out = fs.createWriteStream(arg);",
    "  process.stdin.pipe(out);",
    '  out.on("finish", () => process.exit(Number(exitCode || 0)));',
    "}",
    "",
  ].join("\n")
);

function expectedStandinSha(total: number): string {
  const h = crypto.createHash("sha256");
  const chunk = Buffer.alloc(64 * 1024);
  let sent = 0;
  while (sent < total) {
    const n = Math.min(chunk.length, total - sent);
    for (let i = 0; i < n; i++) chunk[i] = (sent + i) % 251;
    h.update(chunk.subarray(0, n));
    sent += n;
  }
  return h.digest("hex");
}

/** Points the streamed-copy seam at the stand-in and records the remote script
 * each launch was asked to run. */
function withStandinSsh(opts: {
  tarBytes?: number;
  captureFile?: string;
  exitCode?: number;
  /** What the Deck says it sent, when that differs from what arrived (a stream that ended early). */
  claimedBytes?: number;
  /** The Deck sends no size-and-checksum line at all. */
  noTrailer?: boolean;
  /** Per launch (0-based), overrides for the bytes that arrive and the bytes the Deck claims. */
  perLaunch?: (n: number) => { tarBytes: number; claimedBytes?: number };
}): {
  scripts: string[];
  restore: () => void;
} {
  const scripts: string[] = [];
  // Written so that code without the streamed copy (no seam) still reaches its own
  // real ENOBUFS in the tests below, instead of dying on a missing import.
  const seam = streamProc as typeof streamProc | undefined;
  if (!seam) return { scripts, restore: () => {} };
  const original = seam.launch;
  seam.launch = ((args: string[]) => {
    const remote = args[args.length - 1];
    const launchNo = scripts.length;
    scripts.push(remote);
    const pullingOut = remote.includes("tar cf -");
    const per = opts.perLaunch?.(launchNo);
    const sent = per?.tarBytes ?? opts.tarBytes ?? 0;
    const claimed = per?.claimedBytes ?? opts.claimedBytes ?? sent;
    return spawn(
      process.execPath,
      pullingOut
        ? [
            STANDIN_SCRIPT, "out", String(sent), String(opts.exitCode ?? 0),
            ...(opts.noTrailer ? [] : [String(claimed), expectedStandinSha(claimed)]),
          ]
        : [STANDIN_SCRIPT, "in", String(opts.captureFile), String(opts.exitCode ?? 0)],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );
  }) as typeof seam.launch;
  return { scripts, restore: () => (seam.launch = original) };
}

/** Runs the REAL execSync, but swaps the remote command for a local one that
 * prints a chosen amount of text, under the REAL options (maxBuffer, shell) the
 * production call passed. So an oversized reply fails exactly as it did on the
 * maintainer's PC: spawnSync <shell> ENOBUFS. */
function realBufferedExecPrinting(outputBytes: (maxBuffer: number) => number): typeof proc.execSync {
  return ((_cmd: string, opts: { maxBuffer: number } & Record<string, unknown>) => {
    const n = outputBytes(opts.maxBuffer);
    return realExecSync(`node -e "process.stdout.write('A'.repeat(${n}))"`, opts as never);
  }) as unknown as typeof proc.execSync;
}

test("a settings folder too big for the buffered copy is streamed instead of failing with ENOBUFS", async () => {
  const TAR_BYTES = 24 * 1024 * 1024;
  const original = proc.execSync;
  // The buffered attempt gets a reply one byte over whatever limit it asked for.
  proc.execSync = realBufferedExecPrinting((maxBuffer) => maxBuffer + 1);
  const standin = withStandinSsh({ tarBytes: TAR_BYTES });
  try {
    const result = await snapshotSettings();

    assert.equal(result.method, "streamed");
    assert.match(result.methodNote, /streamed/i);
    assert.match(result.summary, /streamed/i);
    assert.equal(result.previous.method, "streamed");
    assert.equal(result.previous.sizeBytes, TAR_BYTES);
    assert.equal(result.previous.sha256, expectedStandinSha(TAR_BYTES));

    const onDisk = fs.statSync(result.previous.archivePath);
    assert.equal(onDisk.size, TAR_BYTES, "the whole archive must be on disk, not a truncated copy");
    assert.equal(standin.scripts.length, 1);
    assert.doesNotMatch(standin.scripts[0], /base64/, "the streamed copy sends raw tar, no base64 inflation");
    assert.ok(fs.existsSync(snapshotPath("settings-hold")), "the run file is written, so restore can find it");
  } finally {
    standin.restore();
    proc.execSync = original;
  }
});

test("a small settings folder is still copied the buffered way, and the result says so", async () => {
  const { result } = await withFakeExec(() => FAKE_TAR_B64, () => snapshotSettings());
  assert.equal(result.method, "buffered");
  assert.equal(typeof result.methodNote, "string");
  assert.ok(result.methodNote.length > 0);
  assert.equal(result.previous.method, "buffered");
  // Existing fields that bonsAI's drivers read stay where they were.
  assert.equal(result.previous.sizeBytes, FAKE_TAR_BYTES.length);
  assert.ok(result.path && result.expiresAt && result.summary);
});

test("restoreSettings puts a streamed snapshot back: raw tar over a stream, checksum verified, nothing buffered", async () => {
  const TAR_BYTES = 20 * 1024 * 1024;
  const capture = path.join(STANDIN_DIR, "pushed.tar");
  fs.rmSync(capture, { force: true });
  const original = proc.execSync;
  proc.execSync = realBufferedExecPrinting((maxBuffer) => maxBuffer + 1);
  const takeStandin = withStandinSsh({ tarBytes: TAR_BYTES });
  let taken: Awaited<ReturnType<typeof snapshotSettings>>;
  try {
    taken = await snapshotSettings();
  } finally {
    takeStandin.restore();
  }
  assert.equal(taken.method, "streamed");

  // From here the buffered seam must not be touched at all.
  const calls: string[] = [];
  proc.execSync = ((cmd: string) => {
    calls.push(cmd);
    return "";
  }) as unknown as typeof proc.execSync;
  const pushStandin = withStandinSsh({ captureFile: capture });
  try {
    const restored = await restoreSettings();
    assert.equal(restored.restored, true);
  } finally {
    pushStandin.restore();
    proc.execSync = original;
  }

  assert.equal(calls.length, 0, "a streamed snapshot is restored by streaming, not through the buffered seam");
  assert.equal(pushStandin.scripts.length, 1);
  assert.match(pushStandin.scripts[0], /tar xf -/);
  assert.doesNotMatch(pushStandin.scripts[0], /base64/);
  assert.match(pushStandin.scripts[0], /rm -rf ~\/'homebrew\/settings\/bonsAI'/);
  const sent = fs.readFileSync(capture);
  assert.equal(sent.length, TAR_BYTES);
  assert.equal(crypto.createHash("sha256").update(sent).digest("hex"), expectedStandinSha(TAR_BYTES));
  assert.equal(fs.existsSync(taken.previous.archivePath), false, "the archive is removed after a good restore");
  assert.equal(fs.existsSync(snapshotPath("settings-hold")), false);
});

test("a streamed copy that dies (ssh exit 255) fails loudly and leaves no run file or half archive", async () => {
  const archiveDir = path.join(path.dirname(snapshotPath("settings-hold")), "settings-archives");
  const listing = () => (fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).sort() : []);
  const before = listing();
  const original = proc.execSync;
  proc.execSync = realBufferedExecPrinting((maxBuffer) => maxBuffer + 1);
  const standin = withStandinSsh({ tarBytes: 3 * 1024 * 1024, exitCode: 255 });
  try {
    await assert.rejects(() => snapshotSettings(), /255|ssh/i);
  } finally {
    standin.restore();
    proc.execSync = original;
  }
  assert.equal(fs.existsSync(snapshotPath("settings-hold")), false, "no run file for a copy that never completed");
  assert.deepEqual(listing(), before, "a half-written archive must be cleaned up");
});

test("a buffered failure that is NOT an overflow is still an error, with no silent second attempt", async () => {
  const standin = withStandinSsh({ tarBytes: 10 });
  try {
    await assert.rejects(
      () =>
        withFakeExec(() => {
          throw new Error("ssh: connect to host 203.0.113.9 port 22: Connection timed out");
        }, () => snapshotSettings()),
      /timed out/
    );
    assert.equal(standin.scripts.length, 0, "an unreachable Deck must not trigger a second attempt");
  } finally {
    standin.restore();
  }
});

// ---------------------------------------------------------------------------
// The saved copy is checked against the Deck's own word before it is called good
// (plan 92, 2026-10-12: the third of three snapshots of a 228 MB folder said
// "streamed", returned no error, and was 102,400 bytes short and damaged -- it
// could not be restored). The Deck side now reports the size and checksum of
// what it sent; a copy that does not match is an error, not "streamed".
// ---------------------------------------------------------------------------

test("a streamed copy that ends early is an error naming both sizes, not 'streamed', and leaves nothing behind", async () => {
  const SENT = 24 * 1024 * 1024;
  const SHORT_BY = 102_400; // the number from the Deck night
  const archiveDir = path.join(path.dirname(snapshotPath("settings-hold")), "settings-archives");
  const listing = () => (fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).sort() : []);
  const before = listing();
  const original = proc.execSync;
  proc.execSync = realBufferedExecPrinting((maxBuffer) => maxBuffer + 1);
  // ssh itself exits 0 and every byte that arrived is a byte written: only the Deck's own count shows the gap.
  const standin = withStandinSsh({ tarBytes: SENT - SHORT_BY, claimedBytes: SENT });
  try {
    await assert.rejects(
      () => snapshotSettings(),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(msg, new RegExp(String(SENT)), "the Deck's size is in the message");
        assert.match(msg, new RegExp(String(SENT - SHORT_BY)), "the size that arrived is in the message");
        assert.match(msg, /not (whole|complete)|incomplete|short/i);
        assert.doesNotMatch(msg, /^streamed/i);
        return true;
      }
    );
  } finally {
    standin.restore();
    proc.execSync = original;
  }
  assert.equal(fs.existsSync(snapshotPath("settings-hold")), false, "no run file for a copy that did not match");
  assert.deepEqual(listing(), before, "the damaged copy is not kept");
});

test("a copy whose bytes differ at the same length is caught by the checksum", async () => {
  const TAR_BYTES = 3 * 1024 * 1024;
  const original = proc.execSync;
  proc.execSync = realBufferedExecPrinting((maxBuffer) => maxBuffer + 1);
  // The Deck claims the same size, but a different checksum than what arrived.
  const seam = streamProc;
  const real = seam.launch;
  seam.launch = ((args: string[]) =>
    spawn(
      process.execPath,
      [STANDIN_SCRIPT, "out", String(TAR_BYTES), "0", String(TAR_BYTES), "0".repeat(64)],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    )) as typeof seam.launch;
  try {
    await assert.rejects(() => snapshotSettings(), /checksum/i);
  } finally {
    seam.launch = real;
    proc.execSync = original;
  }
  assert.equal(fs.existsSync(snapshotPath("settings-hold")), false);
});

test("a streamed copy that the Deck never vouched for (no size-and-checksum line) is an error", async () => {
  const original = proc.execSync;
  proc.execSync = realBufferedExecPrinting((maxBuffer) => maxBuffer + 1);
  const standin = withStandinSsh({ tarBytes: 2 * 1024 * 1024, noTrailer: true });
  try {
    await assert.rejects(() => snapshotSettings(), /could not be checked|did not (report|say)|no size/i);
  } finally {
    standin.restore();
    proc.execSync = original;
  }
  assert.equal(fs.existsSync(snapshotPath("settings-hold")), false);
});

test("a short copy is taken again once; if the second is whole the result is good and says it was retried", async () => {
  const GOOD = 5 * 1024 * 1024;
  const original = proc.execSync;
  proc.execSync = realBufferedExecPrinting((maxBuffer) => maxBuffer + 1);
  const standin = withStandinSsh({
    perLaunch: (n) => (n === 0 ? { tarBytes: GOOD - 102_400, claimedBytes: GOOD } : { tarBytes: GOOD }),
  });
  try {
    const result = await snapshotSettings();
    assert.equal(result.method, "streamed");
    assert.equal(result.previous.sizeBytes, GOOD);
    assert.equal(result.previous.sha256, expectedStandinSha(GOOD));
    assert.equal(fs.statSync(result.previous.archivePath).size, GOOD);
    assert.equal(standin.scripts.length, 2, "exactly one retry");
    assert.match(result.methodNote, /again|retr/i, "the retry is recorded in the result");
  } finally {
    standin.restore();
    proc.execSync = original;
  }
});

test("a short copy twice in a row is an error that names both attempts", async () => {
  const SENT = 4 * 1024 * 1024;
  const original = proc.execSync;
  proc.execSync = realBufferedExecPrinting((maxBuffer) => maxBuffer + 1);
  const standin = withStandinSsh({ tarBytes: SENT - 102_400, claimedBytes: SENT });
  try {
    await assert.rejects(
      () => snapshotSettings(),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(msg, /either of two tries/);
        assert.match(msg, /First try:.*Second try:/);
        assert.match(msg, new RegExp(String(SENT)));
        return true;
      }
    );
    assert.equal(standin.scripts.length, 2);
  } finally {
    standin.restore();
    proc.execSync = original;
  }
});

test("the streamed copy asks the Deck for its own size and checksum in the same pass", async () => {
  const original = proc.execSync;
  proc.execSync = realBufferedExecPrinting((maxBuffer) => maxBuffer + 1);
  const standin = withStandinSsh({ tarBytes: 1024 * 1024 });
  try {
    await snapshotSettings();
    assert.match(standin.scripts[0], /sha256sum/);
    assert.match(standin.scripts[0], /wc -c/);
    assert.match(standin.scripts[0], /DECKSUM/);
    assert.match(standin.scripts[0], /tar cf -/);
  } finally {
    standin.restore();
    proc.execSync = original;
  }
});
