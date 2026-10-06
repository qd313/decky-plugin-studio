import { execSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { getIngestPort } from "../ingest/server.js";
import { readDeckEnv, getWorkspaceRoot } from "../config.js";
import {
  detectLocalSteamOs,
  getHomebrewPluginsDir,
  restartLoaderLocal,
  waitForLoaderReadyLocal,
  LocalLoaderReadiness,
} from "../deploy/local.js";
import { sshRestartLoader, waitForLoaderReady, LoaderReadiness } from "../deploy/deployHelpers.js";
import { detectPlugin } from "./plugin.js";
import { getTunnelState, pingDeck } from "./deck.js";
import { bridgeDisabled, findPadTool } from "../deck/pressButton.js";
import {
  currentMachine,
  DEFAULT_CDP_PORT,
  DEFAULT_PAD_PORT,
  DEFAULT_SSH_USER,
  hostIsSteamOsLike,
  labelOf,
  Machine,
} from "../machines.js";
import { openPadEndpoint } from "../deck/cdpTunnel.js";
import { padStatus, PadEndpoint, PadExchange } from "../deck/padClient.js";

function shellCmd(): string {
  return process.platform === "win32" ? "cmd.exe" : "/bin/sh";
}

function execQuiet(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], shell: shellCmd() }).trim();
  } catch {
    return "";
  }
}

export async function reloadPlugin(
  mode: "auto" | "local" | "remote" = "auto",
  opts: { waitForLoader?: boolean; loaderTimeoutMs?: number } = {}
): Promise<{ ok: boolean; mode: string; method: string; loader?: LoaderReadiness | LocalLoaderReadiness | null }> {
  // Local or remote is the current machine's `local` flag (machines.ts), not
  // a guess from the host's /etc/os-release. An explicit mode still wins.
  const m = currentMachine();
  let deployMode = mode;
  if (mode === "auto") deployMode = m.local ? "local" : "remote";

  if (deployMode === "local") {
    const method = await restartLoaderLocal(undefined, m);
    const loader =
      opts.waitForLoader === false
        ? null
        : await waitForLoaderReadyLocal({
            cdpBase: `http://127.0.0.1:${m.cdpPort ?? DEFAULT_CDP_PORT}`,
            timeoutMs: opts.loaderTimeoutMs,
          });
    return { ok: true, mode: "local", method, loader };
  }

  const host = m.host;
  const user = m.user ?? DEFAULT_SSH_USER;
  if (!host) throw new Error("DECK_IP not configured — run deck.configure first");

  sshRestartLoader(user, host);
  // Same restart as deck_deploy, same window after it (issue #3): return
  // when the Deck is usable again, and say so if the deadline passed.
  const loader =
    opts.waitForLoader === false
      ? null
      : await waitForLoaderReady(user, host, { timeoutMs: opts.loaderTimeoutMs });
  return { ok: true, mode: "remote", method: `ssh ${user}@${host} plugin_loader restart`, loader };
}

export function openPlugin(): {
  ok: boolean;
  pluginName: string;
  actionRequired: boolean;
  checklist: string[];
  note: string;
} {
  const info = detectPlugin();
  if (!info.valid) throw new Error(info.reason ?? "Invalid plugin workspace");

  const pluginName = String(info.name);
  return {
    ok: true,
    pluginName,
    actionRequired: true,
    checklist: [
      "On the Deck, open Quick Access Menu (QAM)",
      "Open Decky Loader",
      `Open the "${pluginName}" plugin panel`,
      "Keep the plugin panel visible for deck.captureScreenshot / deck.record",
    ],
    note: "Deck UI cannot be automated in v1; follow the checklist manually.",
  };
}

