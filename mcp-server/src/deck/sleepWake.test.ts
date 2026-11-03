/**
 * Tests for deck_sleepAndWake.
 *
 * EVERY SEAM IS FAKED: ssh, the CDP page reads (RunningApps, the route, the
 * suspend call), the focus read, the process check, the clock and the sleep.
 * The fake Deck below answers by the clock: awake until the suspend call, gone
 * a few seconds later, back when its armed alarm comes round plus the 7 s
 * measured on 2026-09-08. No network, no hardware, ever.
 *
 * THE CONFIG DIRECTORY IS REDIRECTED TO A TEMP HOME, as killswitch.test.ts and
 * holdAwake.test.ts do, so the latch files this tool reads are the test's own.
 *
 * WHAT THESE TESTS CANNOT PROVE: that a real Deck goes away when SuspendPC is
 * called, how long it takes, that wakealarm reads back the way the fake does,
 * that SSH comes back inside seconds + 60, or that Steam's CEF answers after a
 * resume. They pin the order of things (arm and read back before anything
 * sleeps, the run file before the suspend, the alarm cleared on every path
 * that can reach the Deck), every refusal, and that nothing is pressed.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const realEnv = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dps-sleepwake-"));
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;

const { runWithMachine } = await import("../machines.js");
const { getLatchPath } = await import("./killswitch.js");
const sw = await import("./sleepWake.js");
const {
  sleepAndWake,
  SUSPEND_EXPR,
  SUSPEND_RESULT_EXPR,
  armCommand,
  CLEAR_COMMAND,
  INHIBITOR_LIST_COMMAND,
  sshArgs,
  parseArmOutput,
  parseBlockSleepInhibitors,
  judgeAlarmFired,
  compareFocus,
  focusSnapshot,
  sleepWakeDeadlineMs,
} = sw;
type Machine = import("../machines.js").Machine;
type ReadFocusResult = import("./readFocus.js").ReadFocusResult;
type ProcessCheck = import("./gameSession.js").ProcessCheck;
type ShellResult = import("./sleepWake.js").ShellResult;

const here = path.dirname(fileURLToPath(import.meta.url));

before(() => {
  assert.ok(getLatchPath().startsWith(tempHome), `latch escaped the sandbox: ${getLatchPath()}`);
});
beforeEach(() => {
  fs.rmSync(getLatchPath(), { force: true });
  fs.rmSync(getLatchPath("deck"), { force: true });
});
after(() => {
  process.env.USERPROFILE = realEnv.USERPROFILE;
  process.env.HOME = realEnv.HOME;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

const DECK: Machine = { name: "deck", kind: "deck", os: "steamos", local: false, host: "203.0.113.9", user: "deck", press: "bridge" };

function ring(label: string, selector: string, verdict: "visible" | "covered" = "visible"): ReadFocusResult {
  return {
    ok: true,
    fidelity: "steam-owned",
    method: "fake",
    target: { title: "QuickAccess_uid2", url: "" },
    steamBuild: null,
    gpfocus: {
      selector,
      selectorVerified: true,
      tag: "BUTTON",
      id: null,
      classes: [],
      ariaLabel: null,
      text: label,
      ownerText: "",
      label,
      rect: { x: 0, y: 0, w: 10, h: 10 },
    },
    visibility: {
      verdict,
      visiblePercent: verdict === "visible" ? 100 : 22,
      coveredBy: verdict === "covered" ? "div.bonsai-main-tab-dock" : null,
      clippedBy: null,
      points: { visible: verdict === "visible" ? 9 : 2, covered: verdict === "covered" ? 7 : 0, clipped: 0, offscreen: 0 },
    },
    scrollPane: null,
    gpfocusWithin: [],
    activeElement: null,
    agree: true,
    deckyPluginRoot: true,
    deckyPanelLabels: ["bonsAI"],
    quickAccessTab: "999",
    visibleQuickAccessTab: "999",
    targetsScanned: [],
  } as unknown as ReadFocusResult;
}

const NO_RING = { ok: false, reason: "gpfocus marker not found", gpfocus: null, target: null } as unknown as ReadFocusResult;

const OUR_LOCK = "sleep 1800     0    root 4242   systemd-inhibit sleep DPS-HOLD-AWAKE: run 12    block";
const DELAY_LOCKS =
  "WHO            UID  USER PID  COMM           WHAT     WHY                                       MODE\n" +
  "NetworkManager 0    root 901  NetworkManager sleep    NetworkManager needs to turn off networks delay\n" +
  "UPower         0    root 955  upowerd        sleep    Pause device polling                      delay\n" +
  "Steam          1000 deck 2103 steam          handle-power-key Steam handles the power key       block\n";

interface FakeOpts {
  running?: Array<{ appid: number; display_name: string }>;
  runningUnreadable?: boolean;
  process?: ProcessCheck;
  inhibitors?: string;
  inhibitorRc?: number;
  /** Added to the alarm the fake rtcwake sets: a disagreeing read-back. */
  armDriftS?: number;
  /** rtcwake's output when it fails, e.g. sudo's password line. */
  armFails?: string;
  /** Does SSH stop answering after the suspend call? */
  suspends?: boolean;
  comesBack?: boolean;
  suspendCallMissing?: boolean;
  focusBefore?: ReadFocusResult;
  focusAfter?: ReadFocusResult;
  routeBefore?: string;
  routeAfter?: string;
  clearFails?: boolean;
  uptimeAfter?: string;
  journal?: string;
  /** Clock jump inside runsDir(), i.e. between the arm and the suspend. */
  jumpBeforeSuspendMs?: number;
  /** runsDir() returns a path that cannot be written. */
  runsDirBroken?: boolean;
  /** The Deck wakes this long after the suspend call, before its alarm (the power button). */
  wokeEarlyMs?: number;
  /** Write a stop latch while the Deck sleeps. */
  stopDuringSleep?: boolean;
}

