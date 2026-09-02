import { execSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { readDeckEnv } from "../config.js";
import { registerTunnel, unregisterTunnel } from "../deck/killswitch.js";
import { listDeploySources } from "../deploy/copyManifest.js";
import {
  ensureRemoteDir,
  execScpRecursive,
  moveDeployedPluginIntoPlace,
  proc,
  remoteDeployTempDir,
  runPreDeployHook,
  runWithRetry,
  sshRestartLoader,
  waitForLoaderReady,
  LoaderReadiness,
} from "../deploy/deployHelpers.js";
import {
  bundleDeckScript,
  capturePassesGate,
  cleanupRemote,
  downloadRemoteFile,
  getScriptsDir,
  getWorkspaceArtifactsDir,
  installCaptureHelperOnDeck,
  isDeckLocal,
  isLocalSteamOS,
  parseCaptureResult,
  parseRecordResult,
  recordPassesGate,
  runLocalBundledScript,
  runRemoteBundledScript,
  steamosRwFlag,
  timestamp,
} from "./captureOrchestrator.js";

let tunnelProcess: ReturnType<typeof spawn> | null = null;
/** Registry id of the live ingest tunnel, so the killswitch can reach it. */
let tunnelRegistrationId: string | null = null;

function shellCmd(): string {
  return process.platform === "win32" ? "cmd.exe" : "/bin/sh";
}

export function getTunnelState() {
  return {
    running: tunnelProcess !== null && !tunnelProcess.killed,
    pid: tunnelProcess?.pid,
  };
}

export function startTunnel(): { pid?: number; skipped?: boolean; reason?: string } {
  const env = readDeckEnv();
  if (isLocalSteamOS()) {
    return { skipped: true, reason: "local SteamOS host — loopback is direct" };
  }
  if (tunnelProcess && !tunnelProcess.killed) {
    return { pid: tunnelProcess.pid };
  }

  // The capture-scripts resolver, not a hand-rolled `import.meta.url` regex.
  // That regex recognised only upper-case drive letters and turned bonsAI's
  // lower-case `c:/...` mcp.json path into `\c:\...` (issue #2, the same
  // defect captureOrchestrator had), and it knew only the dist layout, so
  // under `tsx` it looked for a src/scripts that no build creates.
  // getScriptsDir() tries dist, then the repo's templates.
  let scriptsDir: string;
  try {
    scriptsDir = getScriptsDir();
  } catch (err) {
    return { reason: (err as Error).message };
  }
  const script =
    process.platform === "win32"
      ? path.join(scriptsDir, "reverse-tunnel-deck-ingest.ps1")
      : path.join(scriptsDir, "reverse-tunnel-deck-ingest.sh");

  const cmd = process.platform === "win32" ? "powershell" : "bash";
  const args =
    process.platform === "win32"
      ? ["-ExecutionPolicy", "Bypass", "-File", script]
      : [script];

  tunnelProcess = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: "ignore",
    detached: true,
  });
  tunnelProcess.unref();

  // The killswitch takes down every SSH tunnel, this one included. It runs in a
  // different process from the one that usually starts this, so the handle
  // above is not enough on its own -- the registry is what makes it reachable.
  // The closer nulls the local handle too, so getTunnelState() does not go on
  // reporting a tunnel that the killswitch has already killed.
  //
  // CAVEAT, the same one stopTunnel() has always had: this pid is the powershell
  // or bash wrapper, not ssh itself, so killing it does not reliably take the
  // ssh child with it on Windows. That is why the two tunnel kinds are counted
  // separately in the stop report -- do not read "1 ingest closed" as a promise
  // that the ssh process is gone. The CDP forwards are the ones that matter for
  // a stop, and those are spawned as ssh directly (cdpTunnel.ts), so their pid
  // is the real one and killing it ends the tunnel.
  tunnelRegistrationId = registerTunnel("ingest", tunnelProcess.pid, "deck ingest reverse tunnel", () => {
    if (tunnelProcess && !tunnelProcess.killed) tunnelProcess.kill();
    tunnelProcess = null;
    tunnelRegistrationId = null;
  });

  return { pid: tunnelProcess.pid };
}

export function stopTunnel(): { stopped: boolean } {
  if (tunnelRegistrationId) {
    unregisterTunnel(tunnelRegistrationId);
    tunnelRegistrationId = null;
  }
  if (tunnelProcess && !tunnelProcess.killed) {
    tunnelProcess.kill();
    tunnelProcess = null;
    return { stopped: true };
  }
  return { stopped: false };
}

