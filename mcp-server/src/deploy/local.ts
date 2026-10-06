import fs from "fs";
import os from "os";
import path from "path";
import { execSync, spawn } from "child_process";
import { copyPluginTree } from "./copyManifest.js";
import { runWithRetry } from "./deployHelpers.js";
import { hostIsSteamOsLike, Machine } from "../machines.js";
import { hasSteamUiTargets, listTargets } from "../deck/cdp.js";

export interface LocalOsInfo {
  isSteamOsLike: boolean;
  id: string;
}

/**
 * Is THIS PROCESS on a SteamOS-like host? A fact about the host, reported by
 * deck_getEnv. It no longer decides where a deploy goes: that is the current
 * machine's `local` flag (machines.ts), because a DPS server on a Bazzite
 * host would otherwise have deployed into the host's own Decky folder
 * (plan 10 § 3, "a trap in this repo").
 */
export function detectLocalSteamOs(): LocalOsInfo {
  const h = hostIsSteamOsLike();
  return { isSteamOsLike: h.steamOsLike, id: h.id };
}

/** Where Decky keeps plugins on the local machine: the entry's pluginsDir, else ~/homebrew/plugins (Linux and the Windows port alike). */
export function getHomebrewPluginsDir(m?: Machine | null): string {
  return m?.pluginsDir ?? path.join(os.homedir(), "homebrew", "plugins");
}

export function findLoaderUnit(): string {
  const configured = process.env.DECKY_LOADER_UNIT;
  if (configured) return configured;
  try {
    const out = execSync("systemctl --user list-unit-files --type=service", {
      encoding: "utf8",
    });
    const match = out.match(/(\S*plugin\S*loader\S*\.service)/i);
    if (match) return match[1];
  } catch {
    /* ignore */
  }
  return "plugin_loader.service";
}

/** The Windows port's layout: `<homebrew>/services/PluginLoader_noconsole.exe` beside `<homebrew>/plugins`. */
export function windowsLoaderExe(m?: Machine | null): { servicesDir: string; exe: string | null } {
  const servicesDir = path.join(path.dirname(getHomebrewPluginsDir(m)), "services");
  for (const name of ["PluginLoader_noconsole.exe", "PluginLoader.exe"]) {
    const p = path.join(servicesDir, name);
    if (fs.existsSync(p)) return { servicesDir, exe: p };
  }
  return { servicesDir, exe: null };
}

/**
 * Restart Decky's PluginLoader on this Windows machine (plan 10 Route A″).
 * The Windows port is a frozen Python exe started from the Startup folder,
 * not a systemd unit: kill whatever is running, start it again detached.
 */
export async function restartLoaderWindows(m?: Machine | null): Promise<string> {
  const { servicesDir, exe } = windowsLoaderExe(m);
  if (!exe) {
    throw new Error(
      `No PluginLoader executable under ${servicesDir}. Run scripts/standin/windows/setup-decky-windows.ps1 ` +
        "(it downloads the Windows build of Decky Loader into ~/homebrew/services).",
    );
  }
  for (const image of ["PluginLoader_noconsole.exe", "PluginLoader.exe"]) {
    try {
      execSync(`taskkill /F /IM ${image}`, { stdio: "ignore", shell: "cmd.exe" });
    } catch {
      /* not running -- fine */
    }
  }
  const child = spawn(exe, [], { cwd: servicesDir, detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return `taskkill PluginLoader*; start ${exe}`;
}

export async function restartLoaderLocal(unit?: string, m?: Machine | null): Promise<string> {
  if (m?.os === "windows" || (!m && process.platform === "win32")) return restartLoaderWindows(m);
  const loaderUnit = unit ?? findLoaderUnit();
  let method = `systemctl --user restart ${loaderUnit}`;
  runWithRetry("local plugin_loader restart", () => {
    try {
      execSync(`systemctl --user restart ${loaderUnit}`, { stdio: "pipe" });
    } catch {
      method = `sudo systemctl restart ${loaderUnit}`;
      execSync(method, { stdio: "pipe" });
    }
  });
  return method;
}

export function copyPluginToLocal(pluginRoot: string, pluginName: string, pluginsDir?: string): string {
  const target = path.join(pluginsDir ?? getHomebrewPluginsDir(), pluginName);
  copyPluginTree(pluginRoot, target);
  return target;
}

export interface LocalLoaderReadiness {
  ready: boolean;
  /** Did Decky's own HTTP port answer at all? */
  loaderAnswered: boolean;
  /** CEF page titles seen on the local CDP port. */
  targets: string[];
  waitedMs: number;
  polls: number;
  reason?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * After a local loader restart, wait until Decky answers on its own port
 * (1337) AND Steam lists a UI page over the local CDP port -- the same two
 * facts waitForLoaderReady() measures over ssh for a remote Deck (issue #3).
 * A deadline that passes is reported, never thrown.
 */
export async function waitForLoaderReadyLocal(opts: {
  cdpBase: string;
  loaderPort?: number;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<LocalLoaderReadiness> {
  const timeoutMs = Math.max(0, opts.timeoutMs ?? 30_000);
  const pollMs = Math.max(50, opts.pollMs ?? 1000);
  const loaderUrl = `http://127.0.0.1:${opts.loaderPort ?? 1337}/`;
  const started = Date.now();
  let polls = 0;
  let loaderAnswered = false;
  let titles: string[] = [];
  for (;;) {
    polls++;
    try {
      // Any HTTP answer, 404 included, means the loader's server is up.
      await fetch(loaderUrl, { signal: AbortSignal.timeout(1500) });
      loaderAnswered = true;
    } catch {
      loaderAnswered = false;
    }
    let uiUp = false;
    try {
      const targets = await listTargets(opts.cdpBase, 2000);
      titles = targets.map((t) => String(t.title ?? "")).filter(Boolean);
      uiUp = hasSteamUiTargets(targets);
    } catch {
      titles = [];
    }
    const waitedMs = Date.now() - started;
    if (loaderAnswered && uiUp) return { ready: true, loaderAnswered, targets: titles, waitedMs, polls };
    if (waitedMs >= timeoutMs) {
      return {
        ready: false,
        loaderAnswered,
        targets: titles,
        waitedMs,
        polls,
        reason:
          `PluginLoader ${loaderAnswered ? "answered" : "did not answer"} on ${loaderUrl} and Steam listed ` +
          `${titles.length ? titles.join(", ") : "no"} CEF page(s) on ${opts.cdpBase} after ${waitedMs}ms. ` +
          "Is Steam running with .cef-enable-remote-debugging in its folder, and is Big Picture open?",
      };
    }
    await sleep(Math.min(pollMs, timeoutMs - waitedMs));
  }
}