const DECK_EPOCH0 = 1_790_000_000;

function fakeDeck(o: FakeOpts = {}) {
  const state = {
    clock: 0,
    alarm: null as number | null,
    alarmFired: false,
    wakeAlarm: null as number | null,
    suspendCalledAt: null as number | null,
    commands: [] as string[],
    expressions: [] as string[],
    cdpOpens: 0,
    cdpResets: 0,
    runFileAtSuspend: null as Record<string, unknown> | null,
    runsDir: fs.mkdtempSync(path.join(tempHome, "runs-")),
  };
  const deckNow = () => DECK_EPOCH0 + Math.floor(state.clock / 1000);
  const suspends = o.suspends ?? true;
  const comesBack = o.comesBack ?? true;

  /**
   * Awake until 3 s after the suspend call; then asleep until the alarm armed
   * at that moment comes round (or until wokeEarlyMs, a thumb on the power
   * button); then 7 s more before SSH answers, as measured 2026-09-08. A fired
   * alarm is dropped, as the kernel drops it.
   */
  const alive = (): boolean => {
    if (state.suspendCalledAt === null || !suspends) return true;
    if (state.clock < state.suspendCalledAt + 3_000) return true;
    if (!comesBack || state.wakeAlarm === null) return false;
    const early = o.wokeEarlyMs !== undefined;
    const wakeAtMs = early ? state.suspendCalledAt + o.wokeEarlyMs! : (state.wakeAlarm - DECK_EPOCH0) * 1000;
    if (state.clock < wakeAtMs) return false;
    if (!early && !state.alarmFired) {
      state.alarmFired = true;
      state.alarm = null;
    }
    return state.clock >= wakeAtMs + 7_000;
  };

  const ssh = async (command: string): Promise<ShellResult> => {
    state.commands.push(command);
    if (!alive()) return { status: 255, stdout: "", stderr: "ssh: connect to host 203.0.113.9 port 22: Connection timed out" };
    if (command === "true") return { status: 0, stdout: "", stderr: "" };
    if (command.includes("systemd-inhibit --list")) {
      return { status: 0, stdout: `${o.inhibitors ?? DELAY_LOCKS}\nrc=${o.inhibitorRc ?? 0}\n`, stderr: "" };
    }
    if (command.includes("rtcwake -m no")) {
      const secs = Number(/-s (\d+)/.exec(command)![1]);
      if (o.armFails) {
        return { status: 0, stdout: `---DPS-SW-PRE---\n\n---DPS-SW-RUN---\n${o.armFails}\nrc=1\n---DPS-SW-READ---\n\n---DPS-SW-NOW---\n${deckNow()}\n`, stderr: "" };
      }
      state.alarm = deckNow() + secs + (o.armDriftS ?? 0);
      return {
        status: 0,
        stdout:
          `---DPS-SW-PRE---\n\n---DPS-SW-RUN---\nrtcwake: wakeup using /dev/rtc0 at Thu Sep 18 18:45:36 2026\nrc=0\n` +
          `---DPS-SW-READ---\n${state.alarm}\n---DPS-SW-NOW---\n${deckNow()}\n`,
        stderr: "",
      };
    }
    if (command.includes("rtcwake -m disable")) {
      const pre = state.alarm === null ? "" : String(state.alarm);
      if (o.clearFails) {
        return { status: 0, stdout: `---DPS-SW-PRE---\n${pre}\n---DPS-SW-RUN---\nsudo: a password is required\nrc=1\n---DPS-SW-READ---\n${pre}\n`, stderr: "" };
      }
      state.alarm = null;
      return { status: 0, stdout: `---DPS-SW-PRE---\n${pre}\n---DPS-SW-RUN---\nrc=0\n---DPS-SW-READ---\n\n`, stderr: "" };
    }
    if (command.includes("uptime -s")) {
      const up = state.suspendCalledAt !== null && o.uptimeAfter ? o.uptimeAfter : "2026-09-18 09:00:00";
      return { status: 0, stdout: `---DPS-SW-UP---\n${up}\n---DPS-SW-NOW---\n${deckNow()}\n`, stderr: "" };
    }
    if (command.includes("journalctl")) {
      return {
        status: 0,
        stdout:
          o.journal ??
          "2026-09-18T18:44:01+0100 steamdeck systemd-logind[811]: The system will suspend now!\n" +
            "2026-09-18T18:44:02+0100 steamdeck kernel: PM: suspend entry (deep)\n" +
            "2026-09-18T18:45:36+0100 steamdeck kernel: PM: suspend exit\n",
        stderr: "",
      };
    }
    return { status: 1, stdout: "", stderr: `fake deck does not know: ${command}` };
  };

  const page = (value: unknown, ok = true) => ({ ok, value, reason: ok ? undefined : "fake read failed", target: null, targetsScanned: [], durationMs: 1 });
  const readPageFn = async (opts: { expression: string }) => {
    state.expressions.push(opts.expression);
    if (opts.expression === SUSPEND_EXPR) {
      if (o.suspendCallMissing) return page({ ok: false, reason: "SteamClient.System.SuspendPC is not available" });
      state.suspendCalledAt = state.clock;
      state.wakeAlarm = state.alarm;
      const files = fs.readdirSync(state.runsDir).filter((f) => f.startsWith("sleep-wake_") && f.endsWith(".json"));
      state.runFileAtSuspend = files.length ? JSON.parse(fs.readFileSync(path.join(state.runsDir, files[0]), "utf8")) : null;
      return page({ ok: true });
    }
    if (opts.expression === SUSPEND_RESULT_EXPR) {
      return page({ scheduledAt: 1, calledAt: 2, returned: null, error: "Access denied due to active block inhibitor" });
    }
    if (opts.expression.includes("RunningApps")) {
      return o.runningUnreadable ? page(null, false) : page(o.running ?? []);
    }
    if (opts.expression.includes("m_history")) {
      return page(state.suspendCalledAt === null ? (o.routeBefore ?? "/library/home") : (o.routeAfter ?? o.routeBefore ?? "/library/home"));
    }
    return page(null, false);
  };

  const deps = {
    ssh,
    openCdp: async () => {
      state.cdpOpens++;
      return "http://127.0.0.1:9";
    },
    resetCdp: () => {
      state.cdpResets++;
    },
    readPageFn,
    readFocusFn: async () =>
      state.suspendCalledAt === null ? (o.focusBefore ?? ring("Ask", "#bonsai-ask")) : (o.focusAfter ?? o.focusBefore ?? ring("Ask", "#bonsai-ask")),
    processCheckFn: () => o.process ?? ({ checked: true, processes: [], how: "pgrep (fake)" } as ProcessCheck),
    now: () => state.clock,
    sleep: async (ms: number) => {
      state.clock += ms;
      if (o.stopDuringSleep && state.suspendCalledAt !== null && !fs.existsSync(getLatchPath())) {
        fs.mkdirSync(path.dirname(getLatchPath()), { recursive: true });
        fs.writeFileSync(getLatchPath(), JSON.stringify({ at: "now", by: "status-bar", pid: 1, host: "pc" }));
      }
    },
    runsDir: () => {
      state.clock += o.jumpBeforeSuspendMs ?? 0;
      if (o.runsDirBroken) {
        const blocker = path.join(state.runsDir, "not-a-dir");
        fs.writeFileSync(blocker, "x");
        return path.join(blocker, "sub");
      }
      return state.runsDir;
    },
  };
  return { state, deps };
}

