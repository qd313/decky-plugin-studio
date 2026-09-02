import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { getWorkspaceRoot } from "../config.js";

const RECORD_RESULT_RE =
  /---RECORD_RESULT---\s+mode=(\S+)\s+method=(\S+)\s+bytes=(\d+)\s+path=(\S+)\s+seconds=(\d+)\s+plugin_ui=(\S+)/;
const CAPTURE_RESULT_RE =
  /---CAPTURE_RESULT---\s+mode=(\S+)\s+method=(\S+)\s+bytes=(\d+)\s+path=(\S+)/;

const VALID_RECORD_METHODS = new Set(["pipewire-gamescope", "wf-recorder"]);
const COMPOSITED_CAPTURE_METHODS = new Set(["gamescope-atom", "grim", "pipewire-gamescope", "wf-recorder"]);

export type RecordResult = {
  path: string;
  bytes: number;
  mode: string;
  method: string;
  seconds: number;
  pluginUi: string;
};

export type CaptureResult = {
  path: string;
  bytes: number;
  mode: string;
  method: string;
};

/**
 * Where the capture scripts might live, tried in order.
 *
 * `getScriptsDir()` resolves relative to *this module's own file*, and that
 * file lives in a different place depending on how the server is running:
 *
 *  - compiled `dist/tools/captureOrchestrator.js` (a normal build, and the
 *    VSIX bundle, which mirrors the same shape) -- scripts are copied next
 *    to it at `dist/scripts` by `scripts/copy-scripts.mjs`.
 *  - source-tree `src/tools/captureOrchestrator.ts` under `tsx` (`npm run
 *    dev`, which this repo's own `mcp.json` points consumers at) -- there is
 *    no `src/scripts`; it was never created by any build step. The nearest
 *    real copy is `mcp-server/dist/scripts`, if a build has been run.
 *  - the same source tree with no build at all -- fall back to the
 *    monorepo's original `templates/scripts` at the repo root, which is what
 *    every copy is made from.
 */
function scriptsDirCandidates(): string[] {
  return scriptsDirCandidatesFrom(import.meta.url, process.env.DECKY_STUDIO_REPO);
}

/**
 * The candidate list for a module living at `moduleUrl`, resolved,
 * deduplicated and in search order. Pure, and exported so the path arithmetic
 * can be pinned against the exact URL shapes consumers run this server from.
 *
 * ISSUE #2 (bonsAI, 2026-08-30). This used to turn the module URL into a path
 * by hand: `new URL(url).pathname.replace(/^\/([A-Z]:)/, "$1")`. That regex
 * recognises only an UPPER-CASE drive letter. bonsAI's `.mcp.json` runs the
 * server as `node c:/Users/.../mcp-server/dist/index.js` -- lower-case, as
 * Windows paths are routinely written -- so the URL's pathname `/c:/Users/...`
 * kept its leading slash, `path.join` turned it into `\c:\Users\...`, and every
 * candidate was a path nothing could open. Both capture tools failed, and so
 * did `deck_installCaptureHelper`, the documented remedy, because it bundles
 * from the same directory -- there was no in-tool way out. `fileURLToPath` is
 * the real conversion: it handles either case, and percent-encoded characters
 * such as a space in a user name, which the regex never did. The compiled-
 * layout test never caught this because `pathToFileURL` on the machine it
 * runs on produces an upper-case drive letter.
 *
 * The first two candidates are the same directory when running from
 * `dist/tools` -- that was the "same path printed twice" in the report -- so
 * the list is deduplicated after resolution.
 *
 * `repoRoot` is `DECKY_STUDIO_REPO`, which every consumer's mcp.json already
 * sets. It names the DPS checkout independently of where this module happens
 * to be running from, so the `templates/scripts` fallback still works once
 * the module has been relocated (a VSIX bundle, a packed tarball) and the
 * relative arithmetic above no longer lands on the repo.
 */
