import { execSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { readDeckEnv } from "../config.js";
import { listDeploySources } from "../deploy/copyManifest.js";
import {
  execScpRecursive,
  runPreDeployHook,
  runWithRetry,
  sshRestartLoader,
} from "../deploy/deployHelpers.js";
import {
  bundleDeckScript,
  capturePassesGate,
  cleanupRemote,
  downloadRemoteFile,
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

  const scriptsDir = path.join(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")),
    "..",
    "scripts"
  );
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
  return { pid: tunnelProcess.pid };
}

export function stopTunnel(): { stopped: boolean } {
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

export async function deployRemote(
  pluginRoot: string,
  pluginName: string
): Promise<{ target: string; copied: string[] }> {
  const env = readDeckEnv();
  const host = env.DECK_IP;
  const user = env.DECK_USER ?? "deck";
  if (!host) throw new Error("DECK_IP not configured — run deck.configure first");

  runPreDeployHook(pluginRoot);

  runWithRetry("plugin build", () => {
    execSync("pnpm run build || npm run build", {
      cwd: pluginRoot,
      stdio: "inherit",
      shell: shellCmd(),
    });
  });

  const sources = listDeploySources(pluginRoot);
  const remote = `${user}@${host}:~/homebrew/plugins/${pluginName}`;

  runWithRetry("scp deploy", () => {
    execScpRecursive(pluginRoot, sources, remote);
  });

  sshRestartLoader(user, host);
  return { target: remote, copied: sources };
}