function go(m: Machine, opts: Record<string, unknown>, deps: Record<string, unknown> = {}) {
  return runWithMachine(m, () => sleepAndWake({ ...(deps as object), ...(opts as object) } as Parameters<typeof sleepAndWake>[0]));
}

const suspendCalls = (s: { expressions: string[] }) => s.expressions.filter((e) => e === SUSPEND_EXPR).length;
const armCalls = (s: { commands: string[] }) => s.commands.filter((c) => c.includes("rtcwake -m no")).length;
const clearCalls = (s: { commands: string[] }) => s.commands.filter((c) => c.includes("rtcwake -m disable")).length;

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

test("the arm command uses sudo -n rtcwake -m no, reads the alarm back, and reads the Deck's own clock", () => {
  const c = armCommand(90);
  assert.match(c, /sudo -n rtcwake -m no -s 90/);
  assert.match(c, /cat \/sys\/class\/rtc\/rtc0\/wakealarm/);
  assert.match(c, /date \+%s/, "compared with the Deck's clock, not this PC's");
  assert.ok(!c.includes('"'), "no double quotes: the command travels as one ssh argument");
  assert.match(CLEAR_COMMAND, /sudo -n rtcwake -m disable/);
  assert.match(INHIBITOR_LIST_COMMAND, /systemd-inhibit --list/);
});

