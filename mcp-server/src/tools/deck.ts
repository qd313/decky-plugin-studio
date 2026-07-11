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

let tunnelProcess: ReturnType<typeof spawn> | null = null;

export function getTunnelState() {
  return {
    running: tunnelProcess !== null && !tunnelProcess.killed,
    pid: tunnelProcess?.pid,
  };
}

export function startTunnel(): { pid?: number; skipped?: boolean; reason?: string } {
  const env = readDeckEnv();
  if (process.platform !== "win32" && fs.existsSync("/etc/os-release")) {
    const release = fs.readFileSync("/etc/os-release", "utf8");
    if (/ID=steamos|ID=bazzite/.test(release)) {
      return { skipped: true, reason: "local SteamOS host — loopback is direct" };
    }
  }
  if (tunnelProcess && !tunnelProcess.killed) {
    return { pid: tunnelProcess.pid };
  }

  const scriptsDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..", "scripts");
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
  try {
    if (process.platform === "win32") {
      execSync(`ping -n 1 -w 1000 ${host}`, { stdio: "ignore" });
    } else {
      execSync(`ping -c 1 -W 1 ${host}`, { stdio: "ignore" });
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

export async function captureScreenshot(mode: string): Promise<{ path: string; bytes?: number }> {
  const env = readDeckEnv();
  const workspace = process.cwd();
  const screenshotsDir = path.join(workspace, "screenshots");
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const outPath = path.join(screenshotsDir, `DeckCapture_${Date.now()}_${mode}.png`);

  const scriptsDir = path.join(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")),
    "..",
    "scripts"
  );
  const script = path.join(scriptsDir, "studio-capture.sh");
  const host = env.DECK_IP;
  const user = env.DECK_USER ?? "deck";

  if (!host) {
    throw new Error("DECK_IP not configured — run deck.configure first");
  }

  const MIN_BYTES = 51_200;
  let remotePath = "/tmp/deck_ui_capture.png";
  let captureStdout = "";

  if (fs.existsSync(script)) {
    captureStdout = execSync(
      `ssh ${user}@${host} "bash -s -- --mode ${mode}" < "${script}"`,
      {
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8",
        shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      }
    ) as string;
    const match = captureStdout.match(/---CAPTURE_RESULT---\s+mode=\S+\s+method=\S+\s+bytes=(\d+)\s+path=(\S+)/);
    if (match) {
      remotePath = match[2];
      const bytes = Number(match[1]);
      if (bytes < MIN_BYTES) {
        throw new Error(`Capture too small (${bytes} bytes) — is QAM/Steam running?`);
      }
    }
  }

  runWithRetry("scp screenshot", () => {
    execSync(`scp ${user}@${host}:"${remotePath}" "${outPath}"`, {
      stdio: "pipe",
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    });
  });

  const stat = fs.statSync(outPath);
  if (stat.size < MIN_BYTES) {
    throw new Error(`Downloaded capture too small (${stat.size} bytes)`);
  }
  return { path: outPath, bytes: stat.size };
}

export async function recordDeck(
  seconds: string,
  mode: string
): Promise<{ path?: string; error?: string }> {
  const env = readDeckEnv();
  const host = env.DECK_IP;
  const user = env.DECK_USER ?? "deck";
  if (!host) {
    return { error: "DECK_IP not configured — run deck.configure first" };
  }
  const recordingsDir = path.join(process.cwd(), "recordings");
  fs.mkdirSync(recordingsDir, { recursive: true });
  const outPath = path.join(recordingsDir, `DeckRecord_${Date.now()}.mkv`);
  const remoteOut = `/tmp/deck_record_${Date.now()}.mkv`;
  try {
    execSync(
      `ssh ${user}@${host} "ffmpeg -y -f kmsgrab -i - -t ${Number(seconds) || 10} -c:v libx264 ${remoteOut} 2>/dev/null || grim -o ${remoteOut} 2>/dev/null || true"`,
      { stdio: "pipe", shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh" }
    );
    execSync(`scp ${user}@${host}:"${remoteOut}" "${outPath}"`, {
      stdio: "pipe",
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    });
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 1024) {
      return { error: "Recording failed or empty — open QAM on Deck and retry" };
    }
    return { path: outPath };
  } catch (err) {
    return { error: String(err) };
  }
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
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
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
