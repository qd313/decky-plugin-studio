import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * The killswitch latch, read straight off disk by the extension host.
 *
 * This deliberately duplicates the paths from mcp-server/src/deck/killswitch.ts
 * rather than importing them, and the duplication is the point rather than a
 * shortcut. Every other signal the status bar shows is read *from* the Studio
 * server, and that dependency is what made a packaging bug spend its life
 * looking like a network problem: when the server is down, everything it
 * reports is false for the same uninformative reason.
 *
 * A killswitch indicator cannot be allowed to fail that way. "The server is
 * dead, so I will show the rig as armed" and "the server is dead, so I will
 * show it as stopped" are both lies, and one of them gets someone's Deck
 * pressed. So the indicator reads the file the latch actually lives in, over a
 * path this process derives itself, and it is right whether or not any server
 * is running -- including when the stop was set by a completely different
 * process, which is the normal case: the agent driving the Deck has its own
 * server, and it is not this one.
 *
 * If these paths ever drift from the server's, the symptom is a status bar that
 * says armed while the rig is stopped. Keep them together.
 */
const CONFIG_DIR = (): string => path.join(os.homedir(), ".config", "decky-plugin-studio");

export const getLatchPath = (): string => path.join(CONFIG_DIR(), "automation-stop.json");
const getTunnelDir = (): string => path.join(CONFIG_DIR(), "automation-tunnels");

export type StopSource = "status-bar" | "command" | "keybinding" | "tool" | "cli" | "unknown";

export interface StopRecord {
  at: string;
  by: StopSource;
  reason?: string;
  pid: number;
  host: string;
}

/**
 * The latch, or null when automation is armed.
 *
 * A present-but-unreadable file counts as stopped, matching the server: the
 * only reason it exists is that somebody asked for a stop, and an indicator
 * that resolves that ambiguity towards "armed" is worse than no indicator.
 */
export function readLatch(): StopRecord | null {
  try {
    if (!fs.existsSync(getLatchPath())) return null;
    return JSON.parse(fs.readFileSync(getLatchPath(), "utf8")) as StopRecord;
  } catch {
    if (fs.existsSync(getLatchPath())) {
      return { at: "unknown time", by: "unknown", pid: 0, host: "unknown host" };
    }
    return null;
  }
}

/**
 * Set the latch from the extension host, without going through the server.
 *
 * The server does this too, and does the parts this cannot -- releasing the
 * board, tearing down tunnels. This exists so that hitting stop works when the
 * server is dead or wedged, which is exactly when someone is most likely to be
 * reaching for it. Between the two, the latch always gets set; only the release
 * and the teardown depend on a working server, and the user is told when those
 * did not run.
 */
export function writeLatch(rec: StopRecord): boolean {
  try {
    fs.mkdirSync(CONFIG_DIR(), { recursive: true });
    fs.writeFileSync(getLatchPath(), JSON.stringify(rec, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

export function clearLatch(): boolean {
  try {
    fs.rmSync(getLatchPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * How many SSH tunnels are registered right now, across every studio process.
 *
 * A live CDP forward is the closest thing to a reliable "a run is driving the
 * Deck at this moment" signal the extension can get without asking a server
 * that may be busy doing exactly that. It is what makes the indicator loud when
 * being loud is useful, instead of permanently.
 */
export function countLiveTunnels(): { cdp: number; ingest: number } {
  const counts = { cdp: 0, ingest: 0 };
  let names: string[];
  try {
    names = fs.readdirSync(getTunnelDir());
  } catch {
    return counts;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(getTunnelDir(), name), "utf8")) as {
        kind?: "cdp" | "ingest";
      };
      if (entry.kind === "cdp") counts.cdp++;
      else if (entry.kind === "ingest") counts.ingest++;
    } catch {
      /* a half-written entry is not worth reporting on */
    }
  }
  return counts;
}

/**
 * Notice when any of the above changes, promptly.
 *
 * fs.watch does the work when it can, and a 2s poll backs it up. Both, because
 * fs.watch is the one Node API with genuinely different behaviour per platform
 * and per filesystem -- and because the fallback here costs one existsSync and
 * one small readdir, which is nothing next to being wrong about whether a rig
 * that presses real buttons is armed.
 */
export function watchAutomation(onChange: () => void): { dispose: () => void } {
  let watcher: fs.FSWatcher | null = null;
  try {
    fs.mkdirSync(CONFIG_DIR(), { recursive: true });
    watcher = fs.watch(CONFIG_DIR(), () => onChange());
  } catch {
    watcher = null;
  }
  const timer = setInterval(onChange, 2000);
  return {
    dispose: () => {
      watcher?.close();
      clearInterval(timer);
    },
  };
}
