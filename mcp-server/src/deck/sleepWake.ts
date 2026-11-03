/**
 * deck_sleepAndWake -- put a real Steam Deck to sleep, let it wake itself, and
 * record where the focus ring was before and where it is after.
 *
 * WHY. A bonsAI bug was first seen after the Deck slept and woke: focus landed
 * on an invisible button. Every other way of forcing a redraw came back clean,
 * so the fix shipped without ever testing the one path that showed the bug
 * (ROADMAP, "Sleep the Deck and wake it again").
 *
 * WHY IT IS DANGEROUS. A sleeping Deck ignores its controller, so the bridge
 * cannot wake it, and the power button is physical. A sleep with no way back
 * strands the Deck and ends the session. So the way back is armed and READ
 * BACK before anything sleeps, and every step that fails before the suspend
 * clears the alarm and refuses.
 *
 * WHAT WAS MEASURED, AND WHERE IT CAME FROM:
 *
 *   - The way back: `sudo rtcwake -m no -s <seconds>` arms the RTC alarm
 *     without suspending, /sys/class/rtc/rtc0/wakealarm reads the epoch back,
 *     and `sudo rtcwake -m disable` clears it. On this Deck, 2026-09-08, as the
 *     safety net of the inhibitor spike: suspend 18:44:01, resume 18:45:36,
 *     SSH answering 18:45:43 -- about 7 s from resume to SSH.
 *   - The suspend: SteamClient.System.SuspendPC() in SharedJSContext over CDP
 *     is the call Steam's own idle timer makes, and it goes through logind
 *     (holdAwake.ts has the measurements). A logind BLOCK inhibitor on sleep
 *     refuses it, which is why one held by anybody is a refusal here.
 *
 * WHAT WAS NOT MEASURED, stated so nobody reads the tests as more than they
 * are: this tool as a whole has never run on a Deck. The 250 ms deferral of
 * SuspendPC (so the CDP reply arrives before the machine goes) is this file's
 * choice, not the spike's; the spike called it directly. How long SSH takes
 * to stop answering after the call, whether Steam's CEF answers straight after
 * resume, and what the journal lines read like on this Deck are all owed to
 * the phase-2 run.
 *
 * NOTHING HERE PRESSES. The suspend is a CDP call (fidelity null, not a
 * press), and on the way back the only things done are reads, the alarm
 * clear, and a fresh CDP tunnel. It does not open the panel and does not try
 * to put the ring back: the point is to see where it landed. A ring that came
 * back somewhere else is reported, never fixed.
 *
 * THE KILLSWITCH FILE lives on this PC (killswitch.ts getLatchPath), not on
 * the Deck, so a Deck sleep cannot touch it. The roadmap asks for it to be
 * checked anyway; what the check can actually catch is a stop set while the
 * Deck slept, or this PC's config directory changing under the run.
 */
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";

import { reportCallStage } from "../callDeadline.js";
import { currentMachine, sshTarget, type Machine } from "../machines.js";
import { getWorkspaceArtifactsDir, timestamp } from "../tools/captureOrchestrator.js";
import { closeSharedCdpTunnel, openCdpTunnel } from "./cdpTunnel.js";
import { describeVisibility, focusKey, labelOfElement } from "./focusKey.js";
import {
  checkGameProcesses,
  readRoute,
  readRunningApps,
  SHARED_JS_CONTEXT,
  type ProcessCheck,
  type ReadPageFn,
} from "./gameSession.js";
import { HOLD_MARKER, RESTORE_POWER_TOOL_HINT } from "./holdAwake.js";
import { automationStopped, getLatchPath, stoppedMessage, type StopRecord } from "./killswitch.js";
import { readPage } from "./readPage.js";
import { DEFAULT_TARGETS_SETTLE_MS, readFocusAt, type ReadFocusResult, type Visibility } from "./readFocus.js";

export const MIN_SECONDS = 45;
export const MAX_SECONDS = 600;
/** SSH must stop answering this soon after the suspend call, or it did not suspend. */
export const GONE_WITHIN_MS = 30_000;
/** After the alarm's time, how long SSH has to come back. Measured: ~7 s past resume. */
export const BACK_GRACE_MS = 60_000;
/** The call's deadline is seconds plus this: reads before, the wait, reads after. */
export const DEADLINE_EXTRA_MS = 180_000;
/** wakealarm read back against the Deck's own clock plus seconds. RTC and system clock may drift by a second or two. */
export const ALARM_TOLERANCE_S = 5;
/** At the moment of the suspend call, at least this long must remain on the alarm. */
export const MIN_ALARM_MARGIN_S = 30;
const GONE_POLL_MS = 2_000;
const BACK_POLL_MS = 3_000;
/** ConnectTimeout for the "is it there" probe, and the process cap around it. */
const PROBE_CONNECT_S = 3;
const PROBE_TIMEOUT_MS = 6_000;
/** After SSH answers again, how long to keep trying to reach Steam's CEF. */
const CDP_BACK_WAIT_MS = 30_000;

export const SLEEP_WAKE_TOOL = "deck_sleepAndWake";
export type SleepVia = "steam-suspend-call" | "power-menu";

const WAKEALARM = "/sys/class/rtc/rtc0/wakealarm";
const MARK_PRE = "---DPS-SW-PRE---";
const MARK_RUN = "---DPS-SW-RUN---";
const MARK_READ = "---DPS-SW-READ---";
const MARK_NOW = "---DPS-SW-NOW---";
const MARK_UP = "---DPS-SW-UP---";

// ---------------------------------------------------------------------------
// Remote commands. Pure, exported for the tests. No double quotes in any of
// them: they travel as one argv entry to ssh, and that keeps Windows' argument
// quoting out of the picture.
// ---------------------------------------------------------------------------