function fetchJournalText(local: boolean, user: string, host: string, maxLines: number): string {
  const n = Math.min(Math.max(1, maxLines), 500);
  const journalCmd = `journalctl --user -u plugin_loader.service -n ${n} --no-pager 2>/dev/null || journalctl -u plugin_loader.service -n ${n} --no-pager 2>/dev/null || true`;

  if (local) {
    return execQuiet(journalCmd);
  }
  return execQuiet(`ssh ${user}@${host} "${journalCmd}"`);
}

function fetchFallbackLogPaths(local: boolean, user: string, host: string): string {
  const paths = [
    "~/homebrew/logs/plugin_loader.log",
    "~/.local/share/decky-loader/logs/plugin_loader.log",
    "/tmp/plugin_loader.log",
  ];
  for (const p of paths) {
    const cmd = local ? `test -f ${p} && tail -n 200 ${p} 2>/dev/null || true` : `ssh ${user}@${host} "test -f ${p} && tail -n 200 ${p} 2>/dev/null || true"`;
    const text = execQuiet(cmd);
    if (text) return text;
  }
  return "";
}

/**
 * The Windows port of Decky Loader has no journal. It writes under
 * <homebrew>/logs; the newest file there is the one to read.
 */
function readWindowsLoaderLog(m: Machine, maxLines: number): { source: string; text: string } {
  const logsDir = path.join(path.dirname(getHomebrewPluginsDir(m)), "logs");
  let newest: { file: string; mtime: number } | null = null;
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0) walk(p, depth - 1);
      else if (e.isFile()) {
        try {
          const mtime = fs.statSync(p).mtimeMs;
          if (!newest || mtime > newest.mtime) newest = { file: p, mtime };
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(logsDir, 2);
  if (!newest) return { source: "none", text: "" };
  const found: { file: string; mtime: number } = newest;
  try {
    const all = fs.readFileSync(found.file, "utf8").split(/\r?\n/);
    return { source: `file:${found.file}`, text: all.slice(-maxLines).join("\n") };
  } catch {
    return { source: "none", text: "" };
  }
}

export function readPluginLog(
  lines = 50,
  filter?: string
): { source: string; text: string } {
  const maxLines = Math.min(Math.max(1, Number(lines) || 50), 500);
  const m = currentMachine();
  const host = m.host;
  const user = m.user ?? DEFAULT_SSH_USER;
  const local = m.local;
  if (!local && !host) throw new Error("DECK_IP not configured — run deck.configure first");

  let source = "journalctl:plugin_loader.service";
  let text = "";
  if (local && m.os === "windows") {
    const w = readWindowsLoaderLog(m, maxLines);
    source = w.source;
    text = w.text;
  } else {
    text = fetchJournalText(local, user, host ?? "127.0.0.1", maxLines);
    if (!text.trim()) {
      text = fetchFallbackLogPaths(local, user, host ?? "127.0.0.1");
      source = "fallback:homebrew/logs";
    }
  }

  if (!text.trim()) {
    return { source: "none", text: "(no plugin_loader log lines found)" };
  }

  const lineList = text.split("\n");
  const trimmed = lineList.slice(-maxLines);

  if (filter && filter.trim()) {
    const needle = filter.trim();
    const filtered = trimmed.filter((line) => line.includes(needle));
    return {
      source: `${source} (filter: ${needle})`,
      text: filtered.join("\n") || "(no lines matched filter)",
    };
  }

  return { source, text: trimmed.join("\n") };
}

const DEFAULT_REMOTE_PROBE_TIMEOUT_MS = 4000;

/**
 * Run one ssh probe command with a hard wall-clock cap. Unlike execQuiet (used
 * for local log reads, where a slow-but-finite command is fine), an ssh call to
 * a wrong/unreachable DECK_IP can block on the OS-level TCP connect timeout for
 * 40s or more with no `timeout` option set. `execSync`'s own `timeout` kills the
 * child and throws once the cap is hit, so callers never wait past `timeoutMs`.
 */
export type Execer = (cmd: string, timeoutMs: number) => { text: string; timedOut: boolean };

export function execWithTimeout(cmd: string, timeoutMs: number): { text: string; timedOut: boolean } {
  try {
    const text = execSync(cmd, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      shell: shellCmd(),
      timeout: timeoutMs,
    }).trim();
    return { text, timedOut: false };
  } catch (err) {
    const timedOut = Boolean(err && typeof err === "object" && (err as { killed?: boolean }).killed);
    return { text: "", timedOut };
  }
}

