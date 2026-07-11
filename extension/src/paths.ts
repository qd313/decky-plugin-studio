import * as path from "path";
import * as fs from "fs";

export interface PluginInfo {
  root: string;
  name: string;
  hasMainPy: boolean;
  hasRollup: boolean;
  hasPluginJson: boolean;
}

export function detectPlugin(workspaceRoot: string): PluginInfo | null {
  const pluginJsonPath = path.join(workspaceRoot, "plugin.json");
  if (!fs.existsSync(pluginJsonPath)) {
    return null;
  }
  let name = path.basename(workspaceRoot);
  try {
    const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8"));
    name = pluginJson.name ?? name;
  } catch {
    /* ignore */
  }
  return {
    root: workspaceRoot,
    name,
    hasMainPy: fs.existsSync(path.join(workspaceRoot, "main.py")),
    hasRollup:
      fs.existsSync(path.join(workspaceRoot, "rollup.config.js")) ||
      fs.existsSync(path.join(workspaceRoot, "rollup.config.mjs")),
    hasPluginJson: true,
  };
}

export function getWorkspaceRoot(): string | undefined {
  const folders = require("vscode").workspace.workspaceFolders;
  return folders?.[0]?.uri.fsPath;
}

export function getExtensionRoot(): string {
  return path.join(__dirname, "..");
}

export function getRepoRoot(): string {
  const bundled = path.join(getExtensionRoot(), "resources");
  if (fs.existsSync(bundled)) {
    return getExtensionRoot();
  }
  return path.join(getExtensionRoot(), "..");
}

export function getPackRoot(): string {
  const bundled = path.join(getExtensionRoot(), "resources", "pack");
  if (fs.existsSync(bundled)) return bundled;
  return path.join(getRepoRoot(), "pack");
}

export function getMcpServerEntry(): string {
  const bundled = path.join(getExtensionRoot(), "resources", "mcp-server", "dist", "index.js");
  if (fs.existsSync(bundled)) return bundled;
  return path.join(getRepoRoot(), "mcp-server", "dist", "index.js");
}

export function getPreviewServerRoot(): string {
  const bundled = path.join(getExtensionRoot(), "resources", "preview-server");
  if (fs.existsSync(bundled)) return bundled;
  return path.join(getRepoRoot(), "preview-server");
}

export function getConfigDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".config", "decky-plugin-studio");
}

export function getDeckEnvPath(): string {
  return path.join(getConfigDir(), "deck.env");
}

export function ensureConfigDir(): void {
  fs.mkdirSync(getConfigDir(), { recursive: true });
}