/** Every logind lock, with its exit status, so an unreadable list is not read as an empty one. */
export const INHIBITOR_LIST_COMMAND = "systemd-inhibit --list --no-pager 2>&1; echo rc=$?";

/**
 * Arm the alarm and read it back, against the Deck's own clock (never this
 * PC's: the two can disagree by more than the tolerance). `sudo -n`, as
 * holdAwake does: a password prompt fails at once instead of hanging.
 */
export function armCommand(seconds: number): string {
  return (
    `echo ${MARK_PRE}; cat ${WAKEALARM} 2>&1; ` +
    `echo ${MARK_RUN}; sudo -n rtcwake -m no -s ${Math.floor(seconds)} 2>&1; echo rc=$?; ` +
    `echo ${MARK_READ}; cat ${WAKEALARM} 2>&1; ` +
    `echo ${MARK_NOW}; date +%s`
  );
}

/** Read the alarm as it stands, clear it, and read it again. */
export const CLEAR_COMMAND =
  `echo ${MARK_PRE}; cat ${WAKEALARM} 2>&1; ` +
  `echo ${MARK_RUN}; sudo -n rtcwake -m disable 2>&1; echo rc=$?; ` +
  `echo ${MARK_READ}; cat ${WAKEALARM} 2>&1`;

/** When the Deck booted (a reboot changes it) and its clock now. */
export const STATE_COMMAND = `echo ${MARK_UP}; uptime -s; echo ${MARK_NOW}; date +%s`;

/** The cheap "are you there" probe. */
export const ALIVE_COMMAND = "true";

/** Suspend and resume lines since just before the suspend. Best effort: sudo first, then the user's own view. */
export function journalCommand(sinceEpochS: number): string {
  const since = Math.floor(sinceEpochS);
  const j = `journalctl -b --no-pager -o short-iso --since @${since}`;
  return `(sudo -n ${j} 2>/dev/null || ${j} 2>/dev/null) | grep -Ei 'suspend|resum|sleep state' | tail -n 30`;
}

/**
 * ssh's arguments. `fresh` turns connection sharing off: a ControlMaster in
 * ~/.ssh/config would otherwise let the liveness probe ride an existing
 * connection, and a probe that does not open a new TCP connection does not
 * ask whether the Deck is there.
 */