export function scriptsDirCandidatesFrom(moduleUrl: string, repoRoot?: string): string[] {
  const here = path.dirname(fileURLToPath(moduleUrl));
  const raw = [
    path.join(here, "..", "scripts"),
    path.join(here, "..", "..", "dist", "scripts"),
    path.join(here, "..", "..", "..", "templates", "scripts"),
  ];
  if (repoRoot?.trim()) {
    raw.push(path.join(repoRoot.trim(), "templates", "scripts"));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of raw) {
    const resolved = path.resolve(candidate);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

/**
 * Pick the first candidate that actually contains a `deck` subdirectory, or
 * throw naming every location that was tried. Exported (separately from
 * {@link getScriptsDir}) so tests can exercise the search-and-report logic
 * against fabricated paths without needing to fake this module's own file
 * location.
 */
export function resolveScriptsDir(candidates: string[]): string {
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "deck"))) {
      return dir;
    }
  }
  throw new Error(
    `Could not find the capture scripts directory. Tried:\n${candidates
      .map((d) => `  - ${d}`)
      .join("\n")}`
  );
}

export function getScriptsDir(): string {
  return resolveScriptsDir(scriptsDirCandidates());
}

export function isLocalSteamOS(): boolean {
  if (process.platform === "win32") return false;
  try {
    if (fs.existsSync("/etc/os-release")) {
      const release = fs.readFileSync("/etc/os-release", "utf8");
      return /ID=steamos|ID=bazzite/.test(release);
    }
  } catch {
    /* ignore */
  }
  return false;
}

function normalizeDeckHost(host: string): string {
  return host.replace(/^.*@/, "").trim().toLowerCase();
}

