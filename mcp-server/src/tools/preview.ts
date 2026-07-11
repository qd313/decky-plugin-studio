import fs from "fs";
import path from "path";
import {
  getPreviewServerRoot,
  getRepoRoot,
  getWorkspaceRoot,
  readPreviewState,
} from "../config.js";
import { loadPreviewConfig } from "../preview/previewConfig.js";
import { isPreviewRpcAllowed } from "../preview/rpcAllowlist.js";
import { syncRpcAllowlistToSandbox } from "../preview/syncRpcAllowlist.js";
import { sendPreviewCommand, waitPreviewResult } from "../preview/ipc.js";
import {
  previewHealth,
  previewCallTestHook,
  previewSetPermissions,
} from "./previewHealth.js";

export { previewHealth, previewCallTestHook, previewSetPermissions };

let previewRunning = false;
let previewUrl = "";
let hwState: Record<string, unknown> = {
  preset: "Idle",
  cpuTemp: 42,
  gpuTemp: 38,
  battery: 87,
  fanRpm: 1800,
  tdp: 8,
  cpuClock: 1400,
  acPlugged: true,
  dock: false,
};

function ipcTimeout(workspace?: string): number {
  return loadPreviewConfig(workspace).ipcTimeoutMs;
}

function syncPreviewUrlFromState(): void {
  const state = readPreviewState();
  if (state.url) previewUrl = state.url;
}

export function previewStart(): { running: boolean; url?: string; rpcAllowlist?: unknown } {
  previewRunning = true;
  syncPreviewUrlFromState();
  previewUrl = previewUrl || process.env.DECKY_PREVIEW_URL || "http://127.0.0.1:5173";
  const rpcSnap = syncRpcAllowlistToSandbox(getWorkspaceRoot());
  return { running: true, url: previewUrl, rpcAllowlist: rpcSnap };
}

export function previewStop(): { running: boolean } {
  previewRunning = false;
  previewUrl = "";
  return { running: false };
}

export function previewStatus() {
  syncPreviewUrlFromState();
  return { running: previewRunning, url: previewUrl, hwState };
}

async function postHwStateToPreview(state: Record<string, unknown>): Promise<void> {
  syncPreviewUrlFromState();
  if (!previewUrl) return;
  try {
    await fetch(`${previewUrl}/api/hw-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* preview server may not be running */
  }
}

export async function previewSetHardware(state: Record<string, unknown>) {
  hwState = { ...hwState, ...state };
  const hwFile = path.join(getPreviewServerRoot(), ".hw-state.json");
  fs.mkdirSync(path.dirname(hwFile), { recursive: true });
  fs.writeFileSync(hwFile, JSON.stringify(hwState), "utf8");
  await postHwStateToPreview(hwState);
  return { hwState };
}

export function previewInjectFocusEvent(direction: string) {
  const id = sendPreviewCommand({ cmd: "injectFocus", direction });
  return { injected: direction, id, note: "Queued for live preview via IPC" };
}

export async function previewCallRpc(method: string, args: unknown[] = []) {
  const workspace = getWorkspaceRoot();
  if (!isPreviewRpcAllowed(method, workspace)) {
    return { error: `RPC method not allowlisted for preview: ${method}` };
  }
  const id = sendPreviewCommand({ cmd: "callRpc", method, args });
  try {
    const response = (await waitPreviewResult(id, ipcTimeout(workspace))) as {
      ok: boolean;
      result?: unknown;
      error?: string;
    };
    if (!response.ok) {
      return { error: response.error ?? "Preview callRpc failed" };
    }
    return { result: response.result };
  } catch (err) {
    return { error: String(err) };
  }
}

export function previewReadLog(lines = 50): { lines: string[] } {
  const sandboxRoot =
    process.env.DECKY_SANDBOX_ROOT ??
    path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".decky-plugin-studio",
      "sandbox",
      path.basename(getWorkspaceRoot())
    );
  const logPath = path.join(sandboxRoot, "plugin.log");
  if (!fs.existsSync(logPath)) return { lines: [] };
  const all = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  return { lines: all.slice(-lines) };
}

export async function previewRunSequence(args: {
  inputs: string[];
  delayMs?: number;
  hwOverrides?: Record<string, unknown>;
  snapshot?: "dom" | "screenshot" | "both";
}) {
  if (args.hwOverrides) await previewSetHardware(args.hwOverrides);
  const id = sendPreviewCommand({
    cmd: "runSequence",
    inputs: args.inputs,
    delayMs: args.delayMs ?? 80,
  });
  try {
    const response = (await waitPreviewResult(id, ipcTimeout())) as {
      ok: boolean;
      result?: {
        focusPath: string[];
        activeElement: string;
        domSnapshot: string;
      };
      error?: string;
    };
    if (!response.ok || !response.result) {
      throw new Error(response.error ?? "Preview runSequence failed");
    }
    return {
      focusPath: response.result.focusPath,
      activeElement: response.result.activeElement,
      domSnapshot: args.snapshot === "screenshot" ? undefined : response.result.domSnapshot,
      logTail: previewReadLog(8).lines,
    };
  } catch (err) {
    return {
      focusPath: args.inputs,
      activeElement: "preview-not-running",
      domSnapshot: `<div data-error="${String(err).replace(/"/g, "&quot;")}"></div>`,
      logTail: previewReadLog(8).lines,
      error: String(err),
    };
  }
}

export async function previewSnapshotDom(params: {
  selector?: string;
  attrs?: string[];
  text?: string;
}) {
  const id = sendPreviewCommand({
    cmd: "snapshotDom",
    selector: params.selector,
    args: [params.attrs ?? [], params.text ?? ""],
  });
  try {
    const response = (await waitPreviewResult(id, ipcTimeout())) as {
      ok: boolean;
      result?: {
        html: string;
        activeElement: string;
        matches?: Array<{ selector: string; found: boolean; text?: string }>;
      };
      error?: string;
    };
    if (!response.ok || !response.result) {
      return { error: response.error ?? "snapshotDom failed" };
    }
    return response.result;
  } catch (err) {
    return { error: String(err) };
  }
}

export async function previewCaptureScreenshot(params: { selector?: string } = {}) {
  const workspace = getWorkspaceRoot();
  const outDir = path.join(workspace, "screenshots", "preview");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `PreviewCapture_${Date.now()}.png`);

  const id = sendPreviewCommand({
    cmd: "captureScreenshot",
    selector: params.selector,
  });
  try {
    const response = (await waitPreviewResult(id, ipcTimeout(workspace))) as {
      ok: boolean;
      result?: { pngBase64?: string; htmlFallback?: string };
      error?: string;
    };
    if (!response.ok || !response.result) {
      return { error: response.error ?? "captureScreenshot failed", path: outPath };
    }
    if (response.result.pngBase64) {
      fs.writeFileSync(outPath, Buffer.from(response.result.pngBase64, "base64"));
    } else if (response.result.htmlFallback) {
      const htmlPath = outPath.replace(/\.png$/, ".html");
      fs.writeFileSync(htmlPath, response.result.htmlFallback, "utf8");
      return { path: htmlPath, note: "PNG unavailable; wrote HTML fallback" };
    }
    return { path: outPath };
  } catch (err) {
    return { error: String(err), path: outPath };
  }
}

export async function previewSetHttpAllow(allowlist: string) {
  const configPath = path.join(getRepoRoot(), "preview-http-allow.json");
  fs.writeFileSync(configPath, JSON.stringify({ allowlist }), "utf8");
  return { allowlist };
}