export function sshArgs(user: string, host: string, command: string, connectTimeoutS: number, fresh: boolean): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${connectTimeoutS}`,
    ...(fresh ? ["-o", "ControlMaster=no", "-o", "ControlPath=none"] : []),
    `${user}@${host}`,
    command,
  ];
}

// ---------------------------------------------------------------------------
// Page expressions
// ---------------------------------------------------------------------------

/**
 * NOT A READ. Steam's own suspend call, deferred 250 ms so this evaluate gets
 * its reply before the machine goes. What the call returned, or threw, is left
 * on window.__dpsSleepWake so a suspend that never happened can say why
 * (logind refusing it, say) -- read back with SUSPEND_RESULT_EXPR.
 */
export const SUSPEND_EXPR =
  "(() => { try { var S = window.SteamClient && window.SteamClient.System; " +
  "if (!S || typeof S.SuspendPC !== 'function') return { ok: false, reason: 'SteamClient.System.SuspendPC is not available' }; " +
  "var w = window.__dpsSleepWake = { scheduledAt: Date.now(), calledAt: null, returned: null, error: null }; " +
  "setTimeout(function () { try { w.calledAt = Date.now(); var p = S.SuspendPC(); " +
  "if (p && typeof p.then === 'function') { p.then(function (v) { try { w.returned = v === undefined ? 'undefined' : JSON.stringify(v); } catch (e) { w.returned = String(v); } }, " +
  "function (e) { w.error = String((e && e.message) || e); }); } else { w.returned = String(p); } } catch (e) { w.error = String(e); } }, 250); " +
  "return { ok: true }; } catch (e) { return { ok: false, reason: String(e) }; } })()";

/** A read: what SUSPEND_EXPR's deferred call left behind. */
export const SUSPEND_RESULT_EXPR =
  "(() => { try { return window.__dpsSleepWake || null; } catch (e) { return { error: String(e) }; } })()";

// ---------------------------------------------------------------------------
// Parsers. Pure, exported for the tests.
// ---------------------------------------------------------------------------

function section(output: string, start: string, end?: string): string | null {
  const i = output.indexOf(start);
  if (i < 0) return null;
  const rest = output.slice(i + start.length);
  if (!end) return rest.trim();
  const j = rest.indexOf(end);
  return (j < 0 ? rest : rest.slice(0, j)).trim();
}

function epochOf(text: string | null): number | null {
  const t = (text ?? "").trim();
  return /^\d{9,11}$/.test(t) ? Number(t) : null;
}

function rcOf(text: string | null): number | null {
  const m = /rc=(\d+)/.exec(text ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * The lines of `systemd-inhibit --list` that would refuse a suspend: mode
 * `block` (the last column) and `sleep` among the things inhibited. A delay
 * lock (NetworkManager, rtkit, UPower and cecd each hold one on a stock Deck)
 * only postpones a suspend by seconds, so it is not a refusal.
 */
export function parseBlockSleepInhibitors(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => {
      const parts = l.split(/\s+/);
      if (parts.length < 2 || parts[parts.length - 1] !== "block") return false;
      return /(^|[\s:])sleep([\s:]|$)/.test(parts.slice(0, -1).join(" "));
    });
}

export interface InhibitorRead {
  /** False when the list could not be read; never read as "no lock". */
  read: boolean;
  blocking: string[];
  /** True when one of them is deck_holdAwake's own lock. */
  ours: boolean;
  reason?: string;
}

export function parseInhibitorList(r: ShellResult): InhibitorRead {
  const rc = rcOf(r.stdout);
  if (r.status !== 0 || rc !== 0) {
    const why = (r.stderr || r.stdout).trim().slice(0, 200);
    return { read: false, blocking: [], ours: false, reason: `systemd-inhibit --list did not answer (exit ${rc ?? r.status ?? "none"}${why ? `: ${why}` : ""})` };
  }
  const blocking = parseBlockSleepInhibitors(r.stdout);
  return { read: true, blocking, ours: blocking.some((l) => l.includes(HOLD_MARKER)) };
}

export interface ArmReadBack {
  ok: boolean;
  /** What wakealarm held before this tool armed it. Empty when nothing was armed. */
  previous: string | null;
  /** What rtcwake printed, and its exit status. */
  rtcwakeOutput: string;
  rtcwakeRc: number | null;
  /** The epoch read back from wakealarm after arming. */
  epoch: number | null;
  /** The Deck's clock, read straight after. */
  deckNow: number | null;
  /** deckNow + seconds: what the read-back should be. */
  expected: number | null;
  /** epoch - expected, in seconds. */
  driftS: number | null;
  reason?: string;
}

export function parseArmOutput(stdout: string, seconds: number): ArmReadBack {
  const previous = section(stdout, MARK_PRE, MARK_RUN);
  const run = section(stdout, MARK_RUN, MARK_READ) ?? "";
  const rtcwakeRc = rcOf(run);
  const rtcwakeOutput = run.replace(/rc=\d+\s*$/, "").trim();
  const readBack = section(stdout, MARK_READ, MARK_NOW);
  const epoch = epochOf(readBack);
  const deckNow = epochOf(section(stdout, MARK_NOW));
  const expected = deckNow !== null ? deckNow + Math.floor(seconds) : null;
  const driftS = epoch !== null && expected !== null ? epoch - expected : null;
  const base: ArmReadBack = { ok: false, previous: previous || null, rtcwakeOutput, rtcwakeRc, epoch, deckNow, expected, driftS };
  if (rtcwakeRc !== 0) {
    const sudo = /password is required|not in the sudoers|a terminal is required/i.test(rtcwakeOutput)
      ? " sudo asked for a password: this tool runs `sudo -n rtcwake`, which needs a NOPASSWD sudo rule for the Deck's user (scripts/setup-dev writes one)"
      : "";
    return { ...base, reason: `rtcwake -m no -s ${seconds} failed (exit ${rtcwakeRc ?? "unknown"}): ${rtcwakeOutput || "no output"}.${sudo}` };
  }
  if (epoch === null) {
    return { ...base, reason: `${WAKEALARM} did not read back an epoch after arming (read: ${JSON.stringify(readBack ?? null)})` };
  }
  if (deckNow === null) {
    return { ...base, reason: "the Deck's clock (date +%s) could not be read, so the alarm cannot be checked" };
  }
  if (Math.abs(driftS!) > ALARM_TOLERANCE_S) {
    return {
      ...base,
      reason:
        `${WAKEALARM} reads ${epoch}, but the Deck's clock plus ${seconds} s is ${expected} -- ${driftS} s apart, ` +
        `more than the ${ALARM_TOLERANCE_S} s allowed. An RTC kept in local time, or a clock far off, would do this; ` +
        `the alarm cannot be trusted to wake the Deck when this tool expects`,
    };
  }
  return { ...base, ok: true };
}

export interface AlarmClear {
  /** False when the command never got as far as reading the alarm (SSH down). */
  ran: boolean;
  /** True when wakealarm reads empty after the disable -- read back, not assumed. */
  cleared: boolean;
  /** What wakealarm held just before the clear. */
  before: string | null;
  rc: number | null;
  detail: string;
}

export function parseClearOutput(r: ShellResult): AlarmClear {
  if (r.status === null || !r.stdout.includes(MARK_READ)) {
    return { ran: false, cleared: false, before: null, rc: null, detail: `could not run rtcwake -m disable: ${(r.stderr || r.stdout).trim().slice(0, 200) || "no answer"}` };
  }
  const before = section(r.stdout, MARK_PRE, MARK_RUN);
  const run = section(r.stdout, MARK_RUN, MARK_READ) ?? "";
  const rc = rcOf(run);
  const after = section(r.stdout, MARK_READ) ?? "";
  const cleared = after.trim() === "";
  return {
    ran: true,
    cleared,
    before: before || null,
    rc,
    detail: cleared
      ? `rtcwake -m disable exit ${rc ?? "unknown"}; ${WAKEALARM} reads empty`
      : `rtcwake -m disable exit ${rc ?? "unknown"} (${run.replace(/rc=\d+\s*$/, "").trim() || "no output"}); ${WAKEALARM} still reads ${JSON.stringify(after.trim())}`,
  };
}

export function parseState(stdout: string): { uptimeSince: string | null; deckNow: number | null } {
  const up = section(stdout, MARK_UP, MARK_NOW);
  return { uptimeSince: up && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(up) ? up : null, deckNow: epochOf(section(stdout, MARK_NOW)) };
}

export interface JournalRead {
  /** False when nothing came back; "unknown", not "no suspend". */
  read: boolean;
  lines: string[];
  suspendLine: string | null;
  resumeLine: string | null;
}

export function parseJournal(stdout: string): JournalRead {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return {
    read: lines.length > 0,
    lines,
    suspendLine: lines.find((l) => /will suspend now|PM: suspend entry|Entering sleep state/i.test(l)) ?? null,
    resumeLine: lines.find((l) => /PM: suspend exit|returned from sleep|resumed from/i.test(l)) ?? null,
  };
}

