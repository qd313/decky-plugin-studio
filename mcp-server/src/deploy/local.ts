import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { copyPluginTree } from "./copyManifest.js";
import { runWithRetry } from "./deployHelpers.js";

export interface LocalOsInfo {
  isSteamOsLike: boolean;
  id: string;
}

export function detectLocalSteamOs(): LocalOsInfo {
  try {
    const release = fs.readFileSync("/etc/os-release", "utf8");
    const idMatch = release.match(/^ID=(.+)$/m);
    const idLikeMatch = release.match(/^ID_LIKE=(.+)$/m);
    const id = (idMatch?.[1] ?? "").replace(/"/g, "");
    const idLike = (idLikeMatch?.[1] ?? "").replace(/"/g, "");
    const isSteamOsLike =
      id === "steamos" ||
      id === "bazzite" ||
      idLike.includes("steamos") ||
      idLike.includes("fedora");
    return { isSteamOsLike, id };
  } catch {
    return { isSteamOsLike: false, id: os.platform() };
  }
}

export function getHomebrewPluginsDir(): string {
  return path.join(os.homedir(), "homebrew", "plugins");
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

export async function restartLoaderLocal(unit?: string): Promise<string> {
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
export function copyPluginToLocal(pluginRoot: string, pluginName: string): string {
  const target = path.join(getHomebrewPluginsDir(), pluginName);
  copyPluginTree(pluginRoot, target);
  return target;
}