/**
 * Probe a remote Deck over ssh, bounded by an overall deadline. Each of the
 * three ssh calls is given whatever's left of the budget; if any of them times
 * out (or the budget is already spent), the probe stops immediately and reports
 * `unreachable` rather than pressing on or hanging. This never throws.
 */
export async function probeRemoteDeck(
  user: string,
  host: string,
  opts: { timeoutMs?: number; exec?: Execer } = {}
): Promise<Record<string, string | boolean>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REMOTE_PROBE_TIMEOUT_MS;
  const exec = opts.exec ?? execWithTimeout;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(250, deadline - Date.now());
  const timedOutResult = (): Record<string, string | boolean> => ({
    unreachable: true,
    reason: `ssh probe timed out after ${timeoutMs}ms`,
  });

  const remote: Record<string, string | boolean> = {};

  const osResult = exec(`ssh ${user}@${host} "cat /etc/os-release 2>/dev/null | head -5"`, remaining());
  if (osResult.timedOut || Date.now() >= deadline) return timedOutResult();
  if (osResult.text) remote.osRelease = osResult.text.replace(/\n/g, "; ");

  const deckyResult = exec(`ssh ${user}@${host} "test -d ~/homebrew && echo yes || echo no"`, remaining());
  if (deckyResult.timedOut || Date.now() >= deadline) return timedOutResult();
  remote.homebrewPresent = deckyResult.text || "unknown";

  const loaderResult = exec(
    `ssh ${user}@${host} "systemctl --user is-active plugin_loader.service 2>/dev/null || echo inactive"`,
    remaining()
  );
  if (loaderResult.timedOut) return timedOutResult();
  remote.pluginLoaderActive = loaderResult.text || "unknown";

  return remote;
}

export async function getEnv(): Promise<Record<string, unknown>> {
  const deckEnv = readDeckEnv();
  const workspace = getWorkspaceRoot();
  const plugin = detectPlugin();
  const tunnel = getTunnelState();
  const localOs = detectLocalSteamOs();
  const m = currentMachine();

  const base: Record<string, unknown> = {
    workspaceRoot: workspace,
    // The machine this call is about (plan 10). `deckEnv` below is the raw
    // file, kept for anyone reading it; `machine` is what the tools use.
    machine: {
      ...labelOf(m),
      local: m.local,
      host: m.host ?? null,
      user: m.user ?? DEFAULT_SSH_USER,
      press: m.press,
      bridgePort: m.bridgePort ?? null,
      padPort: m.press === "uinput" || m.press === "vigem" ? m.padPort ?? DEFAULT_PAD_PORT : null,
      cdpPort: m.cdpPort ?? DEFAULT_CDP_PORT,
      pluginsDir: m.pluginsDir ?? null,
      vm: m.vm ?? null,
    },
    deckEnv: {
      DECK_IP: deckEnv.DECK_IP ?? null,
      DECK_USER: deckEnv.DECK_USER ?? "deck",
    },
    plugin: plugin.valid
      ? { name: plugin.name, hasMainPy: plugin.hasMainPy, hasRollup: plugin.hasRollup }
      : { valid: false, reason: plugin.reason },
    tunnel: {
      running: tunnel.running,
      pid: tunnel.pid ?? null,
    },
    ingestPort: getIngestPort(),
    // A fact about THIS host, not about where deploys go (see machines.ts).
    localOs: { isSteamOsLike: localOs.isSteamOsLike, id: localOs.id },
    hostOs: hostIsSteamOsLike(),
    deckReachable: await pingDeck(),
  };

  const host = m.host;
  const user = m.user ?? DEFAULT_SSH_USER;
  if (host && !m.local) {
    // probeRemoteDeck carries its own deadline and never throws or hangs, but
    // the catch stays as a last line of defense: whatever happens to `remote`,
    // the rest of the env report above must still be returned to the caller.
    try {
      base.remote = await probeRemoteDeck(user, host);
    } catch (err) {
      base.remote = { unreachable: true, reason: `SSH probe failed: ${(err as Error).message}` };
    }
  }

  return base;
}