/**
 * Did the alarm wake it? Best effort, from wakealarm as read after the Deck
 * came back: the kernel drops an alarm once it fires, so an empty file at or
 * past the alarm's time says it fired, and the epoch still sitting there says
 * something else woke the Deck first. Anything else is unknown.
 */
export function judgeAlarmFired(beforeClear: string | null | undefined, alarmEpoch: number | null, deckNowAfter: number | null): boolean | "unknown" {
  if (beforeClear === undefined || alarmEpoch === null) return "unknown";
  const held = epochOf(beforeClear);
  if (held !== null) return held === alarmEpoch ? false : "unknown";
  if ((beforeClear ?? "").trim() !== "") return "unknown";
  if (deckNowAfter === null) return "unknown";
  return deckNowAfter >= alarmEpoch - ALARM_TOLERANCE_S ? true : "unknown";
}

// ---------------------------------------------------------------------------
// Focus and latch snapshots
// ---------------------------------------------------------------------------

export interface FocusSnapshot {
  ok: boolean;
  reason: string | null;
  /** focusKey(): the same identity assertFocusMove and runSequence use. */
  key: string | null;
  label: string | null;
  selector: string | null;
  target: string | null;
  quickAccessTab: string | null;
  visibleQuickAccessTab: string | null;
  deckyPluginRoot: boolean;
  deckyPanelLabels: string[];
  visibility: Visibility | null;
}

export function focusSnapshot(r: ReadFocusResult | null): FocusSnapshot {
  return {
    ok: Boolean(r?.ok),
    reason: r?.ok ? null : (r?.reason ?? "no read"),
    key: focusKey(r),
    label: r?.gpfocus ? labelOfElement(r.gpfocus) : null,
    selector: r?.gpfocus?.selector ?? null,
    target: r?.target?.title ?? null,
    quickAccessTab: r?.quickAccessTab ?? null,
    visibleQuickAccessTab: r?.visibleQuickAccessTab ?? null,
    deckyPluginRoot: Boolean(r?.deckyPluginRoot),
    deckyPanelLabels: r?.deckyPanelLabels ?? [],
    visibility: r?.visibility ?? null,
  };
}

export interface LatchFileState {
  path: string;
  exists: boolean;
  mtimeMs: number | null;
  sha256: string | null;
}

export function latchState(file: string): LatchFileState {
  try {
    const st = fs.statSync(file);
    const sha256 = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    return { path: file, exists: true, mtimeMs: st.mtimeMs, sha256 };
  } catch {
    return { path: file, exists: false, mtimeMs: null, sha256: null };
  }
}

function sameLatches(a: LatchFileState[], b: LatchFileState[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.path === b[i].path && x.exists === b[i].exists && x.mtimeMs === b[i].mtimeMs && x.sha256 === b[i].sha256);
}

function describeFocus(f: FocusSnapshot | null): string {
  if (!f) return "not read";
  if (!f.key) return `no ring (${f.reason ?? "nothing owns it"})`;
  return `${f.label ? `"${f.label}"` : "an unnamed control"} (${f.selector ?? f.key}) in ${f.target ?? "an unknown page"}`;
}

/**
 * Before against after. Both rings present and different, or one present and
 * the other not, is a move; two absent rings are unknown, never "unchanged".
 */
export function compareFocus(before: FocusSnapshot | null, after: FocusSnapshot | null): { moved: boolean | "unknown"; report: string } {
  const bk = before?.key ?? null;
  const ak = after?.key ?? null;
  if (bk && ak) {
    return bk === ak
      ? { moved: false, report: `focus came back where it was: ${describeFocus(after)}` }
      : { moved: true, report: `FOCUS CAME BACK SOMEWHERE ELSE: before the sleep ${describeFocus(before)}, after the wake ${describeFocus(after)}` };
  }
  if (bk || ak) {
    return { moved: true, report: `FOCUS CAME BACK SOMEWHERE ELSE: before the sleep ${describeFocus(before)}, after the wake ${describeFocus(after)}` };
  }
  return { moved: "unknown", report: `no ring could be read before or after (before: ${describeFocus(before)}; after: ${describeFocus(after)})` };
}

// ---------------------------------------------------------------------------
// The deadline
// ---------------------------------------------------------------------------

/**
 * This call's deadline: seconds + 180 s unless the caller asked for one. A
 * requested deadline shorter than that is refused before anything runs: a
 * call cut off mid-sleep reports nothing and leaves the alarm armed.
 */
export function sleepWakeDeadlineMs(seconds: unknown, requestedMs: number, source: "default" | "requested"): number {
  const s = Number(seconds);
  const clamped = Number.isFinite(s) ? Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.floor(s))) : MIN_SECONDS;
  const needed = clamped * 1000 + DEADLINE_EXTRA_MS;
  if (source === "default") return needed;
  if (requestedMs < needed) {
    throw new Error(
      `${SLEEP_WAKE_TOOL} needs a deadline of at least ${needed} ms for seconds: ${clamped} (seconds + 180 s); ` +
        `deadlineMs ${requestedMs} was asked for. Omit deadlineMs to use that. A call cut off while the Deck sleeps ` +
        `would report nothing and leave the wake alarm armed.`,
    );
  }
  return requestedMs;
}

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

export interface ShellResult {
  /** null when the command could not run at all, or was killed at its timeout. */
  status: number | null;
  stdout: string;
  stderr: string;
}

export type SshRunner = (command: string, opts: { timeoutMs: number; connectTimeoutS: number; fresh?: boolean }) => Promise<ShellResult>;

/**
 * The real runner: async, so a probe that waits on a sleeping Deck does not
 * block the server (a lease heartbeat, a stop from the extension) while it
 * waits. spawn is wrapped by callDeadline's child tracking, so a call that runs
 * out of time kills what it started.
 */