test("the liveness probe opens a fresh connection, so a shared ssh master cannot answer for a sleeping Deck", () => {
  const fresh = sshArgs("deck", "203.0.113.9", "true", 3, true);
  assert.ok(fresh.includes("ControlMaster=no") && fresh.includes("ControlPath=none"));
  assert.ok(fresh.includes("BatchMode=yes"));
  assert.equal(fresh[fresh.length - 1], "true");
  assert.ok(!sshArgs("deck", "h", "true", 5, false).includes("ControlPath=none"));
});

test("parseArmOutput accepts a read-back within 5 s and refuses one an hour off", () => {
  const ok = parseArmOutput(`---DPS-SW-PRE---\n\n---DPS-SW-RUN---\nrc=0\n---DPS-SW-READ---\n1790000090\n---DPS-SW-NOW---\n1790000001\n`, 90);
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.driftS, -1);
  const off = parseArmOutput(`---DPS-SW-PRE---\n\n---DPS-SW-RUN---\nrc=0\n---DPS-SW-READ---\n1790003690\n---DPS-SW-NOW---\n1790000000\n`, 90);
  assert.equal(off.ok, false);
  assert.match(off.reason!, /3600 s apart/);
  const empty = parseArmOutput(`---DPS-SW-PRE---\n\n---DPS-SW-RUN---\nrc=0\n---DPS-SW-READ---\n\n---DPS-SW-NOW---\n1790000000\n`, 90);
  assert.equal(empty.ok, false);
  assert.match(empty.reason!, /did not read back an epoch/);
});