export async function pingDeck(): Promise<boolean> {
  const env = readDeckEnv();
  const host = env.DECK_IP;
  if (!host) return false;
  if (isDeckLocal(host)) return true;
  try {
    if (process.platform === "win32") {
      execSync(`ping -n 1 -w 1000 ${host}`, { stdio: "ignore", shell: shellCmd() });
    } else {
      execSync(`ping -c 1 -W 1 ${host}`, { stdio: "ignore", shell: shellCmd() });
    }
    return true;
  } catch {
    return false;
  }
}

export async function probeOllama(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function captureScreenshot(
  mode: string,
  allowNonPluginUi = false
): Promise<{ path: string; bytes: number; mode: string; method: string }> {
  const env = readDeckEnv();
  const host = env.DECK_IP;
  const user = env.DECK_USER ?? "deck";
  const ts = timestamp();
  const outPath = path.join(getWorkspaceArtifactsDir("screenshots"), `DeckCapture_${ts}_${mode}.png`);

  const remoteFile = "/tmp/deck_ui_capture.png";
  const remoteDiag = "/tmp/studio-capture.diag";
  const remoteResult = "/tmp/studio-capture.result";
  const remoteScript = "/tmp/studio-capture-run.sh";

  const rw = steamosRwFlag();
  const remoteArgs = `--mode ${mode} --out ${remoteFile} --diag ${remoteDiag} --result ${remoteResult}${rw ? ` ${rw}` : ""}`;

  const bundle = bundleDeckScript("studio-capture.sh");
  let resultText = "";
  let exitCode = 0;

  if (!host || isDeckLocal(host)) {
    const run = runLocalBundledScript(bundle, remoteArgs);
    exitCode = run.exitCode;
    resultText = run.resultText;
    const parsed = parseCaptureResult(resultText);
    if (exitCode === 0 && capturePassesGate(parsed, allowNonPluginUi) && parsed.path) {
      if (parsed.path !== outPath) {
        fs.copyFileSync(parsed.path, outPath);
      }
      const stat = fs.statSync(outPath);
      return {
        path: outPath,
        bytes: stat.size,
        mode: parsed.mode ?? mode,
        method: parsed.method ?? "unknown",
      };
    }
    throw new Error(
      `Screenshot failed (method=${parsed.method ?? "unknown"}, bytes=${parsed.bytes ?? 0}). Open QAM + plugin first.`
    );
  }

  const run = runRemoteBundledScript(user, host, bundle, remoteArgs, remoteScript);
  exitCode = run.exitCode;
  resultText = run.resultText;
  const parsed = parseCaptureResult(resultText);

  if (exitCode !== 0 || !capturePassesGate(parsed, allowNonPluginUi) || !parsed.path) {
    cleanupRemote(user, host, [remoteFile, remoteDiag, remoteResult, remoteScript]);
    throw new Error(
      `Screenshot failed (method=${parsed.method ?? "unknown"}, bytes=${parsed.bytes ?? 0}). Open QAM + plugin first.`
    );
  }

  runWithRetry("scp screenshot", () => {
    downloadRemoteFile(user, host, parsed.path!, outPath);
  });
  cleanupRemote(user, host, [remoteFile, remoteDiag, remoteResult, remoteScript]);

  const stat = fs.statSync(outPath);
  return {
    path: outPath,
    bytes: stat.size,
    mode: parsed.mode ?? mode,
    method: parsed.method ?? "unknown",
  };
}

export async function recordDeck(
  seconds: string,
  mode: string,
  quality = "compressed",
  allowNonPluginUi = false
): Promise<{ path: string; bytes: number; mode: string; method: string; seconds: number }> {
  const env = readDeckEnv();
  const host = env.DECK_IP;
  const user = env.DECK_USER ?? "deck";
  const duration = Math.max(1, Number(seconds) || 10);
  const ts = timestamp();
  const suffixMode = mode === "auto" ? "auto" : mode;
  const outPath = path.join(
    getWorkspaceArtifactsDir("recordings"),
    `DeckRecord_${ts}_${suffixMode}.mkv`
  );

  const remoteFile = "/tmp/deck_record.mkv";
  const remoteDiag = "/tmp/studio-record.diag";
  const remoteResult = "/tmp/studio-record.result";
  const remoteScript = "/tmp/studio-record-run.sh";

  const rw = steamosRwFlag();
  const remoteArgs = `--mode ${mode} --seconds ${duration} --quality ${quality} --out ${remoteFile} --diag ${remoteDiag} --result ${remoteResult}${rw ? ` ${rw}` : ""}`;

  const bundle = bundleDeckScript("studio-record.sh");
  let resultText = "";
  let exitCode = 0;

  if (!host || isDeckLocal(host)) {
    const run = runLocalBundledScript(bundle, remoteArgs);
    exitCode = run.exitCode;
    resultText = run.resultText;
  } else {
    const run = runRemoteBundledScript(user, host, bundle, remoteArgs, remoteScript);
    exitCode = run.exitCode;
    resultText = run.resultText;
  }

  const parsed = parseRecordResult(resultText);
  const passes = recordPassesGate(parsed, quality, allowNonPluginUi);

  if (exitCode !== 0 || !passes || !parsed.path) {
    if (host && !isDeckLocal(host)) {
      cleanupRemote(user, host, [remoteFile, remoteDiag, remoteResult, remoteScript]);
    }
    throw new Error(
      `Recording failed (method=${parsed.method ?? "failed"}, bytes=${parsed.bytes ?? 0}, plugin_ui=${parsed.pluginUi ?? "no"}). Open QAM + plugin before recording.`
    );
  }

  if (!host || isDeckLocal(host)) {
    if (parsed.path !== outPath && fs.existsSync(parsed.path)) {
      fs.copyFileSync(parsed.path, outPath);
    }
  } else {
    runWithRetry("scp recording", () => {
      downloadRemoteFile(user, host, parsed.path!, outPath);
    });
    cleanupRemote(user, host, [remoteFile, remoteDiag, remoteResult, remoteScript]);
  }

  const stat = fs.statSync(outPath);
  return {
    path: outPath,
    bytes: stat.size,
    mode: parsed.mode ?? mode,
    method: parsed.method ?? "unknown",
    seconds: parsed.seconds ?? duration,
  };
}

export async function installCaptureHelper(
  which: "record" | "capture" | "both" = "both"
): Promise<{ installed: string[] }> {
  const env = readDeckEnv();
  const host = env.DECK_IP;
  const user = env.DECK_USER ?? "deck";
  if (!host && !isLocalSteamOS()) {
    throw new Error("DECK_IP not configured — run deck.configure first");
  }
  if (!host || isDeckLocal(host)) {
    throw new Error("installCaptureHelper requires remote DECK_IP (not local host)");
  }

  const installed: string[] = [];
  if (which === "record" || which === "both") {
    const r = installCaptureHelperOnDeck(user, host, "studio-record", "studio-record.sh");
    installed.push(r.installed);
  }
  if (which === "capture" || which === "both") {
    const r = installCaptureHelperOnDeck(user, host, "studio-capture", "studio-capture.sh");
    installed.push(r.installed);
  }
  return { installed };
}

export interface DeployRemoteOptions {
  /**
   * After the plugin_loader restart, poll the Deck until the loader is active
   * and Steam lists a UI page over CDP again, so the next deck_* call does not
   * land in the restart (issue #3). Default true.
   */
  waitForLoader?: boolean;
  /** Upper bound on that wait. Default 30 s. */
  loaderTimeoutMs?: number;
  /** Poll interval for that wait. Default 1 s; tests shorten it. */
  loaderPollMs?: number;
}

export async function deployRemote(
  pluginRoot: string,
  pluginName: string,
  opts: DeployRemoteOptions = {}
): Promise<{ target: string; copied: string[]; loader: LoaderReadiness | null }> {
  const env = readDeckEnv();
  const host = env.DECK_IP;
  const user = env.DECK_USER ?? "deck";
  if (!host) throw new Error("DECK_IP not configured — run deck.configure first");

  runPreDeployHook(pluginRoot);

  runWithRetry("plugin build", () => {
    proc.execSync("pnpm run build || npm run build", {
      cwd: pluginRoot,
      stdio: "inherit",
      shell: shellCmd(),
    });
  });

  const sources = listDeploySources(pluginRoot);
  // The Deck names ~/homebrew/plugins/<pluginName> from plugin.json, case
  // intact, and once decky loader has installed a plugin there once it owns
  // that directory as root. A plain scp as the deploy user cannot overwrite
  // it, so stage the upload somewhere the deploy user can always write, then
  // let a single elevated command move it into place.
  const targetDir = `~/homebrew/plugins/${pluginName}`;
  const tempDir = remoteDeployTempDir(pluginName);

  ensureRemoteDir(user, host, tempDir);

  runWithRetry("scp deploy", () => {
    execScpRecursive(pluginRoot, sources, `${user}@${host}:${tempDir}`);
  });

  moveDeployedPluginIntoPlace(user, host, tempDir, targetDir, pluginName);

  sshRestartLoader(user, host);

  // Return when the Deck is usable again, not when the restart was ISSUED.
  // Issue #3: every deck_openPlugin called straight after a deploy found the
  // loader still coming up and Steam's UI pages not yet listed, and paid for
  // it with two failed attempts. A deadline that passes is reported in
  // `loader`, not thrown -- the files are deployed either way.
  const loader =
    opts.waitForLoader === false
      ? null
      : await waitForLoaderReady(user, host, { timeoutMs: opts.loaderTimeoutMs, pollMs: opts.loaderPollMs });
  return { target: targetDir, copied: sources, loader };
}
