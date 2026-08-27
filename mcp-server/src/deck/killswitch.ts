/**
 * The killswitch -- stop every automated press, now, and stay stopped.
 *
 * The rig presses real buttons on a real device. The firmware already has a
 * backstop: 750 ms of silence on the link and the board goes neutral
 * (bridge/firmware/deck_bridge/deck_bridge.ino, WATCHDOG_MS). That covers the
 * host dying. It does not cover a host that is alive, confident, and wrong --
 * which on 2026-08-26 left the ring on a game's Play button, one press from
 * launching it, with no recourse but noticing and stopping by hand.
 *
 * This is the deliberate stop that was missing. Four things, in this order:
 *
 *   1. LATCH OFF, first, before anything else. Not last, as the roadmap listed
 *      it: the latch is what makes every other step stick. Release the buttons
 *      first and an in-flight run can press again a millisecond later, while
 *      the release is still opening the serial port. Setting the latch is one
 *      synchronous write; everything after it happens with the rig already
 *      unable to press.
 *   2. RELEASE whatever the board is holding (pad.py release).
 *   3. ABORT in-flight runs -- which step 1 already did, because every press
 *      and every navigation loop checks the latch. What is left here is
 *      reporting it.
 *   4. TEAR DOWN the SSH tunnels: both the ephemeral CDP forwards that carry
 *      the automation and the ingest reverse tunnel.
 *
 * WHY THE LATCH IS A FILE. There are at least two server processes at any
 * moment: the one the VS Code extension spawns, and the one an agent spawns
 * from mcp.json. They share no memory. A flag inside either one would leave the
 * other pressing buttons, and the process a human can reach -- the extension,
 * via the status bar -- is usually NOT the one driving the Deck. A file in the
 * config directory is the only thing both can see, and it is also the only
 * latch that survives a server restart. A stop that a crash-and-respawn
 * silently clears is not a stop.
 *
 * WHY RE-ARMING IS NOT AN MCP TOOL. Stopping is exposed to agents, because an
 * agent noticing that it should stop is a good thing. Re-arming is not: an
 * agent that hits the latch and can clear it will clear it and carry on, and
 * the latch becomes a speed bump. Re-arming is reachable only over the
 * extension's own dialect (`control/armAutomation` in index.ts), which the MCP
 * surface has no route to. That is enforced by the dispatch, not by asking.
 */
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { getConfigDir, ensureConfigDir } from "../config.js";
import { findPadTool } from "./bridgeTools.js";

/** Who or what asked for the stop. Recorded so a latch is never anonymous. */
export type StopSource = "status-bar" | "command" | "keybinding" | "tool" | "cli" | "unknown";

export interface StopRecord {
  /** ISO timestamp of the stop. */
  at: string;
  by: StopSource;
  reason?: string;
  /** Process that set it, purely for post-mortems. */
  pid: number;
  host: string;
}

export function getLatchPath(): string {
  return path.join(getConfigDir(), "automation-stop.json");
}

function getTunnelDir(): string {
  return path.join(getConfigDir(), "automation-tunnels");
}

/**
 * Is automation latched off, and by whom?
 *
 * Called before every single press and at the top of every navigation loop, so
 * it stays cheap and never throws. A present-but-unreadable latch file counts
 * as STOPPED: the only reason that file exists is that somebody asked for a
 * stop, and resolving the ambiguity in favour of pressing buttons is the wrong
 * way round.
 */
export function automationStopped(): StopRecord | null {
  const file = getLatchPath();
  let raw: string;
  try {
    if (!fs.existsSync(file)) return null;
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null; // the config dir is unreadable entirely -- not a latch
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StopRecord>;
    return {
      at: parsed.at ?? "unknown time",
      by: (parsed.by as StopSource) ?? "unknown",
      reason: parsed.reason,
      pid: Number(parsed.pid ?? 0),
      host: parsed.host ?? "unknown host",
    };
  } catch {
    // Present but unparseable -- caught mid-write, or hand-edited. Still a stop.
    return { at: "unknown time", by: "unknown", pid: 0, host: "unknown host" };
  }
}

/** The refusal every press and every loop hands back. One wording, one place. */
export function stoppedMessage(rec: StopRecord): string {
  return (
    `Deck automation is STOPPED. The killswitch was set at ${rec.at} (${rec.by})` +
    (rec.reason ? `: ${rec.reason}.` : ".") +
    " No press will be delivered until a human re-arms it -- click the Decky automation item" +
    " in the status bar, or run the 'Decky: Arm Deck Automation' command." +
    " Re-arming is deliberately not available as a tool: an agent that can clear its own" +
    " killswitch does not have one."
  );
}

