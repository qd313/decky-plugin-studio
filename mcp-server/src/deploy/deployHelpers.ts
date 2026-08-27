import { execSync as nodeExecSync } from "child_process";
import fs from "fs";
import path from "path";
import { loadPreviewConfig } from "../preview/previewConfig.js";

/**
 * Seam over the exec layer. `child_process`'s exports are non-configurable,
 * so tests cannot mock `execSync` directly (`mock.method` throws "Cannot
 * redefine property"). Production code calls through this object instead;
 * tests fake ssh/scp by replacing `proc.execSync` for the duration of a case.
 */
export const proc = {
  execSync: nodeExecSync,
};

export function runWithRetry(
  label: string,
  fn: () => void,
  maxAttempts = 2
): void {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      fn();
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        console.warn(`[deck.deploy] ${label} failed (attempt ${attempt}), retrying…`);
      }
    }
  }
  throw lastErr;
}

export function runPreDeployHook(pluginRoot: string): void {
  const cmd = loadPreviewConfig(pluginRoot).preDeployCommand;
  if (!cmd?.trim()) return;
  proc.execSync(cmd, {
    cwd: pluginRoot,
    stdio: "inherit",
    shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    env: { ...process.env, DECKY_STUDIO_WORKSPACE: pluginRoot },
  });
}

export function execScpRecursive(
  pluginRoot: string,
  sources: string[],
  remote: string
): void {
  if (sources.length === 0) {
    throw new Error("Nothing to deploy — run plugin.build first");
  }
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  for (const entry of sources) {
    const src = path.join(pluginRoot, entry);
    const remoteDest = `${remote}/${entry}`;
    if (fs.statSync(src).isDirectory()) {
      proc.execSync(`scp -r "${src}" "${remoteDest}"`, {
        cwd: pluginRoot,
        stdio: "inherit",
        shell,
      });
    } else {
      proc.execSync(`scp "${src}" "${remote}/"`, {
        cwd: pluginRoot,
        stdio: "inherit",
        shell,
      });
    }
  }
}

export function sshRestartLoader(user: string, host: string): void {
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  runWithRetry("plugin_loader restart", () => {
    proc.execSync(
      `ssh ${user}@${host} "systemctl --user restart plugin_loader.service || sudo systemctl restart plugin_loader.service"`,
      { stdio: "inherit", shell }
    );
  });
}

/**
 * Staging directory for a deploy, on the Deck, owned by whoever `deck.env`
 * says to ssh in as. Always writable by plain scp, unlike
 * `~/homebrew/plugins/<name>` once decky loader has taken ownership of it.
 */
export function remoteDeployTempDir(pluginName: string): string {
  return `/tmp/decky-studio-deploy-${Date.now()}-${pluginName}`;
}

export function ensureRemoteDir(user: string, host: string, remoteDir: string): void {
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  proc.execSync(`ssh ${user}@${host} "mkdir -p ${remoteDir}"`, { stdio: "pipe", encoding: "utf8", shell });
}

const PERMISSION_SIGNS =
  /permission denied|not writable|read-only file system|password is required|not in the sudoers|operation not permitted/i;

/**
 * Moves a deploy that scp already staged in `tempDir` (as the plain deploy
 * user) into `targetDir` — typically `~/homebrew/plugins/<name>`, which decky
 * loader owns as root once the plugin has been installed once through the
 * QAM. Plain scp cannot overwrite a root-owned directory; this is the same
 * stage-then-elevate workaround the consumer repo's own deploy script uses,
 * so the one step that needs privilege is a single `sudo` command over ssh
 * instead of the whole transfer.
 *
 * On failure this throws a diagnostic naming the target and the owner
 * problem, rather than letting the caller surface the raw failed command.
 */
export function moveDeployedPluginIntoPlace(
  user: string,
  host: string,
  tempDir: string,
  targetDir: string,
  pluginName: string
): void {
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  const remoteCmd = `sudo rm -rf ${targetDir} && sudo mkdir -p "$(dirname ${targetDir})" && sudo mv ${tempDir} ${targetDir} && sudo chown -R root:root ${targetDir}`;
  try {
    proc.execSync(`ssh ${user}@${host} "${remoteCmd}"`, { stdio: "pipe", encoding: "utf8", shell });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}`;
    if (PERMISSION_SIGNS.test(output)) {
      throw new Error(
        `Cannot deploy "${pluginName}": ${targetDir} on the Deck is owned by root and "${user}" ` +
          `has no elevated access to replace it. Give ${user} passwordless sudo (visudo: ` +
          `"${user} ALL=(ALL) NOPASSWD: ALL"), or remove the stale directory yourself with ` +
          `"ssh ${user}@${host} sudo rm -rf ${targetDir}" and redeploy.`
      );
    }
    throw new Error(
      `Failed to move the deployed plugin into place at ${targetDir} on the Deck: ${output.trim() || String(err)}`
    );
  }
}
