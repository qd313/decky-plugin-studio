import fs from "fs";
import os from "os";
import path from "path";

export function getConfigDir(): string {
  return path.join(os.homedir(), ".config", "decky-plugin-studio");
}

export function getDeckEnvPath(): string {
  return path.join(getConfigDir(), "deck.env");
}

export function ensureConfigDir(): void {
  fs.mkdirSync(getConfigDir(), { recursive: true });
}

/**
 * Settings the host editor may override, in order of who wins.
 *
 * These were dead until 2026-08-26. The extension declared
 * `deckyPluginStudio.deckIp` and `.deckUser` in its manifest and then never
 * read them -- there was not a single `getConfiguration` call anywhere in the
 * extension -- so a user could type their Deck's IP into VS Code settings, see
 * it saved, and get no connection and no complaint. A setting that does nothing
 * is worse than no setting: it sends you looking at your network.
 */
const HOST_OVERRIDABLE = ["DECK_IP", "DECK_USER"] as const;

export function readDeckEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const envPath = getDeckEnvPath();
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([^#]\S+?)\s*=\s*(.+)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  // An explicitly set variable wins over the file, because it is the one the
  // user just typed. Blank counts as unset, so an empty setting -- which is the
  // default -- cannot wipe out a working deck.env.
  for (const key of HOST_OVERRIDABLE) {
    const v = process.env[key];
    if (v && v.trim()) env[key] = v.trim();
  }
  return env;
}

export function writeDeckEnv(values: Record<string, string>): void {
  ensureConfigDir();
  const existing = readDeckEnv();
  const merged = { ...existing, ...values };
  const content = Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  fs.writeFileSync(getDeckEnvPath(), content + "\n", "utf8");
}

export function getWorkspaceRoot(): string {
  return process.env.DECKY_STUDIO_WORKSPACE ?? process.cwd();
}

export function getRepoRoot(): string {
  return process.env.DECKY_STUDIO_REPO ?? path.join(process.cwd(), "..");
}

export function getPreviewServerRoot(): string {
  const bundled = path.join(getRepoRoot(), "resources", "preview-server");
  if (fs.existsSync(bundled)) return bundled;
  return path.join(getRepoRoot(), "preview-server");
}

export function getPreviewStatePath(): string {
  return path.join(os.homedir(), ".decky-plugin-studio", "preview-state.json");
}

export type PreviewState = {
  url?: string;
  httpPort?: number;
  wsPort?: number;
  workspaceRoot?: string;
};

export function readPreviewState(): PreviewState {
  const statePath = getPreviewStatePath();
  if (!fs.existsSync(statePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8")) as PreviewState;
  } catch {
    return {};
  }
}

export function writePreviewState(state: PreviewState): void {
  fs.mkdirSync(path.dirname(getPreviewStatePath()), { recursive: true });
  fs.writeFileSync(getPreviewStatePath(), JSON.stringify(state, null, 2), "utf8");
}