test("only a BLOCK lock on sleep refuses a suspend; delay locks and other block locks do not", () => {
  assert.deepEqual(parseBlockSleepInhibitors(DELAY_LOCKS), []);
  assert.deepEqual(parseBlockSleepInhibitors(`${DELAY_LOCKS}${OUR_LOCK}\n`), [OUR_LOCK]);
  const shutdownSleep = "someone 0 root 7 thing shutdown:sleep keep it up block";
  assert.deepEqual(parseBlockSleepInhibitors(shutdownSleep), [shutdownSleep]);
});

test("alarmFired: empty after its time is fired, the epoch still there is not, anything else unknown", () => {
  assert.equal(judgeAlarmFired("", 1790000090, 1790000091), true);
  assert.equal(judgeAlarmFired("1790000090", 1790000090, 1790000080), false);
  assert.equal(judgeAlarmFired("", 1790000090, 1790000000), "unknown");
  assert.equal(judgeAlarmFired(undefined, 1790000090, 1790000091), "unknown");
  assert.equal(judgeAlarmFired("", null, 1790000091), "unknown");
});

test("compareFocus: same ring is unmoved, a different or lost ring is moved, two missing rings are unknown", () => {
  const a = focusSnapshot(ring("Ask", "#a"));
  const b = focusSnapshot(ring("Retry", "#b"));
  const none = focusSnapshot(NO_RING);
  assert.equal(compareFocus(a, focusSnapshot(ring("Ask", "#a"))).moved, false);
  assert.equal(compareFocus(a, b).moved, true);
  assert.equal(compareFocus(a, none).moved, true);
  assert.equal(compareFocus(none, none).moved, "unknown");
});

test("the deadline is seconds + 180 s by default, and a shorter requested one is refused", () => {
  assert.equal(sleepWakeDeadlineMs(90, 600_000, "default"), 270_000);
  assert.equal(sleepWakeDeadlineMs(600, 600_000, "default"), 780_000, "past the 10-minute driving default");
  assert.equal(sleepWakeDeadlineMs(90, 400_000, "requested"), 400_000);
  assert.throws(() => sleepWakeDeadlineMs(90, 120_000, "requested"), /at least 270000 ms/);
});

test("the tool is a driving tool at the seam, and this module cannot press", () => {
  const index = fs.readFileSync(path.join(here, "..", "index.ts"), "utf8");
  const driving = index.slice(index.indexOf("const DRIVING_TOOLS"), index.indexOf("]);", index.indexOf("const DRIVING_TOOLS")));
  assert.match(driving, /"deck_sleepAndWake"/, "the lease, the queue and the pad release come from DRIVING_TOOLS");
  const src = fs.readFileSync(path.join(here, "sleepWake.ts"), "utf8");
  assert.ok(!/from "\.\/(pressButton|padClient|openPlugin|walkTo|runSequence)\.js"/.test(src), "sleepWake.ts must not import anything that presses");
});

// ---------------------------------------------------------------------------
// Refusals: nothing armed, nothing slept
// ---------------------------------------------------------------------------

test("a stand-in is refused before anything else -- no ssh, no CDP", async () => {
  const f = fakeDeck();
  const standin: Machine = { name: "vm1", kind: "standin", os: "bazzite", local: false, host: "10.0.0.5", user: "deck", press: "uinput" };
  const r = await go(standin, { seconds: 10 }, f.deps); // bad seconds too: the machine is checked first
  assert.equal(r.ok, false);
  assert.match(r.reason!, /stand-in/);
  assert.equal(f.state.commands.length + f.state.cdpOpens, 0);
});

test("a Windows machine and a local server are refused before anything else", async () => {
  const f = fakeDeck();
  const win = await go({ ...DECK, name: "this-pc", os: "windows", local: true }, { seconds: 90 }, f.deps);
  assert.match(win.reason!, /runs windows/);
  const local = await go({ ...DECK, local: true }, { seconds: 90 }, f.deps);
  assert.match(local.reason!, /local/);
  assert.equal(f.state.commands.length + f.state.cdpOpens, 0);
});

