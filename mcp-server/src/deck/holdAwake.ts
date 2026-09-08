/**
 * deck_holdAwake / deck_restorePowerSettings -- keep a Steam Deck awake for
 * the length of a QA run.
 *
 * QA runs involve a lot of waiting (slow replies, game launches, a person
 * reading results), and a Deck that falls asleep mid-run swallows presses and
 * empty-reads the rest, costing real time working out "did the Deck sleep"
 * versus "did the thing under test break".
 *
 * THIS IS THE SECOND IMPLEMENTATION. The first (plan 09, lane 1) wrote two
 * settings over SSH -- `xset` DPMS and systemd-logind's `IdleActionSec` -- and
 * held nothing at all. Measured on device 2026-09-08: this Deck's Xwayland
 * reports "Server does not have the DPMS Extension", so that half was a no-op
 * on every call, and Game Mode sleep is not governed by logind's idle action,
 * so the other half was the wrong knob even when written successfully. Worse,
 * its restore could not tell an ABSENT `IdleActionSec` from one set to `0`
 * (both read back as 0), so restoring a Deck that never had the line wrote an
 * explicit `IdleActionSec=0` that was never removed -- reporting
 * `restored: true` while leaving the machine changed.
 *
 * What actually works, measured the same day:
 *
 *   Steam suspends THROUGH logind rather than around it. Both of that day's
 *   automatic sleeps logged "systemd-logind: The system will suspend now!"
 *   with the Steam process making a D-Bus call at that instant, and
 *   NetworkManager, rtkit, UPower and cecd each running their `sleep` DELAY
 *   inhibitors. The call is SteamClient.System.SuspendPC(). Hold a BLOCK-mode
 *   `sleep` inhibitor and Steam is refused, and says so itself:
 *   "Error org.freedesktop.DBus.Error.AccessDenied: Access denied due to
 *   active block inhibitor".
 *
 * So this holds an inhibitor instead of writing settings, and that changes the
 * shape of the whole feature for the better. An inhibitor is a LEASE: nothing
 * is read and nothing is written, so there is no previous value to capture, no
 * file to restore, and no "absent versus 0" to get wrong. Every failure falls
 * toward the safe state on its own -- the unit dies, the host crashes, or the
 * TTL runs out, and the Deck sleeps again. There is no snapshot state machine
 * here at all (settingsSnapshot.ts still uses ./snapshotLease.ts, which is the
 * right tool for something that genuinely has old values to put back).
 *
 * THE DETAIL THAT DECIDES WHETHER THIS WORKS: the inhibitor must be held in
 * SYSTEM scope. /etc/systemd/logind.conf.d/killuserprocesses.conf on SteamOS
 * sets KillUserProcesses=True, so anything started from an SSH session is
 * killed the moment that session ends -- including a `setsid`-detached
 * process, which escapes the controlling terminal but NOT the systemd session
 * scope. The first run of the spike that produced this file did exactly that,
 * the lock was dead before the suspend arrived, and the Deck slept: a
 * clean-looking negative from a test that had silently stopped testing
 * anything. Hence `systemd-run --unit=`, which creates a system service that
 * outlives the SSH connection that asked for it.
 *
 * And because the lock is externally visible, the hold is VERIFIED rather than
 * asserted: `systemd-inhibit --list` is read back and the matching line is
 * returned as evidence. `held: true` means a lock was seen. That is the actual
 * repair for what made v1 dishonest -- it reported success for a hold it had
 * never taken.
 */
import { readDeckEnv } from "../config.js";
import { proc } from "../deploy/deployHelpers.js";
import { clearSnapshotFile, readSnapshotFile } from "./snapshotLease.js";

/** The transient system unit that owns the lock. One name, so a second hold
 * replaces the first rather than stacking anonymous locks nothing can find. */
export const HOLD_UNIT = "dps-hold-awake";

/** Marker at the front of the inhibitor's `why`, so the lock can be picked out
 * of `systemd-inhibit --list` without depending on that table's column widths. */
export const HOLD_MARKER = "DPS-HOLD-AWAKE";

export const RESTORE_POWER_TOOL_HINT = "deck_restorePowerSettings";

const DEFAULT_TTL_MINUTES = 30;
const MIN_TTL_MINUTES = 1;
/** Eight hours. A lease this long still self-releases, but past this it is
 * almost certainly a mistake rather than a run. */