function defaultSsh(m: Machine): SshRunner {
  return (command, opts) =>
    new Promise((resolve) => {
      let target: { user: string; host: string };
      try {
        target = sshTarget(m);
      } catch (err) {
        resolve({ status: null, stdout: "", stderr: (err as Error).message });
        return;
      }
      let out = "";
      let err = "";
      let timedOut = false;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("ssh", sshArgs(target.user, target.host, command, opts.connectTimeoutS, Boolean(opts.fresh)), {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (e) {
        resolve({ status: null, stdout: "", stderr: (e as Error).message });
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, opts.timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => (out += d));
      child.stderr?.on("data", (d: string) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ status: null, stdout: out, stderr: e.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ status: timedOut ? null : code, stdout: out, stderr: timedOut ? `timed out after ${opts.timeoutMs} ms` : err });
      });
    });
}

export interface SleepWakeDeps {
  ssh?: SshRunner;
  /** The CDP base URL; the shared tunnel by default. */
  openCdp?: () => Promise<string>;
  /** Drop the shared tunnel, so the way back opens a fresh one. */
  resetCdp?: () => void;
  readPageFn?: ReadPageFn;
  readFocusFn?: (base: string) => Promise<ReadFocusResult>;
  processCheckFn?: () => ProcessCheck | Promise<ProcessCheck>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  runsDir?: () => string;
}