// ---------------------------------------------------------------------------
// Tunnel registry
// ---------------------------------------------------------------------------

export type TunnelKind = "cdp" | "ingest";

export interface TunnelEntry {
  id: string;
  kind: TunnelKind;
  pid: number;
  ownerPid: number;
  since: string;
  detail?: string;
}

/**
 * In-process closers, by id.
 *
 * A tunnel this process opened is closed through its own ChildProcess handle
 * rather than by pid: that runs the owner's own cleanup and leaves the owner's
 * bookkeeping (deck.ts's `tunnelProcess`) consistent instead of pointing at a
 * corpse. Tunnels other processes opened are reachable only by pid.
 */
const localClosers = new Map<string, () => void>();

let idCounter = 0;

/**
 * Record a live SSH tunnel so the killswitch can find it from any process.
 *
 * One file per tunnel rather than one shared list. Two server processes opening
 * tunnels at the same moment would race a read-modify-write on a shared file
 * and silently lose an entry, and an untracked tunnel is exactly the thing that
 * survives a stop.
 */
export function registerTunnel(
  kind: TunnelKind,
  pid: number | undefined,
  detail?: string,
  close?: () => void,
): string {
  const id = `${process.pid}-${Date.now().toString(36)}-${++idCounter}`;
  if (close) localClosers.set(id, close);
  const entry: TunnelEntry = {
    id,
    kind,
    pid: pid ?? 0,
    ownerPid: process.pid,
    since: new Date().toISOString(),
    detail,
  };
  try {
    fs.mkdirSync(getTunnelDir(), { recursive: true });
    fs.writeFileSync(path.join(getTunnelDir(), `${id}.json`), JSON.stringify(entry), "utf8");
  } catch {
    // A tunnel we cannot record is still one the owner closes on its own abort
    // path. Losing the registry entry costs cross-process reach, not
    // correctness, and it must not stop the tunnel from opening.
  }
  return id;
}

export function unregisterTunnel(id: string): void {
  localClosers.delete(id);
  try {
    fs.rmSync(path.join(getTunnelDir(), `${id}.json`), { force: true });
  } catch {
    /* nothing useful to do about it */
  }
}