/*
 * Measured, not guessed. On the live rig (2026-08-27) a healthy board answers
 * `pad.py status` in ~3.3s: python startup, then opening the COM port pulls DTR
 * and auto-resets the ESP32, and only then does the 0.5s drain run. The first
 * value here was 3000ms, which timed out roughly 300ms short and reported a
 * board that was plugged in, alive, and answering as `bridgeReady: false` --
 * the exact false-negative deck_status exists to prevent.
 *
 * A missing board does NOT spend this: opening an absent port fails
 * immediately, so the generous deadline only applies when there is real
 * hardware taking real time to wake up.
 */
const DEFAULT_BRIDGE_PROBE_TIMEOUT_MS = 10_000;
/** Matches pad.py's own `--port` default (see bridge/tools/pad.py), used when
 * the user hasn't configured one. */
const DEFAULT_BRIDGE_PORT = "COM7";

export interface BridgeProbeResult {
  /**
   * Does the bridge board's COM port open on THIS PC, and does the firmware
   * answer a status query? That is ALL this measures. It says nothing about
   * whether the board's other USB lead -- the HID side -- reaches the Deck:
   * found 2026-08-27, a board plugged into the PC but unplugged from the Deck
   * still opens its port and still answers, so this was `true` the whole time
   * a live session sat completely unable to move anything.
   */
  bridgePortOpen: boolean;
  /**
   * @deprecated Same value as `bridgePortOpen`, kept only so an existing
   * consumer (bonsAI) reading this field name does not break on a rename. Use
   * `bridgePortOpen` -- the name this alias carries was the false-success bug
   * reported 2026-08-27: a `true` here was read as "the Deck is reachable",
   * which it never meant.
   */
  bridgeReady: boolean;
  port: string;
  reason?: string;
}

/** The serial port deck.pressButton would use, absent a per-call override. */
export function getConfiguredBridgePort(): string {
  try {
    const m = currentMachine();
    if (m.bridgePort) return m.bridgePort;
  } catch {
    /* an unreadable registry falls back to deck.env, the way it always worked */
  }
  const env = readDeckEnv();
  return env.DECK_BRIDGE_PORT?.trim() || DEFAULT_BRIDGE_PORT;
}

export interface VirtualPadProbe {
  /** Did vpad.py answer a status query? */
  reachable: boolean;
  endpoint?: string;
  backend?: string;
  /** Buttons the pad is holding right now. Non-empty while a run is mid-press. */
  held?: string[];
  watchdogTripped?: boolean;
  reason?: string;
}

/**
 * Ask a stand-in's virtual gamepad daemon to report in (plan 10). Reads
 * only: `status` writes nothing to the device. A missing daemon is a
 * reportable status, not an error, exactly like a missing board.
 */