export interface SleepWakeOptions extends SleepWakeDeps {
  seconds: number;
  via?: string;
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

export interface SleepWakeSide {
  at: string;
  focus: FocusSnapshot | null;
  route: string | null;
  /** `uptime -s` on the Deck: when it booted. Different after means it rebooted. */
  uptimeSince: string | null;
  deckEpoch: number | null;
  killswitch: LatchFileState[];
}

export interface SleepWakeStage {
  stage: string;
  ok: boolean;
  detail: string;
  /** ms since the call started. */
  atMs: number;
}

export interface SleepWakeResult {
  ok: boolean;
  via: SleepVia | null;
  /** Never a press: the suspend is a CDP call. */
  fidelity: null;
  presses: 0;
  seconds: number | null;
  /** null when it refused before the suspend call. */
  suspended: boolean | null;
  /** How the suspend is known: SSH going away alone, or a journal line as well. */
  suspendSeenBy: "ssh" | "ssh+journal" | null;
  /** null when it never got as far as waiting for the way back. */
  back: boolean | null;
  alarm: ArmReadBack | null;
  alarmFired: boolean | "unknown" | null;
  /** Cleared at the end whether or not it fired; null when it was never armed or the Deck could not be reached. */
  alarmCleared: boolean | null;
  alarmClearDetail: string | null;
  /** From the first failed SSH probe to the first answer, in 2-3 s steps. */
  suspendedForMs: number | null;
  /** From the suspend call to SSH answering again. */
  sshBackAfterMs: number | null;
  before: SleepWakeSide | null;
  after: SleepWakeSide | null;
  focusMoved: boolean | "unknown" | null;
  focusReport: string | null;
  routeChanged: boolean | null;
  /** Both latch files on this PC unchanged across the sleep. */
  killswitchSurvived: boolean | null;
  /** uptime -s changed across the sleep. */
  rebooted: boolean | "unknown" | null;
  journal: JournalRead | null;
  /** What Steam's suspend call returned or threw, when it could be read. */
  suspendCall: unknown;
  /** A stop set while the Deck slept. Nothing presses here either way. */
  stoppedDuringRun: StopRecord | null;
  stages: SleepWakeStage[];
  runFile: string | null;
  reason?: string;
  summary: string;
}

function writeAtomic(file: string, body: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// deck_sleepAndWake
// ---------------------------------------------------------------------------

export async function sleepAndWake(opts: SleepWakeOptions): Promise<SleepWakeResult> {
  const m = currentMachine();
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();

  const result: SleepWakeResult = {
    ok: false,
    via: null,
    fidelity: null,
    presses: 0,
    seconds: null,
    suspended: null,
    suspendSeenBy: null,
    back: null,
    alarm: null,
    alarmFired: null,
    alarmCleared: null,
    alarmClearDetail: null,
    suspendedForMs: null,
    sshBackAfterMs: null,
    before: null,
    after: null,
    focusMoved: null,
    focusReport: null,
    routeChanged: null,
    killswitchSurvived: null,
    rebooted: null,
    journal: null,
    suspendCall: null,
    stoppedDuringRun: null,
    stages: [],
    runFile: null,
    summary: "",
  };
  const stage = (name: string, ok: boolean, detail: string): void => {
    result.stages.push({ stage: name, ok, detail, atMs: now() - started });
    reportCallStage(name);
  };
  const refuse = (reason: string, summary?: string): SleepWakeResult => {
    result.reason = reason;
    result.summary = summary ?? `refused, nothing slept: ${reason}`;
    return result;
  };

  // ---- the machine, before anything else -----------------------------------
  if (m.kind !== "deck") {
    return refuse(
      `"${m.name}" is a stand-in (kind ${m.kind}, os ${m.os}). ${SLEEP_WAKE_TOOL} runs only on a real Deck (kind deck) ` +
        "running steamos or bazzite: a stand-in's sleep is not the Deck's, and its way back was never measured",
    );
  }
  if (m.os !== "steamos" && m.os !== "bazzite") {
    return refuse(`"${m.name}" runs ${m.os}; rtcwake and logind exist only on steamos and bazzite`);
  }
  if (m.local) {
    return refuse(`"${m.name}" is local: this server runs on the Deck itself and would go to sleep with it, with nothing left to watch the way back`);
  }

  // ---- arguments --------------------------------------------------------------
  const via = opts.via ?? "steam-suspend-call";
  if (via === "power-menu") {
    result.via = "power-menu";
    return refuse('via "power-menu" is not implemented this lane: only "steam-suspend-call" (SteamClient.System.SuspendPC) is built');
  }
  if (via !== "steam-suspend-call") {
    return refuse(`via must be "steam-suspend-call" or "power-menu"; got ${JSON.stringify(via)}`);
  }
  result.via = "steam-suspend-call";
  const seconds = Number(opts.seconds);
  if (!Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
    return refuse(`seconds must be between ${MIN_SECONDS} and ${MAX_SECONDS}; got ${JSON.stringify(opts.seconds)}`);
  }
  const secs = Math.floor(seconds);
  result.seconds = secs;

  const stopped = automationStopped(m.name);
  if (stopped) return refuse(stoppedMessage(stopped));

  const ssh = opts.ssh ?? defaultSsh(m);
  const run = (command: string, timeoutMs = 15_000) => ssh(command, { timeoutMs, connectTimeoutS: 5 });
  const alive = async (): Promise<boolean> =>
    (await ssh(ALIVE_COMMAND, { timeoutMs: PROBE_TIMEOUT_MS, connectTimeoutS: PROBE_CONNECT_S, fresh: true })).status === 0;
  const openCdp = opts.openCdp ?? (async () => (await openCdpTunnel()).base);
  const resetCdp = opts.resetCdp ?? closeSharedCdpTunnel;
  const readPageFn: ReadPageFn = opts.readPageFn ?? readPage;
  const readFocusFn =
    opts.readFocusFn ?? ((base: string) => readFocusAt(base, 10_000, undefined, { targetsSettleMs: DEFAULT_TARGETS_SETTLE_MS }));
  const latchFiles = [getLatchPath(), getLatchPath(m.name)];

  // ---- refusals that need the Deck: a game, an inhibitor -------------------
  let base: string;
  try {
    base = await openCdp();
  } catch (err) {
    stage("cdp", false, (err as Error).message);
    return refuse(`could not reach Steam's debugger on "${m.name}": ${(err as Error).message}`);
  }
  const running = await readRunningApps(base, readPageFn);
  if (!running.ok) {
    stage("read-running", false, running.reason ?? "RunningApps unreadable");
    return refuse(`could not read window.SteamUIStore.RunningApps in ${SHARED_JS_CONTEXT}, so a running game cannot be ruled out: ${running.reason}`);
  }
  if (running.apps.length > 0) {
    const g = running.apps[0];
    stage("read-running", false, `${g.display_name || "a game"} (${g.appid}) is running`);
    return refuse(`${g.display_name || "a game"} (appid ${g.appid}) is running. Exit it first with deck_exitGame; a suspend with a game up is not the case this tool tests`);
  }
  let check: ProcessCheck;
  try {
    check = opts.processCheckFn ? await opts.processCheckFn() : checkGameProcesses(m);
  } catch (err) {
    check = { checked: false, skipped: false, reason: `the process check failed: ${(err as Error).message}` };
  }
  if (!check.checked) {
    stage("process-check", false, check.reason);
    return refuse(`RunningApps is empty, but the process list could not be asked (${check.reason}), so a running game cannot be ruled out`);
  }
  if (check.processes.length > 0) {
    const p = check.processes[0];
    stage("process-check", false, `${check.how} found pid ${p.pid}`);
    return refuse(
      `RunningApps is empty, but ${check.how} shows ${p.appid !== null ? `appid ${p.appid}` : "a game"} alive as pid ${p.pid} (${p.command}). ` +
        "Nothing was slept; exit the game first",
    );
  }
  stage("no-game", true, `RunningApps is empty and ${check.how} found no game process`);

  const inhib = parseInhibitorList(await run(INHIBITOR_LIST_COMMAND));
  if (!inhib.read) {
    stage("inhibitors", false, inhib.reason ?? "unreadable");
    return refuse(`${inhib.reason}; a lock that refuses the suspend cannot be ruled out`);
  }
  if (inhib.blocking.length > 0) {
    stage("inhibitors", false, inhib.blocking.join(" | "));
    return refuse(
      `a logind block inhibitor on sleep is held, so logind would refuse the suspend: ${inhib.blocking.join(" | ")}. ` +
        (inhib.ours
          ? `It is deck_holdAwake's lock; release it with ${RESTORE_POWER_TOOL_HINT} first.`
          : `If it is deck_holdAwake's, ${RESTORE_POWER_TOOL_HINT} releases it; otherwise whoever took it has to.`),
    );
  }
  stage("inhibitors", true, "no block inhibitor on sleep");

  // ---- record before ----------------------------------------------------------
  const beforeFocus = await readFocusFn(base);
  const beforeRoute = await readRoute(base, readPageFn);
  const beforeState = parseState((await run(STATE_COMMAND)).stdout);
  const beforeSide: SleepWakeSide = {
    at: new Date(now()).toISOString(),
    focus: focusSnapshot(beforeFocus),
    route: beforeRoute,
    uptimeSince: beforeState.uptimeSince,
    deckEpoch: beforeState.deckNow,
    killswitch: latchFiles.map(latchState),
  };
  result.before = beforeSide;
  stage("before", true, `focus ${describeFocus(beforeSide.focus)}; route ${beforeRoute ?? "unreadable"}`);

  // ---- arm the way back, and read it back ----------------------------------
  const disarm = async (): Promise<void> => {
    const c = parseClearOutput(await run(CLEAR_COMMAND));
    result.alarmCleared = c.cleared;
    result.alarmClearDetail = c.detail;
    stage("clear-alarm", c.cleared, c.detail);
  };
  const armRun = await run(armCommand(secs));
  const arm = parseArmOutput(armRun.stdout, secs);
  if (!arm.ok && armRun.status === null) {
    arm.reason = `ssh did not answer the arm command (${armRun.stderr.trim() || "no output"}); ${arm.reason}`;
  }
  result.alarm = arm;
  const armedAtLocal = now();
  if (!arm.ok) {
    stage("arm", false, arm.reason ?? "read-back failed");
    // rtcwake may have set something even when the read-back disagrees.
    await disarm();
    return refuse(
      `the way back is not proven: ${arm.reason}`,
      `refused, nothing slept: the wake alarm did not read back (${arm.reason}). ` +
        `Alarm clear: ${result.alarmClearDetail}`,
    );
  }
  stage("arm", true, `${WAKEALARM} reads ${arm.epoch}, the Deck's clock + ${secs} s is ${arm.expected} (drift ${arm.driftS} s)`);

  // ---- write-then-act --------------------------------------------------------
  let runFile: string | null = null;
  const evidence = () => ({ tool: SLEEP_WAKE_TOOL, machine: { name: m.name, kind: m.kind, os: m.os }, ...result, runFile: undefined });
  const save = (): void => {
    if (!runFile) return;
    try {
      writeAtomic(runFile, evidence());
    } catch {
      /* the result still carries everything */
    }
  };
  try {
    const dir = (opts.runsDir ?? (() => getWorkspaceArtifactsDir("runs")))();
    const file = path.join(dir, `sleep-wake_${timestamp()}.json`);
    writeAtomic(file, evidence());
    runFile = file;
    result.runFile = file;
  } catch (err) {
    stage("run-file", false, (err as Error).message);
    await disarm();
    return refuse(`the run file could not be written before the suspend (${(err as Error).message}), so nothing slept`);
  }
  stage("run-file", true, runFile);

  // Past this point the alarm is armed. Anything that throws still ends in a
  // clear attempt and a saved run file, never in a silent return.
  try {
    return await armedRun();
  } catch (err) {
    stage("error", false, (err as Error).message);
    await disarm();
    save();
    return refuse(
      `stopped by an unexpected error after the alarm was armed: ${(err as Error).message}`,
      `stopped by an unexpected error after the alarm was armed (${(err as Error).message}). ` +
        `suspended: ${result.suspended}, back: ${result.back}. Alarm clear: ${result.alarmClearDetail}. Run file: ${runFile}`,
    );
  }

  async function armedRun(): Promise<SleepWakeResult> {
    // ---- last checks, then the suspend -----------------------------------------
    const lateStop = automationStopped(m.name);
    if (lateStop) {
      await disarm();
      save();
      return refuse(stoppedMessage(lateStop));
    }
    const remainingS = arm.epoch! - (arm.deckNow! + (now() - armedAtLocal) / 1000);
    if (remainingS < MIN_ALARM_MARGIN_S) {
      stage("margin", false, `${Math.round(remainingS)} s left on the alarm`);
      await disarm();
      save();
      return refuse(`only ${Math.round(remainingS)} s were left on the alarm at the suspend (needs ${MIN_ALARM_MARGIN_S} s); the reads before took too long`);
    }

    const call = await readPageFn({ expression: SUSPEND_EXPR, target: SHARED_JS_CONTEXT, cdpUrl: base, timeoutMs: 5_000 });
    const suspendCalledAt = now();
    const callValue = (call.value ?? null) as { ok?: boolean; reason?: string } | null;
    if (call.ok && callValue && callValue.ok === false) {
      stage("suspend", false, callValue.reason ?? "refused in the page");
      await disarm();
      save();
      return refuse(`Steam's suspend call could not be made: ${callValue.reason ?? "unknown"}`);
    }
    stage(
      "suspend",
      true,
      call.ok
        ? "SteamClient.System.SuspendPC() scheduled in SharedJSContext"
        : `the suspend call got no clean reply (${call.reason}); whether it ran is for the SSH probe to say`,
    );

    // ---- gone -------------------------------------------------------------------
    let lastAnswered = suspendCalledAt;
    let firstFail: number | null = null;
    let fails = 0;
    let goneAt: number | null = null;
    while (now() - suspendCalledAt < GONE_WITHIN_MS) {
      await sleep(GONE_POLL_MS);
      const t = now();
      if (await alive()) {
        fails = 0;
        firstFail = null;
        lastAnswered = t;
      } else {
        fails += 1;
        if (firstFail === null) firstFail = t;
        if (fails >= 2) {
          goneAt = firstFail;
          break;
        }
      }
    }
    if (goneAt === null) {
      result.suspended = false;
      stage("gone", false, `SSH kept answering for ${GONE_WITHIN_MS / 1000} s after the suspend call`);
      const sc = await readPageFn({ expression: SUSPEND_RESULT_EXPR, target: SHARED_JS_CONTEXT, cdpUrl: base, timeoutMs: 5_000 });
      result.suspendCall = sc.ok ? sc.value : { unread: sc.reason ?? "unread" };
      await disarm();
      save();
      const said = sc.ok && sc.value && typeof sc.value === "object" ? ` Steam's call left: ${JSON.stringify(sc.value)}.` : "";
      return refuse(
        `the Deck did not go to sleep: SSH still answered ${GONE_WITHIN_MS / 1000} s after SteamClient.System.SuspendPC() was called.${said}`,
        `suspended: false -- the Deck never stopped answering SSH within ${GONE_WITHIN_MS / 1000} s of the suspend call.${said} ` +
          `Alarm clear: ${result.alarmClearDetail}. Run file: ${runFile}`,
      );
    }
    result.suspended = true;
    stage("gone", true, `SSH stopped answering ${goneAt - suspendCalledAt} ms after the suspend call (last answer at +${lastAnswered - suspendCalledAt} ms)`);
    save();

    // ---- back -------------------------------------------------------------------
    const backBy = suspendCalledAt + secs * 1000 + BACK_GRACE_MS;
    let backAt: number | null = null;
    while (now() < backBy) {
      await sleep(BACK_POLL_MS);
      if (await alive()) {
        backAt = now();
        break;
      }
    }
    result.stoppedDuringRun = automationStopped(m.name);
    if (backAt === null) {
      result.back = false;
      stage("back", false, `SSH did not answer within ${secs} + ${BACK_GRACE_MS / 1000} s of the suspend call`);
      save();
      const alarmAt = arm.epoch !== null ? new Date(arm.epoch * 1000).toISOString() : "an unknown time";
      return refuse(
        `the Deck did not come back: no SSH answer within ${secs + BACK_GRACE_MS / 1000} s of the suspend call`,
        `NOT BACK: the Deck went to sleep and has not answered SSH within ${secs + BACK_GRACE_MS / 1000} s. The wake alarm ` +
          `was armed for ${alarmAt} (read back). If it is still asleep, press the power button. The alarm was not cleared ` +
          `(the Deck could not be reached); if it fired, it is spent. Run file: ${runFile}`,
      );
    }
    result.back = true;
    result.sshBackAfterMs = backAt - suspendCalledAt;
    result.suspendedForMs = backAt - goneAt;
    stage("back", true, `SSH answered ${result.sshBackAfterMs} ms after the suspend call`);

    // ---- after: focus first, nothing pressed, the panel not opened -------------
    resetCdp();
    let afterBase: string | null = null;
    let cdpReason = "";
    const cdpBy = now() + CDP_BACK_WAIT_MS;
    for (;;) {
      try {
        afterBase = await openCdp();
        break;
      } catch (err) {
        cdpReason = (err as Error).message;
        if (now() >= cdpBy) break;
        await sleep(2_000);
      }
    }
    let afterFocus: ReadFocusResult | null = null;
    let afterRoute: string | null = null;
    if (afterBase) {
      afterFocus = await readFocusFn(afterBase);
      afterRoute = await readRoute(afterBase, readPageFn);
      stage("cdp-back", true, `focus read ${afterFocus.ok ? "ok" : `failed: ${afterFocus.reason}`}`);
    } else {
      stage("cdp-back", false, `Steam's debugger did not answer within ${CDP_BACK_WAIT_MS / 1000} s of SSH: ${cdpReason}`);
    }

    const afterState = parseState((await run(STATE_COMMAND)).stdout);
    const clear = parseClearOutput(await run(CLEAR_COMMAND));
    result.alarmCleared = clear.cleared;
    result.alarmClearDetail = clear.detail;
    stage("clear-alarm", clear.cleared, clear.detail);
    result.alarmFired = judgeAlarmFired(clear.ran ? (clear.before ?? "") : undefined, arm.epoch, afterState.deckNow);

    const journal = parseJournal((await run(journalCommand((beforeState.deckNow ?? arm.deckNow ?? 0) - 5))).stdout);
    result.journal = journal;
    result.suspendSeenBy = journal.suspendLine ? "ssh+journal" : "ssh";

    result.after = {
      at: new Date(now()).toISOString(),
      focus: afterBase ? focusSnapshot(afterFocus) : null,
      route: afterRoute,
      uptimeSince: afterState.uptimeSince,
      deckEpoch: afterState.deckNow,
      killswitch: latchFiles.map(latchState),
    };
    const cmp = compareFocus(beforeSide.focus, result.after.focus);
    result.focusMoved = cmp.moved;
    result.focusReport = cmp.report;
    result.routeChanged = beforeRoute !== null && afterRoute !== null ? beforeRoute !== afterRoute : null;
    result.killswitchSurvived = sameLatches(beforeSide.killswitch, result.after.killswitch);
    result.rebooted =
      beforeSide.uptimeSince && result.after.uptimeSince ? beforeSide.uptimeSince !== result.after.uptimeSince : "unknown";

    result.ok = result.alarmCleared === true;
    save();

    const vis = describeVisibility(result.after.focus?.visibility ?? null);
    const parts = [
      `slept and came back: SSH gone ${goneAt - suspendCalledAt} ms after SteamClient.System.SuspendPC(), back ${result.sshBackAfterMs} ms after it ` +
        `(away ~${result.suspendedForMs} ms, by SSH probes${journal.suspendLine ? "; the journal has the suspend line" : "; no journal suspend line was read"}).`,
      `${cmp.report}${vis ? `, ${vis}` : ""}.`,
      result.routeChanged ? `The route changed: ${beforeRoute} -> ${afterRoute}.` : "",
      cmp.moved === true ? "Nothing was pressed to put it back." : "",
      `Alarm fired: ${result.alarmFired}. Alarm clear: ${clear.detail}${clear.cleared ? "" : " -- THE ALARM IS STILL ARMED"}.`,
      result.rebooted === true ? `uptime -s changed (${beforeSide.uptimeSince} -> ${result.after.uptimeSince}): the Deck REBOOTED, it did not resume.` : "",
      result.killswitchSurvived ? "" : "A killswitch latch file on this PC changed during the sleep.",
      result.stoppedDuringRun ? `Automation was STOPPED during the sleep (${result.stoppedDuringRun.by}); nothing here presses, and nothing did.` : "",
      `Run file: ${runFile}.`,
    ];
    result.summary = parts.filter(Boolean).join(" ");
    if (!result.ok) result.reason = `the wake alarm could not be cleared: ${clear.detail}`;
    return result;
  }
}