function readTunnelEntries(): TunnelEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(getTunnelDir());
  } catch {
    return [];
  }
  const out: TunnelEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(getTunnelDir(), name);
    try {
      out.push(JSON.parse(fs.readFileSync(file, "utf8")) as TunnelEntry);
    } catch {
      // Unreadable entry: drop it rather than leave it accumulating forever.
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else. ESRCH means it is gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * How long a registry entry is trusted enough to kill by pid.
 *
 * pids get reused. An entry whose owner died without cleaning up could, given
 * enough time, name a pid the OS has since handed to something unrelated, and
 * killing that would be far worse than leaving a tunnel open. These entries are
 * short-lived by nature -- a CDP forward lives for one run -- so anything this
 * old is stale by definition and gets pruned rather than killed.
 */
const TUNNEL_ENTRY_TTL_MS = 6 * 60 * 60 * 1000;

export interface TunnelKillReport {
  closed: number;
  failed: number;
  stale: number;
  byKind: Record<TunnelKind, number>;
  details: string[];
}

export function killAllTunnels(): TunnelKillReport {
  const report: TunnelKillReport = {
    closed: 0,
    failed: 0,
    stale: 0,
    byKind: { cdp: 0, ingest: 0 },
    details: [],
  };

  for (const entry of readTunnelEntries()) {
    const age = Date.now() - Date.parse(entry.since);
    const label =
      `${entry.kind} tunnel pid ${entry.pid || "?"}` + (entry.detail ? ` (${entry.detail})` : "");

    if (Number.isFinite(age) && age > TUNNEL_ENTRY_TTL_MS) {
      report.stale++;
      report.details.push(
        `${label}: registry entry older than 6h, pruned without killing (the pid may have been reused)`,
      );
      unregisterTunnel(entry.id);
      continue;
    }

    const closer = localClosers.get(entry.id);
    if (closer) {
      try {
        closer();
        report.closed++;
        report.byKind[entry.kind]++;
        report.details.push(`${label}: closed by this process`);
      } catch (err) {
        report.failed++;
        report.details.push(`${label}: close failed -- ${(err as Error).message}`);
      }
      unregisterTunnel(entry.id);
      continue;
    }

    if (!pidAlive(entry.pid)) {
      report.stale++;
      report.details.push(`${label}: already gone`);
      unregisterTunnel(entry.id);
      continue;
    }

    try {
      process.kill(entry.pid);
      report.closed++;
      report.byKind[entry.kind]++;
      report.details.push(`${label}: killed (opened by pid ${entry.ownerPid})`);
      unregisterTunnel(entry.id);
    } catch (err) {
      report.failed++;
      report.details.push(`${label}: could not kill -- ${(err as Error).message}`);
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Releasing the board
// ---------------------------------------------------------------------------

export interface ReleaseReport {
  attempted: boolean;
  ok: boolean;
  detail: string;
}

/**
 * Tell the board to drop every button it is holding.
 *
 * This can legitimately fail, and the honest failure matters more than the
 * happy path. The serial port is exclusive on Windows: if the process that is
 * mid-run still has it open, this cannot get it, and reporting "released" would
 * be a lie about a device holding a button down. When that happens the firmware
 * watchdog is the answer and the report says so -- the latch has already
 * stopped every further command, so the link falls silent and the board
 * neutralises itself within 750 ms.
 */
export function releaseAllButtons(port?: string, timeoutMs = 8000): Promise<ReleaseReport> {
  // The same guard every press honours. Under DPS_NO_BRIDGE this process is not
  // driving the board, so there is nothing of ours to release -- and opening the
  // serial port anyway would take it away from whichever process legitimately
  // has it. It also keeps the test suite from talking to a real board while
  // testing the killswitch, which would be a memorable way to find this out.
  const noBridge = process.env.DPS_NO_BRIDGE;
  if (noBridge && noBridge !== "0" && noBridge.toLowerCase() !== "false") {
    return Promise.resolve({
      attempted: false,
      ok: false,
      detail:
        "DPS_NO_BRIDGE is set, so this process was never driving the board and no release " +
        "was sent. The latch is set regardless, and the firmware neutralises the board 750 ms " +
        "after the link falls silent.",
    });
  }

  const pad = findPadTool();
  if (!pad) {
    return Promise.resolve({
      attempted: false,
      ok: false,
      detail:
        "bridge/tools/pad.py was not found, so no release could be sent. The firmware " +
        "watchdog neutralises the board after 750 ms of silence, and the latch is set, so " +
        "nothing will speak to it again.",
    });
  }

  const args = [pad, "release"];
  const serial = port ?? process.env.DPS_BRIDGE_PORT;
  if (serial) args.push("--port", serial);

  return new Promise<ReleaseReport>((resolve) => {
    let done = false;
    const finish = (r: ReleaseReport): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };

    const child = spawn("python", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (out += d));
    child.stderr?.on("data", (d: string) => (err += d));

    const timer = setTimeout(() => {
      child.kill();
      finish({
        attempted: true,
        ok: false,
        detail:
          `pad.py release did not answer within ${timeoutMs}ms. If a run still holds the ` +
          "serial port that is expected; the board goes neutral 750 ms after the link falls " +
          "silent, which the latch guarantees.",
      });
    }, timeoutMs);

    child.on("error", (e) =>
      finish({ attempted: true, ok: false, detail: `could not run pad.py: ${e.message}` }),
    );

    child.on("close", (code) => {
      const acked = /"t"\s*:\s*"release"|"ok"\s*:\s*true/.test(out);
      if (code === 0 && acked) {
        return finish({ attempted: true, ok: true, detail: "the board acknowledged the release" });
      }
      const detail = (err.trim() || out.trim() || "no output").slice(0, 300);
      finish({
        attempted: true,
        ok: false,
        detail:
          `pad.py release exited ${code}: ${detail}. ` +
          "The board still neutralises itself 750 ms after the link falls silent.",
      });
    });
  });
}

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

export interface StopReport {
  ok: boolean;
  stopped: true;
  /** True when the latch was already set before this call. */
  alreadyStopped: boolean;
  record: StopRecord;
  latchPath: string;
  release: ReleaseReport;
  tunnels: TunnelKillReport;
  summary: string;
}

export interface StopOptions {
  by?: StopSource;
  reason?: string;
  /** Serial port of the bridge's COM side, if not the pad.py default. */
  port?: string;
  /** Skip the tunnel teardown. Tests only -- a real stop takes them down. */
  skipTunnels?: boolean;
}

/**
 * Set the latch, release the board, tear down the tunnels.
 *
 * Safe to call when already stopped. It re-runs the release and the teardown
 * rather than reporting that there was nothing to do, because "I hit it again
 * because I was not sure" has to do the right thing. The original stop record
 * is kept, so the timestamp still says when automation actually stopped.
 */
export async function stopAutomation(opts: StopOptions = {}): Promise<StopReport> {
  const already = automationStopped();

  // Step 1, first and synchronously. From this line on no press can be
  // delivered by any process on this machine: pressButton checks the latch
  // immediately before it spawns, and every navigation loop checks it before it
  // presses again. Everything below happens with the rig already disarmed.
  const record: StopRecord = already ?? {
    at: new Date().toISOString(),
    by: opts.by ?? "unknown",
    reason: opts.reason,
    pid: process.pid,
    host: os.hostname(),
  };
  let latchWritten = true;
  try {
    ensureConfigDir();
    fs.writeFileSync(getLatchPath(), JSON.stringify(record, null, 2), "utf8");
  } catch {
    latchWritten = false;
  }

  const release = await releaseAllButtons(opts.port);
  const tunnels = opts.skipTunnels
    ? { closed: 0, failed: 0, stale: 0, byKind: { cdp: 0, ingest: 0 }, details: ["skipped"] }
    : killAllTunnels();

  const parts = [
    latchWritten
      ? "automation latched OFF -- no press until a human re-arms"
      : `LATCH COULD NOT BE WRITTEN to ${getLatchPath()} -- unplug the board`,
    release.ok
      ? "board released"
      : "board release NOT confirmed; the firmware watchdog neutralises it 750 ms after the link falls silent",
    tunnels.closed || tunnels.failed
      ? `tunnels: ${tunnels.byKind.cdp} cdp + ${tunnels.byKind.ingest} ingest closed` +
        (tunnels.failed ? `, ${tunnels.failed} could NOT be closed` : "")
      : "no live tunnels were registered",
  ];
  if (already) parts.push(`was already stopped since ${already.at} (${already.by})`);

  return {
    ok: latchWritten,
    stopped: true,
    alreadyStopped: Boolean(already),
    record,
    latchPath: getLatchPath(),
    release,
    tunnels,
    summary: parts.join("; "),
  };
}

export interface ArmReport {
  ok: boolean;
  armed: boolean;
  wasStopped: boolean;
  previous: StopRecord | null;
  summary: string;
}

/**
 * Clear the latch. Human-only -- see the header.
 *
 * Nothing here touches the board. Arming means "presses are permitted again",
 * not "press something", and a re-arm that moved the ring would be its own kind
 * of surprise.
 */
export function armAutomation(): ArmReport {
  const previous = automationStopped();
  try {
    fs.rmSync(getLatchPath(), { force: true });
  } catch (err) {
    return {
      ok: false,
      armed: false,
      wasStopped: Boolean(previous),
      previous,
      summary: `could not clear the latch at ${getLatchPath()}: ${(err as Error).message}`,
    };
  }
  return {
    ok: true,
    armed: true,
    wasStopped: Boolean(previous),
    previous,
    summary: previous
      ? `automation re-armed; it had been stopped since ${previous.at} (${previous.by})`
      : "automation was already armed; there was nothing to clear",
  };
}

export interface AutomationStatus {
  armed: boolean;
  stoppedSince: string | null;
  stoppedBy: StopSource | null;
  reason: string | null;
  latchPath: string;
  /** Live tunnels the killswitch would take down, across every process. */
  tunnels: Array<{ kind: TunnelKind; pid: number; ownerPid: number; since: string; alive: boolean }>;
  /** Whether the release step would have a tool to run. */
  padToolFound: boolean;
  summary: string;
}

export function automationStatus(): AutomationStatus {
  const rec = automationStopped();
  const tunnels = readTunnelEntries().map((e) => ({
    kind: e.kind,
    pid: e.pid,
    ownerPid: e.ownerPid,
    since: e.since,
    alive: pidAlive(e.pid),
  }));
  return {
    armed: !rec,
    stoppedSince: rec?.at ?? null,
    stoppedBy: rec?.by ?? null,
    reason: rec?.reason ?? null,
    latchPath: getLatchPath(),
    tunnels,
    padToolFound: findPadTool() !== null,
    summary: rec
      ? `STOPPED since ${rec.at} (${rec.by})${rec.reason ? `: ${rec.reason}` : ""}`
      : `armed -- the rig can press; ${tunnels.length} tunnel(s) registered`,
  };
}