test("seconds under 45, over 600 or missing are refused", async () => {
  for (const seconds of [44, 601, Number.NaN]) {
    const f = fakeDeck();
    const r = await go(DECK, { seconds }, f.deps);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /between 45 and 600/);
    assert.equal(armCalls(f.state) + suspendCalls(f.state), 0);
  }
});

test('via "power-menu" is accepted by the shape and refuses as not implemented', async () => {
  const f = fakeDeck();
  const r = await go(DECK, { seconds: 90, via: "power-menu" }, f.deps);
  assert.equal(r.ok, false);
  assert.equal(r.via, "power-menu");
  assert.match(r.reason!, /not implemented this lane/);
  assert.equal(f.state.commands.length, 0);
});

test("a set killswitch refuses", async () => {
  fs.mkdirSync(path.dirname(getLatchPath()), { recursive: true });
  fs.writeFileSync(getLatchPath(), JSON.stringify({ at: "2026-11-02T10:00:00Z", by: "status-bar", pid: 1, host: "pc" }));
  const f = fakeDeck();
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /STOPPED/);
  assert.equal(armCalls(f.state) + suspendCalls(f.state), 0);
});

test("a game in RunningApps refuses and points at deck_exitGame", async () => {
  const f = fakeDeck({ running: [{ appid: 1794680, display_name: "Vampire Survivors" }] });
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /Vampire Survivors/);
  assert.match(r.reason!, /deck_exitGame/);
  assert.equal(armCalls(f.state) + suspendCalls(f.state), 0);
});

test("an unreadable RunningApps refuses: unknown is never a pass", async () => {
  const f = fakeDeck({ runningUnreadable: true });
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.match(r.reason!, /cannot be ruled out/);
  assert.equal(armCalls(f.state), 0);
});

test("an empty RunningApps with a live game process refuses, as exitGame does", async () => {
  const f = fakeDeck({ process: { checked: true, processes: [{ pid: 4242, appid: 362890, command: "reaper SteamLaunch AppId=362890 -- ..." }], how: "pgrep (fake)" } });
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.match(r.reason!, /pid 4242/);
  assert.equal(armCalls(f.state), 0);
});

test("a process check that could not be made refuses", async () => {
  const f = fakeDeck({ process: { checked: false, skipped: false, reason: "ssh exit 255" } });
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.match(r.reason!, /could not be asked/);
  assert.equal(armCalls(f.state), 0);
});

test("deck_holdAwake's inhibitor refuses, says logind would refuse, and names deck_restorePowerSettings", async () => {
  const f = fakeDeck({ inhibitors: `${DELAY_LOCKS}${OUR_LOCK}` });
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /logind would refuse the suspend/);
  assert.match(r.reason!, /deck_holdAwake's lock; release it with deck_restorePowerSettings/);
  assert.equal(armCalls(f.state) + suspendCalls(f.state), 0);
});

test("somebody else's block lock on sleep refuses too, and an unreadable list refuses", async () => {
  const other = await go(DECK, { seconds: 90 }, fakeDeck({ inhibitors: "gamescope 1000 deck 77 gamescope sleep recording block" }).deps);
  assert.match(other.reason!, /whoever took it/);
  const unread = await go(DECK, { seconds: 90 }, fakeDeck({ inhibitors: "Failed to connect to bus", inhibitorRc: 1 }).deps);
  assert.match(unread.reason!, /did not answer/);
});

test("an alarm that reads back wrong refuses WITHOUT sleeping, and is cleared", async () => {
  const f = fakeDeck({ armDriftS: 3600 }); // an RTC kept in local time, say
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /the way back is not proven/);
  assert.equal(suspendCalls(f.state), 0, "nothing may sleep on an unproven way back");
  assert.equal(clearCalls(f.state), 1);
  assert.equal(r.alarmCleared, true);
  assert.equal(f.state.alarm, null);
  assert.equal(r.runFile, null, "refused before the run file");
});

test("rtcwake asking for a password refuses and says what sudo rule is needed", async () => {
  const f = fakeDeck({ armFails: "sudo: a password is required" });
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.match(r.reason!, /NOPASSWD/);
  assert.equal(suspendCalls(f.state), 0);
});