export function isDeckLocal(host: string | undefined): boolean {
  if (!host) return isLocalSteamOS();
  const target = normalizeDeckHost(host);
  if (!target || target === "127.0.0.1" || target === "localhost") return true;
  if (isLocalSteamOS()) {
    try {
      const short = os.hostname().split(".")[0]?.toLowerCase();
      const long = os.hostname().toLowerCase();
      if (target === short || target === long || target === `${short}.local`) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function shellCmd(): string {
  return process.platform === "win32" ? "cmd.exe" : "/bin/sh";
}

function exec(cmd: string, opts: { encoding?: BufferEncoding; stdio?: "pipe" | "inherit" } = {}) {
  return execSync(cmd, {
    stdio: opts.stdio ?? "pipe",
    encoding: opts.encoding ?? "utf8",
    shell: shellCmd(),
  });
}

export function bundleDeckScript(mainScriptName: string): string {
  const deckDir = path.join(getScriptsDir(), "deck");
  const commonPath = path.join(deckDir, "studio-capture-common.sh");
  const mainPath = path.join(deckDir, mainScriptName);
  if (!fs.existsSync(commonPath) || !fs.existsSync(mainPath)) {
    throw new Error(`Missing capture scripts: ${commonPath} or ${mainPath}`);
  }
  const common = fs.readFileSync(commonPath, "utf8").replace(/\r\n/g, "\n");
  const main = fs.readFileSync(mainPath, "utf8").replace(/\r\n/g, "\n");
  const lines = main.split("\n");
  const body: string[] = [];
  let skip = false;
  let shebang = "#!/usr/bin/env bash";
  for (const line of lines) {
    if (line.startsWith("#!")) {
      shebang = line;
      continue;
    }
    if (/^\s*if \[ -z "\$\{STUDIO_CAPTURE_COMMON_LOADED/.test(line)) {
      skip = true;
      continue;
    }
    if (skip && /^\s*fi\s*$/.test(line)) {
      skip = false;
      continue;
    }
    if (skip) continue;
    body.push(line);
  }
  return `${shebang}\n${common}\nSTUDIO_CAPTURE_COMMON_LOADED=1\n${body.join("\n")}`;
}

function writeTempScript(content: string): string {
  const tmp = path.join(os.tmpdir(), `decky-studio-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(tmp, content, { encoding: "utf8" });
  return tmp;
}

export function steamosRwFlag(): string {
  const v =
    process.env.DECKY_STUDIO_ALLOW_STEAMOS_RW ??
    process.env.BONSAI_ALLOW_STEAMOS_RW ??
    "true";
  return v === "0" || v.toLowerCase() === "false" ? "--no-steamos-rw" : "";
}

export function runLocalBundledScript(
  bundle: string,
  remoteArgs: string
): { exitCode: number; resultText: string } {
  const tmp = writeTempScript(bundle);
  try {
    const out = exec(`sudo bash "${tmp}" ${remoteArgs}`, { encoding: "utf8" }) as string;
    return { exitCode: 0, resultText: out };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    const combined = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    return { exitCode: e.status ?? 1, resultText: combined };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

export function runRemoteBundledScript(
  user: string,
  host: string,
  bundle: string,
  remoteArgs: string,
  remoteScriptPath: string
): { exitCode: number; resultText: string } {
  const tmp = writeTempScript(bundle);
  const remoteResult = remoteArgs.includes("--result")
    ? remoteArgs.match(/--result\s+(\S+)/)?.[1]
    : undefined;
  try {
    exec(`ssh ${user}@${host} "sudo rm -f ${remoteScriptPath}"`, { stdio: "pipe" });
    exec(`scp "${tmp}" ${user}@${host}:${remoteScriptPath}`, { stdio: "pipe" });
    let exitCode = 0;
    let stdout = "";
    try {
      stdout = exec(`ssh ${user}@${host} "sudo bash ${remoteScriptPath} ${remoteArgs}"`, {
        encoding: "utf8",
      }) as string;
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      exitCode = e.status ?? 1;
      stdout = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    }
    let resultText = stdout;
    if (remoteResult) {
      const localResult = path.join(os.tmpdir(), `decky-result-${Date.now()}.txt`);
      try {
        exec(`scp ${user}@${host}:${remoteResult} "${localResult}"`, { stdio: "pipe" });
        if (fs.existsSync(localResult)) {
          resultText = fs.readFileSync(localResult, "utf8");
          fs.unlinkSync(localResult);
        }
      } catch {
        /* ignore */
      }
    }
    return { exitCode, resultText };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

export function parseRecordResult(text: string): Partial<RecordResult> {
  const m = text.match(RECORD_RESULT_RE);
  if (!m) return {};
  return {
    mode: m[1],
    method: m[2],
    bytes: Number(m[3]),
    path: m[4],
    seconds: Number(m[5]),
    pluginUi: m[6],
  };
}

export function parseCaptureResult(text: string): Partial<CaptureResult> {
  const m = text.match(CAPTURE_RESULT_RE);
  if (!m) return {};
  return {
    mode: m[1],
    method: m[2],
    bytes: Number(m[3]),
    path: m[4],
  };
}

export function recordPassesGate(
  parsed: Partial<RecordResult>,
  quality: string,
  allowNonPluginUi: boolean
): boolean {
  const minBytes = quality === "full" ? 524_288 : 100_000;
  if (!parsed.method || !parsed.bytes) return false;
  if (!allowNonPluginUi) {
    if (parsed.pluginUi === "no") return false;
    if (!VALID_RECORD_METHODS.has(parsed.method)) return false;
  }
  return parsed.bytes >= minBytes;
}

export function capturePassesGate(
  parsed: Partial<CaptureResult>,
  allowNonPluginUi: boolean
): boolean {
  const minBytes = 51_200;
  if (!parsed.method || !parsed.bytes) return false;
  if (!allowNonPluginUi && parsed.method === "kmsgrab") return false;
  if (!allowNonPluginUi && !COMPOSITED_CAPTURE_METHODS.has(parsed.method) && parsed.method !== "failed") {
    if (parsed.method === "kmsgrab") return false;
  }
  return parsed.bytes >= minBytes;
}

export function downloadRemoteFile(user: string, host: string, remotePath: string, localPath: string): void {
  exec(`scp ${user}@${host}:"${remotePath}" "${localPath}"`, { stdio: "pipe" });
}

export function cleanupRemote(
  user: string,
  host: string,
  paths: string[]
): void {
  const list = paths.join(" ");
  try {
    exec(`ssh ${user}@${host} "sudo rm -f ${list}"`, { stdio: "pipe" });
  } catch {
    /* ignore */
  }
}

export function installCaptureHelperOnDeck(
  user: string,
  host: string,
  helperName: string,
  mainScriptName: string
): { installed: string } {
  const bundle = bundleDeckScript(mainScriptName);
  const tmp = writeTempScript(bundle);
  try {
    exec(`ssh ${user}@${host} "mkdir -p ~/.local/bin"`, { stdio: "pipe" });
    exec(`scp "${tmp}" ${user}@${host}:~/.local/bin/${helperName}`, { stdio: "pipe" });
    exec(`ssh ${user}@${host} "chmod +x ~/.local/bin/${helperName}"`, { stdio: "pipe" });
    return { installed: `~/.local/bin/${helperName}` };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

export function getWorkspaceArtifactsDir(subdir: "recordings" | "screenshots" | "runs"): string {
  const dir = path.join(getWorkspaceRoot(), subdir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