const MAX_TTL_MINUTES = 480;

/** v1's snapshot kind, kept only so a leftover run file can be reported. */
const LEGACY_POWER_KIND = "power-hold";

const MARK_PRE = "---DPS-HOLD-PRE---";
const MARK_RUN = "---DPS-HOLD-RUN---";
const MARK_LIST = "---DPS-HOLD-LIST---";

function shellCmd(): string {
  return process.platform === "win32" ? "cmd.exe" : "/bin/sh";
}

function connectedEnv(): { user: string; host: string } {
  const env = readDeckEnv();
  const host = env.DECK_IP;
  if (!host) throw new Error("DECK_IP not configured — run deck_configure first");
  return { user: env.DECK_USER ?? "deck", host };
}

/**
 * The `why` string, reduced to characters that cannot end a shell quote or
 * start a new command. The note is caller-supplied and ends up inside a
 * single-quoted argument nested in a double-quoted ssh command, so it is
 * filtered rather than escaped -- the same posture as remotePluginDirName's
 * allowlist, and for the same reason.
 */
export function buildWhy(note?: string): string {
  const clean = (note ?? "").replace(/[^A-Za-z0-9 ._:/-]/g, "").trim().slice(0, 80);
  return clean ? `${HOLD_MARKER}: ${clean}` : HOLD_MARKER;
}

export function clampTtlMinutes(ttlMinutes?: number): number {
  const raw =
    typeof ttlMinutes === "number" && Number.isFinite(ttlMinutes) ? ttlMinutes : DEFAULT_TTL_MINUTES;
  return Math.min(MAX_TTL_MINUTES, Math.max(MIN_TTL_MINUTES, Math.floor(raw)));
}

/**
 * One round trip that reports the prior state, takes the lock, and reads the
 * lock back.
 *
 * `systemd-run` returns as soon as the unit is started, which is fractionally
 * before the inhibitor registers with logind, so the read is retried for a few
 * seconds rather than taken once and believed. A stale unit from a previous
 * run is stopped and reset first: `systemd-run` refuses a unit name that
 * already exists, and a failed leftover would otherwise make every later hold
 * fail for a reason that has nothing to do with this one.
 */
export function holdCommand(user: string, host: string, why: string, ttlSeconds: number): string {
  const remote =
    `echo ${MARK_PRE}; ` +
    `systemctl is-active ${HOLD_UNIT} 2>&1; ` +
    `echo ${MARK_RUN}; ` +
    `sudo -n systemctl stop ${HOLD_UNIT} 2>/dev/null; ` +
    `sudo -n systemctl reset-failed ${HOLD_UNIT} 2>/dev/null; ` +
    `sudo -n systemd-run --unit=${HOLD_UNIT} --service-type=simple ` +
    `systemd-inhibit --what=sleep --mode=block --why='${why}' sleep ${ttlSeconds} 2>&1; ` +
    `echo ${MARK_LIST}; ` +
    `for i in 1 2 3 4; do ` +
    `systemd-inhibit --list 2>/dev/null | grep -F '${HOLD_MARKER}' && break; ` +
    `sleep 1; ` +
    `done`;
  return `ssh -o BatchMode=yes -o ConnectTimeout=8 ${user}@${host} "${remote}"`;
}

/** Release, then read the list back so the release is verified too. */
export function releaseCommand(user: string, host: string): string {
  const remote =
    `echo ${MARK_PRE}; ` +
    `systemctl is-active ${HOLD_UNIT} 2>&1; ` +
    `echo ${MARK_RUN}; ` +
    `sudo -n systemctl stop ${HOLD_UNIT} 2>&1; ` +
    `sudo -n systemctl reset-failed ${HOLD_UNIT} 2>/dev/null; ` +
    `echo ${MARK_LIST}; ` +
    `systemd-inhibit --list 2>/dev/null | grep -F '${HOLD_MARKER}'`;
  return `ssh -o BatchMode=yes -o ConnectTimeout=8 ${user}@${host} "${remote}"`;
}

export interface HoldProbe {
  /** Was a hold already running before this call touched anything? */
  wasActive: boolean;
  /** Whatever `systemd-run` printed. Only interesting when the hold failed. */
  runOutput: string;
  /** The matching `systemd-inhibit --list` line, or null when no lock was seen. */
  evidence: string | null;
}