test("a run file that cannot be written refuses before the suspend, and clears the alarm", async () => {
  const f = fakeDeck({ runsDirBroken: true });
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.match(r.reason!, /run file could not be written/);
  assert.equal(suspendCalls(f.state), 0);
  assert.equal(f.state.alarm, null);
});

test("too little left on the alarm at the suspend refuses and clears it", async () => {
  const f = fakeDeck({ jumpBeforeSuspendMs: 20_000 });
  const r = await go(DECK, { seconds: 45 }, f.deps);
  assert.match(r.reason!, /left on the alarm/);
  assert.equal(suspendCalls(f.state), 0);
  assert.equal(f.state.alarm, null);
});

test("Steam without SuspendPC refuses and clears the alarm", async () => {
  const f = fakeDeck({ suspendCallMissing: true });
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.match(r.reason!, /SuspendPC is not available/);
  assert.equal(r.suspended, null);
  assert.equal(f.state.alarm, null);
});

// ---------------------------------------------------------------------------
// The runs
// ---------------------------------------------------------------------------

test("never suspended: SSH keeps answering, so suspended:false, the alarm is cleared, and it stops", async () => {
  const f = fakeDeck({ suspends: false });
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.equal(r.ok, false);
  assert.equal(r.suspended, false);
  assert.equal(r.back, null, "it never waited for a way back");
  assert.equal(r.alarmCleared, true);
  assert.equal(f.state.alarm, null);
  assert.match(r.summary, /suspended: false/);
  assert.match(r.summary, /Access denied due to active block inhibitor/, "what Steam's call left is reported");
  assert.ok(f.state.clock <= 32_000, `gave up at ${f.state.clock} ms; must be about 30 s`);
  assert.ok(r.runFile && fs.existsSync(r.runFile));
  assert.equal(JSON.parse(fs.readFileSync(r.runFile, "utf8")).suspended, false);
});

test("came back: armed and read back first, run file before the suspend, focus read with no press, alarm cleared", async () => {
  const f = fakeDeck();
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.via, "steam-suspend-call");
  assert.equal(r.fidelity, null, "a CDP call, not a press");
  assert.equal(r.presses, 0);
  assert.equal(r.suspended, true);
  assert.equal(r.back, true);

  // The order: arm before the suspend, and the run file on disk at the suspend.
  const armIdx = f.state.commands.findIndex((c) => c.includes("rtcwake -m no"));
  assert.ok(armIdx >= 0);
  assert.ok(f.state.runFileAtSuspend, "the run file must exist when SuspendPC is called");
  const atSuspend = f.state.runFileAtSuspend as { before: { focus: { label: string } }; alarm: { ok: boolean } };
  assert.equal(atSuspend.before.focus.label, "Ask");
  assert.equal(atSuspend.alarm.ok, true);

  assert.equal(suspendCalls(f.state), 1);
  assert.ok(r.sshBackAfterMs! >= 90_000 && r.sshBackAfterMs! <= 90_000 + 60_000, `back after ${r.sshBackAfterMs} ms`);
  assert.ok(r.suspendedForMs! > 0 && r.suspendedForMs! < r.sshBackAfterMs!);
  assert.equal(f.state.cdpResets, 1, "a fresh CDP tunnel on the way back");
  assert.equal(r.before!.focus!.label, "Ask");
  assert.equal(r.after!.focus!.label, "Ask");
  assert.equal(r.after!.focus!.visibility!.verdict, "visible");
  assert.equal(r.focusMoved, false);
  assert.equal(r.routeChanged, false);
  assert.equal(r.killswitchSurvived, true);
  assert.equal(r.rebooted, false);
  assert.equal(r.alarmFired, true);
  assert.equal(r.alarmCleared, true);
  assert.equal(clearCalls(f.state), 1, "cleared once, at the end");
  assert.equal(r.suspendSeenBy, "ssh+journal");
  assert.match(r.journal!.suspendLine!, /will suspend now/);
  assert.match(r.journal!.resumeLine!, /suspend exit/);
  assert.equal(r.stoppedDuringRun, null);

  const saved = JSON.parse(fs.readFileSync(r.runFile!, "utf8"));
  assert.equal(saved.after.focus.label, "Ask");
  assert.equal(saved.back, true);
  assert.match(r.summary, /slept and came back/);
});

