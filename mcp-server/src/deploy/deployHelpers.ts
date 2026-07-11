import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { loadPreviewConfig } from "../preview/previewConfig.js";

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
  execSync(cmd, {
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
      execSync(`scp -r "${src}" "${remoteDest}"`, {
        cwd: pluginRoot,
        stdio: "inherit",
        shell,
      });
    } else {
      execSync(`scp "${src}" "${remote}/"`, {
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
    execSync(
      `ssh ${user}@${host} "systemctl --user restart plugin_loader.service || sudo systemctl restart plugin_loader.service"`,
      { stdio: "inherit", shell }
    );
  });
}