export async function probeVirtualPad(
  m: Machine,
  opts: { endpoint?: () => Promise<PadEndpoint>; status?: (ep: PadEndpoint) => Promise<PadExchange> } = {}
): Promise<VirtualPadProbe> {
  const disabledReason = bridgeDisabled();
  if (disabledReason) return { reachable: false, reason: disabledReason };
  let ep: PadEndpoint;
  try {
    ep = await (opts.endpoint ?? openPadEndpoint)();
  } catch (err) {
    return { reachable: false, reason: `no channel to the virtual pad on "${m.name}": ${(err as Error).message}` };
  }
  const endpoint = `${ep.host}:${ep.port}`;
  const x = await (opts.status ?? padStatus)(ep);
  if (!x.ack?.ok) {
    return {
      reachable: false,
      endpoint,
      reason:
        x.failure ??
        x.ack?.err ??
        `vpad.py did not answer on ${endpoint}; start it on "${m.name}" with "python3 bridge/tools/vpad.py serve"`,
    };
  }
  return {
    reachable: true,
    endpoint,
    backend: String(x.ack.backend ?? m.press),
    held: Array.isArray(x.ack.held) ? (x.ack.held as string[]) : [],
    watchdogTripped: Boolean(x.ack.watchdog_tripped),
  };
}

export type BridgeStatusRunner = (
  padTool: string,
  port: string,
  timeoutMs: number
) => { ok: boolean; reason?: string };

/**
 * Ask pad.py to open the port and answer a `status` query -- never `press` or
 * `hold`, so this never writes to the board's input state. `--ms`/buttons are
 * not part of the status command at all, so there is nothing here that could
 * move the ring even by accident.
 */
function runPadStatus(padTool: string, port: string, timeoutMs: number): { ok: boolean; reason?: string } {
  const result = spawnSync("python", [padTool, "status", "--port", port], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });

  if (result.error) {
    return { ok: false, reason: `pad.py status could not be started: ${result.error.message}` };
  }
  if (result.signal || result.status === null) {
    return { ok: false, reason: `pad.py status did not answer within ${timeoutMs}ms` };
  }
  if (result.status !== 0) {
    const detail = (result.stderr?.toString().trim() || result.stdout?.toString().trim() || "no output").slice(
      0,
      300
    );
    return { ok: false, reason: `pad.py status exit ${result.status}: ${detail}` };
  }
  return { ok: true };
}

/**
 * Whether the ESP32 bridge board is actually reachable right now -- the thing
 * deck_status was silent about while a live session sat unplugged with nothing
 * surfacing it until the first press was attempted.
 *
 * Absence of hardware (no pad.py found, port doesn't open, board unplugged) is
 * a normal, reportable status here, not a thrown error. This never presses a
 * button: it only ever runs pad.py's `status` subcommand, which just opens the
 * port and asks the firmware to report in.
 */
export async function probeBridge(
  opts: {
    timeoutMs?: number;
    findPad?: () => string | null;
    run?: BridgeStatusRunner;
  } = {}
): Promise<BridgeProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BRIDGE_PROBE_TIMEOUT_MS;
  const port = getConfiguredBridgePort();
  const findPad = opts.findPad ?? findPadTool;
  const run = opts.run ?? runPadStatus;

  // Same hard stop pressButton uses: a suite (or a caller) that sets
  // DPS_NO_BRIDGE must never reach a real spawn, even for a read-only status
  // query, so this probe can be unit-tested and CI-run with zero hardware risk.
  const disabledReason = bridgeDisabled();
  if (disabledReason) {
    return { bridgePortOpen: false, bridgeReady: false, port, reason: disabledReason };
  }

  const pad = findPad();
  if (!pad) {
    return {
      bridgePortOpen: false,
      bridgeReady: false,
      port,
      reason: `bridge/tools/pad.py not found from ${import.meta.url}`,
    };
  }

  try {
    const result = run(pad, port, timeoutMs);
    if (!result.ok) {
      return {
        bridgePortOpen: false,
        bridgeReady: false,
        port,
        reason: result.reason ?? "bridge status probe failed",
      };
    }
    return { bridgePortOpen: true, bridgeReady: true, port };
  } catch (err) {
    return {
      bridgePortOpen: false,
      bridgeReady: false,
      port,
      reason: `bridge status probe threw: ${(err as Error).message}`,
    };
  }
}