/**
 * Pure: split the three sections and decide, from the list read alone, whether
 * a lock is actually held. Deliberately does NOT fall back to "systemd-run
 * printed something that looked fine" -- that inference is what v1 did.
 */
export function parseHoldOutput(output: string): HoldProbe {
  const afterPre = output.split(MARK_PRE)[1] ?? "";
  const preSection = afterPre.split(MARK_RUN)[0] ?? "";
  const wasActive = preSection
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l === "active");

  const afterRun = output.split(MARK_RUN)[1] ?? "";
  const runOutput = (afterRun.split(MARK_LIST)[0] ?? "").trim();

  const listSection = output.split(MARK_LIST)[1] ?? "";
  const evidence =
    listSection
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.includes(HOLD_MARKER) && /\bblock\b/.test(l)) ?? null;

  return { wasActive, runOutput, evidence };
}

function runRemote(cmd: string): string {
  try {
    return String(
      proc.execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: shellCmd() }) ?? "",
    );
  } catch (err) {
    // `grep` exits non-zero when it matches nothing, which is a normal outcome
    // here (no lock held), so stdout is still the answer on a non-zero exit --
    // provided the command got far enough to print the list marker.
    const e = err as { stdout?: unknown; stderr?: unknown; message?: string };
    const out = String(e.stdout ?? "");
    if (out.includes(MARK_LIST)) return out;
    throw new Error(String(e.stderr ?? "").trim() || e.message || "ssh failed");
  }
}

export interface LegacyHoldFound {
  /** What v1 recorded as the pre-hold values. Its `0`s may mean "absent". */
  previous: unknown;
  takenAt: string | null;
  warning: string;
}

/**
 * v1 wrote a run file and could restore it wrongly. This reports one if it is
 * still lying around and clears it, but deliberately does NOT push those
 * values back to the Deck: v1 recorded an absent `IdleActionSec` as `0`, so
 * "restoring" it is how the corruption happened in the first place. Reporting
 * and standing back is the honest move; the file is cleared so it stops being
 * a landmine nothing will ever defuse.
 */
export function takeLegacySnapshot(): LegacyHoldFound | null {
  let envelope: { values?: unknown; takenAt?: string } | null;
  try {
    envelope = readSnapshotFile<unknown>(LEGACY_POWER_KIND) as { values?: unknown; takenAt?: string } | null;
  } catch {
    // A corrupt v1 file is still worth clearing and reporting.
    try {
      clearSnapshotFile(LEGACY_POWER_KIND);
    } catch {
      /* nothing to clear */
    }
    return {
      previous: null,
      takenAt: null,
      warning:
        "an unreadable run file from the previous deck_holdAwake implementation was found and cleared. " +
        "That version could write an IdleActionSec line that was never there -- check " +
        "/etc/systemd/logind.conf on the Deck by hand if it has an uncommented IdleActionSec.",
    };
  }
  if (!envelope) return null;
  try {
    clearSnapshotFile(LEGACY_POWER_KIND);
  } catch {
    /* best effort */
  }
  return {
    previous: envelope.values ?? null,
    takenAt: envelope.takenAt ?? null,
    warning:
      "a run file from the previous deck_holdAwake implementation was found and cleared. Its values were " +
      "NOT pushed back to the Deck on purpose: that version recorded an absent IdleActionSec as 0, so " +
      "restoring it is what left Decks carrying an explicit IdleActionSec=0 they never had. Check " +
      "/etc/systemd/logind.conf by hand.",
  };
}

export interface HoldAwakeOptions {
  ttlMinutes?: number;
  note?: string;
  /** Test-only clock override; production always uses Date.now. */
  now?: () => number;
}

export interface HoldAwakeResult {
  ok: boolean;
  /** True ONLY when a matching block lock was read back from the Deck. */
  held: boolean;
  unit: string;
  why: string;
  ttlMinutes: number;
  /** When the lease self-releases if nothing stops it first. */
  expiresAt: string | null;
  /** The `systemd-inhibit --list` line that proves the hold. */
  evidence: string | null;
  /** An earlier hold was running and was replaced by this one. */
  replaced: boolean;
  legacy: LegacyHoldFound | null;
  reason?: string;
  summary: string;
}