test("focus back somewhere else is reported plainly, and nothing is pressed to fix it", async () => {
  const f = fakeDeck({ focusAfter: ring("Retry", "#bonsai-retry", "covered"), routeAfter: "/library/home?x" });
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.equal(r.ok, true, "a moved ring is a finding, not a failed run");
  assert.equal(r.focusMoved, true);
  assert.match(r.focusReport!, /FOCUS CAME BACK SOMEWHERE ELSE/);
  assert.match(r.focusReport!, /"Ask"/);
  assert.match(r.focusReport!, /"Retry"/);
  assert.match(r.summary, /COVERED by div\.bonsai-main-tab-dock/);
  assert.match(r.summary, /Nothing was pressed to put it back/);
  assert.equal(r.routeChanged, true);
  assert.equal(r.presses, 0);
  assert.equal(suspendCalls(f.state), 1);
  const afterSuspend = f.state.expressions.slice(f.state.expressions.indexOf(SUSPEND_EXPR) + 1);
  assert.ok(afterSuspend.every((e) => e !== SUSPEND_EXPR), "only reads after the wake");
});

test("a ring that cannot be read after the wake is reported as moved, not as unchanged", async () => {
  const f = fakeDeck({ focusAfter: NO_RING });
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.equal(r.focusMoved, true);
  assert.match(r.focusReport!, /no ring/);
});

test("never back within seconds + 60: back:false, no clear attempted, and the human is told to press power", async () => {
  const f = fakeDeck({ comesBack: false });
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.equal(r.ok, false);
  assert.equal(r.suspended, true);
  assert.equal(r.back, false);
  assert.equal(r.alarmCleared, null);
  assert.equal(clearCalls(f.state), 0);
  assert.match(r.summary, /press the power button/);
  assert.ok(f.state.clock <= 90_000 + 60_000 + 3_000, `waited ${f.state.clock} ms`);
  assert.equal(JSON.parse(fs.readFileSync(r.runFile!, "utf8")).back, false);
});

test("woken early with the alarm still armed: alarmFired false, and a clear that fails makes the run ok:false", async () => {
  const f = fakeDeck({ wokeEarlyMs: 40_000, clearFails: true });
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.equal(r.back, true);
  assert.equal(r.alarmFired, false, "the epoch was still in wakealarm, so something else woke it");
  assert.equal(r.alarmCleared, false);
  assert.equal(r.ok, false, "a run that leaves the alarm armed has left the Deck changed");
  assert.match(r.summary, /THE ALARM IS STILL ARMED/);
  assert.match(r.reason!, /could not be cleared/);
});

test("cleared is decided by reading wakealarm back, not by rtcwake's exit status", async () => {
  // The alarm fired and the kernel dropped it: rtcwake -m disable failing on
  // sudo changes nothing, the alarm is not armed, and the read-back says so.
  const f = fakeDeck({ clearFails: true });
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.equal(r.alarmFired, true);
  assert.equal(r.alarmCleared, true);
  assert.match(r.alarmClearDetail!, /exit 1/);
});

test("a reboot instead of a resume is named, from uptime -s", async () => {
  const f = fakeDeck({ uptimeAfter: "2026-09-18 18:45:30" });
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.equal(r.rebooted, true);
  assert.match(r.summary, /REBOOTED/);
});

test("a stop set while the Deck slept is recorded, and the latch files are reported changed", async () => {
  const f = fakeDeck({ stopDuringSleep: true });
  const r = await go(DECK, { seconds: 90 }, f.deps);
  assert.ok(r.stoppedDuringRun, "the stop is surfaced");
  assert.equal(r.killswitchSurvived, false);
  assert.equal(r.presses, 0);
  assert.match(r.summary, /STOPPED during the sleep/);
});
