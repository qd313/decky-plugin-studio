import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { getWorkspaceRoot } from "../config.js";
import {
  copyPluginToLocal,
  detectLocalSteamOs,
  getHomebrewPluginsDir,
  restartLoaderLocal,
} from "../deploy/local.js";
import { deployRemote } from "./deck.js";
import { runPreDeployHook } from "../deploy/deployHelpers.js";

export function detectPlugin() {
  const root = getWorkspaceRoot();
  const pluginJson = path.join(root, "plugin.json");
  const mainPy = path.join(root, "main.py");
  const rollup =
    fs.existsSync(path.join(root, "rollup.config.js")) ||
    fs.existsSync(path.join(root, "rollup.config.mjs"));

  if (!fs.existsSync(pluginJson)) {
    return { valid: false, reason: "plugin.json not found" };
  }

  let name = path.basename(root);
  try {
    name = JSON.parse(fs.readFileSync(pluginJson, "utf8")).name ?? name;
  } catch {
    /* ignore */
  }

  return {
    valid: true,
    name,
    hasMainPy: fs.existsSync(mainPy),
    hasRollup: rollup,
    root,
  };
}

export function buildPlugin(): { ok: boolean; output?: string } {
  const root = getWorkspaceRoot();
  try {
    if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) {
      execSync("pnpm run build", { cwd: root, stdio: "pipe", encoding: "utf8" });
    } else if (fs.existsSync(path.join(root, "package.json"))) {
      execSync("npm run build", { cwd: root, stdio: "pipe", encoding: "utf8" });
    } else {
      return { ok: false, output: "No package.json found" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, output: String(err) };
  }
}

export function verifyZip(): { ok: boolean; issues: string[] } {
  const root = getWorkspaceRoot();
  const issues: string[] = [];
  const required = ["plugin.json", "dist/index.js"];
  for (const file of required) {
    if (!fs.existsSync(path.join(root, file))) issues.push(`Missing ${file}`);
  }
  try {
    const pluginJson = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
    if (!pluginJson.name) issues.push("plugin.json missing name");
    if (!pluginJson.version) issues.push("plugin.json missing version");
  } catch {
    issues.push("plugin.json invalid JSON");
  }
  return { ok: issues.length === 0, issues };
}

export async function deployPlugin(mode: "auto" | "local" | "remote" = "auto") {
  const info = detectPlugin();
  if (!info.valid) throw new Error(info.reason);

  buildPlugin();

  runPreDeployHook(info.root!);

  const pluginName = String(info.name).replace(/\s+/g, "-").toLowerCase();
  const localInfo = detectLocalSteamOs();
  const homebrew = getHomebrewPluginsDir();
  const canLocal =
    localInfo.isSteamOsLike &&
    (fs.existsSync(homebrew) || fs.mkdirSync(homebrew, { recursive: true }) === undefined);

  let deployMode = mode;
  if (mode === "auto") deployMode = canLocal ? "local" : "remote";

  if (deployMode === "local") {
    const target = copyPluginToLocal(info.root!, pluginName);
    const restartMethod = await restartLoaderLocal();
    return { mode: "local", target, restartMethod };
  }

  const remote = await deployRemote(info.root!, pluginName);
  return { mode: "remote", ...remote };
}
