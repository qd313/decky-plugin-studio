/**
 * deck_holdAwake / deck_restorePowerSettings.
 *
 * QA runs involve a lot of waiting -- slow replies, game launches, a person
 * reading results -- and a Deck that falls asleep mid-run swallows presses and
 * empty-reads the rest, costing real time working out "did the Deck sleep" vs
 * "did the thing under test break". This holds the screen and suspend
 * timeouts off for the run and puts them back exactly, using the shared
 * snapshot/lease machinery in ./snapshotLease.ts for the safety rules (refuse
 * a stale hold, expire towards sleep, detect a corrupt run file).
 *
 * UNVERIFIED ON HARDWARE. The two settings targeted here -- DPMS via `xset`
 * against the Gamescope session's Xwayland compatibility socket, and
 * systemd-logind's IdleActionSec -- are the standard Linux primitives for
 * "screen blanking" and "idle suspend", and the only ones reachable read/write
 * over a plain SSH shell without a private Steam-internal API. Nothing in
 * this codebase has yet confirmed, on a real Deck, that toggling these two
 * actually stops Game Mode from sleeping, nor that XWAYLAND_DISPLAY below is
 * the right socket. See this lane's report for the full honesty note; the
 * on-device pass in the roadmap's phase 2 is what settles it.
 */
import { readDeckEnv } from "../config.js";
import { proc } from "../deploy/deployHelpers.js";
import {
  RestoreReport,
  SnapshotController,
  TakeReport,
  restoreSnapshot,
  takeSnapshot,
} from "./snapshotLease.js";

export interface PowerValues {
  /** DPMS standby/suspend/off timeout in seconds, as `xset q` reports it. 0 = disabled. */
  screenTimeoutSec: number;
  /** systemd-logind IdleActionSec, in seconds, from /etc/systemd/logind.conf. 0 = disabled/absent. */
  suspendTimeoutSec: number;
}

const POWER_KIND = "power-hold";
export const RESTORE_POWER_TOOL_HINT = "deck_restorePowerSettings";
const DEFAULT_TTL_MINUTES = 30;

/** Best guess at the Gamescope session's Xwayland compatibility display.
 * Unverified -- see the module header. Kept as one constant so a device pass
 * that finds a different value has exactly one line to change. */
const XWAYLAND_DISPLAY = ":1";

/** Splits the DPMS read from the logind read in one ssh round trip, the same
 * shape deployHelpers' loader-readiness probe uses and for the same reason:
 * two round trips double the latency and double the chance one times out
 * while the other succeeds. */
export const POWER_READ_MARK = "---DPS-SUSPEND---";

export function readPowerCommand(user: string, host: string): string {
  const remote =
    `DISPLAY=${XWAYLAND_DISPLAY} xset q 2>/dev/null | grep -oE 'Standby: [0-9]+' | grep -oE '[0-9]+'; ` +
    `echo ${POWER_READ_MARK}; ` +
    "grep -E '^\\s*IdleActionSec=' /etc/systemd/logind.conf 2>/dev/null | tail -1";
  return `ssh -o BatchMode=yes -o ConnectTimeout=8 ${user}@${host} "${remote}"`;
}

/** Pure: the read command's output, split into its two facts. Anything
 * unparseable reads as disabled (0) rather than throwing -- an unreadable
 * value is not evidence the Deck differs from a fresh install, where these
 * are typically unset. */
export function parsePowerRead(output: string): PowerValues {
  const [head, tail = ""] = output.split(POWER_READ_MARK);
  const screenLine = head
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  const screenTimeoutSec = screenLine && /^\d+$/.test(screenLine) ? Number(screenLine) : 0;

  const m = tail.match(/IdleActionSec\s*=\s*(\d+)/);
  const suspendTimeoutSec = m ? Number(m[1]) : 0;

  return { screenTimeoutSec, suspendTimeoutSec };
}

export function writePowerCommand(user: string, host: string, values: PowerValues): string {
  const screen = Math.max(0, Math.floor(values.screenTimeoutSec));
  const idle = Math.max(0, Math.floor(values.suspendTimeoutSec));
  const remote =
    `DISPLAY=${XWAYLAND_DISPLAY} xset dpms ${screen} ${screen} ${screen} 2>/dev/null; ` +
    `DISPLAY=${XWAYLAND_DISPLAY} xset s ${screen === 0 ? "off" : screen} 2>/dev/null; ` +
    "sudo sed -i '/^\\s*IdleActionSec=/d' /etc/systemd/logind.conf && " +
    `echo 'IdleActionSec=${idle}' | sudo tee -a /etc/systemd/logind.conf >/dev/null && ` +
    "sudo systemctl reload systemd-logind.service 2>/dev/null || true";
  return `ssh -o BatchMode=yes -o ConnectTimeout=8 ${user}@${host} "${remote}"`;
}

function shellCmd(): string {
  return process.platform === "win32" ? "cmd.exe" : "/bin/sh";
}

function connectedEnv(): { user: string; host: string } {
  const env = readDeckEnv();
  const host = env.DECK_IP;
  if (!host) throw new Error("DECK_IP not configured — run deck_configure first");
  return { user: env.DECK_USER ?? "deck", host };
}

function readCurrentPower(): PowerValues {
  const { user, host } = connectedEnv();
  const out = String(
    proc.execSync(readPowerCommand(user, host), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: shellCmd(),
    }) ?? ""
  );
  return parsePowerRead(out);
}

function applyPower(values: PowerValues): void {
  const { user, host } = connectedEnv();
  proc.execSync(writePowerCommand(user, host, values), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: shellCmd(),
  });
}

function controller(ttlMinutes: number): SnapshotController<PowerValues> {
  return {
    kind: POWER_KIND,
    restoreToolHint: RESTORE_POWER_TOOL_HINT,
    ttlMinutes,
    readCurrent: readCurrentPower,
    apply: applyPower,
  };
}

export interface HoldAwakeOptions {
  ttlMinutes?: number;
  note?: string;
  /** Test-only clock override; production always uses Date.now. */
  now?: () => number;
}

export type HoldAwakeResult = TakeReport<PowerValues> & { summary: string };

export async function holdAwake(opts: HoldAwakeOptions = {}): Promise<HoldAwakeResult> {
  const ttlMinutes = opts.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  const report = await takeSnapshot(controller(ttlMinutes), () => ({
    screenTimeoutSec: 0,
    suspendTimeoutSec: 0,
  }), { note: opts.note, now: opts.now });

  const summary =
    `screen/suspend timeouts disabled (were ${report.previous.screenTimeoutSec}s / ` +
    `${report.previous.suspendTimeoutSec}s). Call ${RESTORE_POWER_TOOL_HINT} when the run is ` +
    `done -- it also restores itself automatically at ${report.expiresAt} if nothing calls it first.` +
    (report.autoRestoredExpired
      ? ` Note: an earlier hold from ${report.autoRestoredExpired.at} had expired and was ` +
        "restored first."
      : "");

  return { ...report, summary };
}

export type RestorePowerResult = RestoreReport<PowerValues> & { summary: string };

export async function restorePowerSettings(): Promise<RestorePowerResult> {
  const report = await restoreSnapshot(
    controller(DEFAULT_TTL_MINUTES) // ttlMinutes is irrelevant for a restore -- nothing new is written
  );
  return { ...report, summary: report.note };
}
