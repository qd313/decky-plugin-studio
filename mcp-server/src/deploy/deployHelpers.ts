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

/**
 * Quote a remote path for the shell on the far side of ssh.
 *
 * A leading `~/` must stay OUTSIDE the quotes or the remote shell takes the
 * tilde literally and never expands it to the home directory. Everything after
 * it is single-quoted, so a space or a shell metacharacter in the name is one
 * literal path segment rather than extra arguments to `rm -rf`.
 *
 * remotePluginDirName() already refuses anything but a plain directory name,
 * so this should never have work to do. It is here because the command it
 * feeds runs `sudo rm -rf` on someone's Deck, and one guard in front of that
 * is not enough.
 */
export function quoteRemotePath(p: string): string {
  // POSIX single-quote escape: close, emit a literal quote, reopen.
  const esc = (seg: string) => "'" + seg.split("'").join("'\\''") + "'";
  return p.startsWith("~/") ? `~/${esc(p.slice(2))}` : esc(p);
}

export function ensureRemoteDir(user: string, host: string, remoteDir: string): void {
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  proc.execSync(`ssh ${user}@${host} "mkdir -p ${quoteRemotePath(remoteDir)}"`, { stdio: "pipe", encoding: "utf8", shell });
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
  // The parent is spelled out rather than computed with `$(dirname ...)`: this
  // whole string is interpolated into a double-quoted local ssh argument, and a
  // POSIX login shell on the *local* side would run that substitution itself
  // before ssh ever saw it.
  const target = quoteRemotePath(targetDir);
  const temp = quoteRemotePath(tempDir);
  /*
   * MERGE INTO THE TARGET -- do not replace it.
   *
   * The first version of this ran `sudo rm -rf <target>` and moved the staged
   * upload into its place. That deletes everything the deploy does not itself
   * put back, and listDeploySources() copies a fixed set (dist, main.py,
   * plugin.json, package.json, assets, py_modules, defaults, bin, locales) that
   * does NOT include `data`. The installed bonsAI on the live rig keeps its
   * seed data there -- intent packs, kb seeds, rag_seed -- so a deploy would
   * have silently destroyed 152K of content it had no way to restore.
   *
   * `cp -a <temp>/. <target>/` overwrites what the deploy ships and leaves
   * everything else alone, which is what plain `scp -r` into the live
   * directory did before any of this. The reason for the elevated command was
   * never "replace the directory", it was "write into a directory root owns".
   *
   * The trade is that a file dropped from the plugin is not cleaned up by a
   * deploy. That was already true of the scp path, and it is much the better
   * failure: a stale file is visible and removable, deleted user data is not.
   */
  /*
   * NORMALISE THE MODES BEFORE THE COPY, NOT AFTER.
   *
   * scp -r sends the LOCAL directory's mode on the wire, and the receiver
   * applies its umask to files but not to directories -- so a directory mode
   * arrives verbatim even without -p. Win32 OpenSSH derives st_mode from the
   * NTFS ACL and reports a user-profile directory as 0700, so every directory
   * uploaded from a Windows host lands `drwx------`. `cp -a` then preserves
   * that faithfully and `chown -R root:root` below makes it fatal: Decky runs
   * plugin backends unprivileged, and an unprivileged process cannot traverse a
   * root-owned 0700 directory. Measured on the rig 2026-08-28 -- py_modules,
   * dist, assets, bin and defaults all 0700, backend dead at import with
   * `ModuleNotFoundError: No module named 'backend'`, on every start.
   *
   * That failure wears a disguise, which is why it is worth a comment this
   * long: the loader serves the FRONTEND as root, so the panel renders normally
   * while its every RPC fails. It reads as a settings bug, and the session that
   * found it burned three loader restarts before reading the plugin log.
   *
   * The chmod is on the STAGING dir, not the target, and deliberately so: the
   * target holds content this deploy did not ship (bonsAI keeps seed data in
   * `data/`), and re-permissioning that is not this command's business. No
   * sudo -- the staging dir is owned by the deploy user. `go+rX` is capital X
   * on purpose: +x for directories and already-executable files, never for a
   * plain .py.
   */
  const remoteCmd =
    `chmod -R u+rwX,go+rX ${temp} && ` +
    `sudo mkdir -p ${target} && sudo cp -a ${temp}/. ${target}/ && ` +
    `sudo rm -rf ${temp} && sudo chown -R root:root ${target}`;
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