export async function holdAwake(opts: HoldAwakeOptions = {}): Promise<HoldAwakeResult> {
  const ttlMinutes = clampTtlMinutes(opts.ttlMinutes);
  const why = buildWhy(opts.note);
  const now = opts.now ?? Date.now;
  const legacy = takeLegacySnapshot();

  const base: HoldAwakeResult = {
    ok: false,
    held: false,
    unit: HOLD_UNIT,
    why,
    ttlMinutes,
    expiresAt: null,
    evidence: null,
    replaced: false,
    legacy,
    summary: "",
  };

  let output: string;
  try {
    const { user, host } = connectedEnv();
    output = runRemote(holdCommand(user, host, why, ttlMinutes * 60));
  } catch (err) {
    const reason = (err as Error).message;
    return { ...base, reason, summary: `could not reach the Deck to take a wake lock: ${reason}` };
  }

  const probe = parseHoldOutput(output);
  if (!probe.evidence) {
    // The lock is not listed, so nothing is held -- whatever systemd-run said.
    const detail = probe.runOutput ? ` systemd-run said: ${probe.runOutput}` : "";
    return {
      ...base,
      replaced: probe.wasActive,
      reason: `no matching block inhibitor is listed on the Deck after starting ${HOLD_UNIT}.${detail}`,
      summary:
        `NOT holding this Deck awake: the lock was requested but ${HOLD_UNIT} does not appear in ` +
        `systemd-inhibit --list, so the Deck can still sleep mid-run.${detail}`,
    };
  }

  const expiresAt = new Date(now() + ttlMinutes * 60_000).toISOString();
  return {
    ...base,
    ok: true,
    held: true,
    expiresAt,
    evidence: probe.evidence,
    replaced: probe.wasActive,
    summary:
      `holding this Deck awake with a logind block inhibitor (${HOLD_UNIT}), verified present in ` +
      `systemd-inhibit --list. Steam's own suspend is refused while it is held. It self-releases at ` +
      `${expiresAt} (${ttlMinutes} min) if ${RESTORE_POWER_TOOL_HINT} is never called, and nothing on ` +
      `the Deck is modified either way -- a lease, not a setting.` +
      (probe.wasActive ? " An earlier hold was already running and was replaced." : "") +
      (legacy ? ` NOTE: ${legacy.warning}` : ""),
  };
}

export interface RestorePowerResult {
  ok: boolean;
  /** Was a hold actually running when this was called? */
  wasHeld: boolean;
  /** True when no matching lock remains -- read back, not assumed. */
  released: boolean;
  unit: string;
  evidence: string | null;
  legacy: LegacyHoldFound | null;
  reason?: string;
  summary: string;
}

/**
 * Release the lease. Safe to call when nothing is held (a clean no-op, not an
 * error) and safe to call twice. Named `restorePowerSettings` for continuity
 * with v1's tool name, which a live consumer already calls -- there is no
 * longer anything to restore, and the summary says so rather than implying
 * settings were put back.
 */
export async function restorePowerSettings(): Promise<RestorePowerResult> {
  const legacy = takeLegacySnapshot();
  const base: RestorePowerResult = {
    ok: false,
    wasHeld: false,
    released: false,
    unit: HOLD_UNIT,
    evidence: null,
    legacy,
    summary: "",
  };

  let output: string;
  try {
    const { user, host } = connectedEnv();
    output = runRemote(releaseCommand(user, host));
  } catch (err) {
    const reason = (err as Error).message;
    return { ...base, reason, summary: `could not reach the Deck to release the wake lock: ${reason}` };
  }

  const probe = parseHoldOutput(output);
  const released = probe.evidence === null;
  const legacyNote = legacy ? ` NOTE: ${legacy.warning}` : "";

  if (!released) {
    return {
      ...base,
      wasHeld: probe.wasActive,
      evidence: probe.evidence,
      reason: `a matching block inhibitor is still listed after stopping ${HOLD_UNIT}`,
      summary:
        `the wake lock is STILL held after asking ${HOLD_UNIT} to stop -- this Deck will not sleep. ` +
        `Listed: ${probe.evidence}${legacyNote}`,
    };
  }

  return {
    ...base,
    ok: true,
    wasHeld: probe.wasActive,
    released: true,
    summary:
      (probe.wasActive
        ? "wake lock released; this Deck sleeps normally again. "
        : "nothing was holding this Deck awake, so there was nothing to release. ") +
      `No settings were changed by the hold, so there is nothing to put back.${legacyNote}`,
  };
}
