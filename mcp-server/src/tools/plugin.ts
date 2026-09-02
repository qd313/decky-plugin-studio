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
import { deployRemote, DeployRemoteOptions } from "./deck.js";
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

/**
 * Filesystem-safe directory name for a *local* homebrew/plugins copy. Local
 * installs are free to normalize, since this process also owns the directory
 * it creates.
 */
export function localPluginDirName(name: unknown): string {
  return String(name).replace(/\s+/g, "-").toLowerCase();
}

/**
 * Directory name for the *remote* Deck target. decky loader names
 * homebrew/plugins/<name> from plugin.json's `name` field verbatim, so a
 * normalized (lowercased) name here silently deploys to a sibling directory
 * the loader never reads. This must match the manifest exactly, case intact.
 */
export const REMOTE_PLUGIN_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Names that are legal characters but still resolve to something other than a
 * child directory. `.` and `..` matter because the deploy builds
 * `~/homebrew/plugins/<name>` and then hands it to `sudo rm -rf`, where
 * `plugins/.` is the plugins directory itself and `plugins/..` is its parent.
 */
const REMOTE_PLUGIN_NAME_RESERVED = new Set([".", ".."]);

/**
 * Directory name for the *remote* Deck target. decky loader names
 * homebrew/plugins/<name> from plugin.json's `name` field verbatim, so a
 * normalized (lowercased) name here silently deploys to a sibling directory
 * the loader never reads. This must match the manifest exactly, case intact.
 *
 * It is also VALIDATED, which the local path does not need to be. The remote
 * deploy interpolates this into `sudo rm -rf ~/homebrew/plugins/<name>` on the
 * Deck -- an unchecked value there is a root-level delete (or worse, a command
 * injection) driven by whatever a plugin.json happens to contain. detectPlugin()
 * reads that field with no validation of its own: `valid` only means the file
 * parsed. Anything outside a plain directory name refuses here, before a single
 * remote command is built.
 */
export function remotePluginDirName(name: unknown): string {
  const trimmed = String(name).trim();
  if (!REMOTE_PLUGIN_NAME_RE.test(trimmed) || REMOTE_PLUGIN_NAME_RESERVED.has(trimmed)) {
    throw new Error(
      `Cannot deploy: plugin.json's "name" is ${JSON.stringify(trimmed)}, which is not a usable ` +
        `directory name on the Deck. The remote deploy replaces ~/homebrew/plugins/<name> with an ` +
        `elevated command, so the name must be a plain directory name -- letters, digits, dot, dash ` +
        `and underscore only, and not "." or "..". Rename it in plugin.json and redeploy.`
    );
  }
  return trimmed;
}

export async function deployPlugin(mode: "auto" | "local" | "remote" = "auto", opts: DeployRemoteOptions = {}) {
  const info = detectPlugin();
  if (!info.valid) throw new Error(info.reason);

  buildPlugin();

  runPreDeployHook(info.root!);

  const localInfo = detectLocalSteamOs();
  const homebrew = getHomebrewPluginsDir();
  const canLocal =
    localInfo.isSteamOsLike &&
    (fs.existsSync(homebrew) || fs.mkdirSync(homebrew, { recursive: true }) === undefined);

  let deployMode = mode;
  if (mode === "auto") deployMode = canLocal ? "local" : "remote";

  if (deployMode === "local") {
    const target = copyPluginToLocal(info.root!, localPluginDirName(info.name));
    const restartMethod = await restartLoaderLocal();
    return { mode: "local", target, restartMethod };
  }

  const remote = await deployRemote(info.root!, remotePluginDirName(info.name), opts);
  return { mode: "remote", ...remote };
}
