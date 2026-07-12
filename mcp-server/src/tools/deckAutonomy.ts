import { execSync } from "child_process";
import fs from "fs";
import { getIngestPort } from "../ingest/server.js";
import { readDeckEnv, getWorkspaceRoot } from "../config.js";
import { detectLocalSteamOs, getHomebrewPluginsDir, restartLoaderLocal } from "../deploy/local.js";
import { sshRestartLoader } from "../deploy/deployHelpers.js";
import { detectPlugin } from "./plugin.js";
import { isDeckLocal } from "./captureOrchestrator.js";
import { getTunnelState, pingDeck } from "./deck.js";

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
  mode: "auto" | "local" | "remote" = "auto"
): Promise<{ ok: boolean; mode: string; method: string }> {
  const localInfo = detectLocalSteamOs();
  const homebrew = getHomebrewPluginsDir();
  const canLocal =
    localInfo.isSteamOsLike &&
    (fs.existsSync(homebrew) || fs.mkdirSync(homebrew, { recursive: true }) === undefined);

  let deployMode = mode;
  if (mode === "auto") deployMode = canLocal ? "local" : "remote";

  if (deployMode === "local") {
    const method = await restartLoaderLocal();
    return { ok: true, mode: "local", method };
  }

  const env = readDeckEnv();
  const host = env.DECK_IP;
  const user = env.DECK_USER ?? "deck";
  if (!host) throw new Error("DECK_IP not configured — run deck.configure first");

  sshRestartLoader(user, host);
  return { ok: true, mode: "remote", method: `ssh ${user}@${host} plugin_loader restart` };
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

export function readPluginLog(
  lines = 50,
  filter?: string
): { source: string; text: string } {
  const maxLines = Math.min(Math.max(1, Number(lines) || 50), 500);
  const env = readDeckEnv();
  const host = env.DECK_IP;
  const user = env.DECK_USER ?? "deck";
  const local = !host || isDeckLocal(host);

  let source = "journalctl:plugin_loader.service";
  let text = fetchJournalText(local, user, host ?? "127.0.0.1", maxLines);

  if (!text.trim()) {
    text = fetchFallbackLogPaths(local, user, host ?? "127.0.0.1");
    source = "fallback:homebrew/logs";
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

async function probeRemoteDeck(user: string, host: string): Promise<Record<string, string>> {
  const remote: Record<string, string> = {};
  const osRelease = execQuiet(`ssh ${user}@${host} "cat /etc/os-release 2>/dev/null | head -5"`);
  if (osRelease) remote.osRelease = osRelease.replace(/\n/g, "; ");
  const deckyPath = execQuiet(
    `ssh ${user}@${host} "test -d ~/homebrew && echo yes || echo no"`
  );
  remote.homebrewPresent = deckyPath || "unknown";
  const loaderStatus = execQuiet(
    `ssh ${user}@${host} "systemctl --user is-active plugin_loader.service 2>/dev/null || echo inactive"`
  );
  remote.pluginLoaderActive = loaderStatus || "unknown";
  return remote;
}

export async function getEnv(): Promise<Record<string, unknown>> {
  const deckEnv = readDeckEnv();
  const workspace = getWorkspaceRoot();
  const plugin = detectPlugin();
  const tunnel = getTunnelState();
  const localOs = detectLocalSteamOs();

  const base: Record<string, unknown> = {
    workspaceRoot: workspace,
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
    localOs: { isSteamOsLike: localOs.isSteamOsLike, id: localOs.id },
    deckReachable: await pingDeck(),
  };

  const host = deckEnv.DECK_IP;
  const user = deckEnv.DECK_USER ?? "deck";
  if (host && !isDeckLocal(host)) {
    try {
      base.remote = await probeRemoteDeck(user, host);
    } catch {
      base.remote = { error: "SSH probe failed" };
    }
  }

  return base;
}
