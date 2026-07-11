import fs from "fs";
import path from "path";
import { getWorkspaceRoot, readPreviewState } from "../config.js";
import { loadPreviewConfig } from "../preview/previewConfig.js";
import { sendPreviewCommand, waitPreviewResult, getPreviewIpcDir } from "../preview/ipc.js";

export function previewHealth(): {
  ok: boolean;
  previewOpen: boolean;
  ipcDir: string;
  issues: string[];
} {
  const issues: string[] = [];
  const state = readPreviewState();
  const previewOpen = Boolean(state.url && state.workspaceRoot);
  if (!previewOpen) {
    issues.push("Preview not open — run Decky: Open Preview");
  }
  const ipcDir = getPreviewIpcDir();
  if (!fs.existsSync(ipcDir)) {
    issues.push("IPC directory missing");
  }
  return { ok: issues.length === 0, previewOpen, ipcDir, issues };
}

export async function previewCallTestHook(method: string, args: unknown[] = []) {
  const workspace = getWorkspaceRoot();
  const { ipcTimeoutMs } = loadPreviewConfig(workspace);
  const health = previewHealth();
  if (!health.ok) {
    return { error: health.issues.join("; ") };
  }
  const id = sendPreviewCommand({ cmd: "callTestHook", method, args });
  try {
    const response = (await waitPreviewResult(id, ipcTimeoutMs)) as {
      ok: boolean;
      result?: unknown;
      error?: string;
    };
    if (!response.ok) {
      return { error: response.error ?? "callTestHook failed" };
    }
    return { result: response.result };
  } catch (err) {
    return { error: String(err) };
  }
}

export async function previewSetPermissions(permissions: Record<string, boolean>) {
  const state = readPreviewState();
  if (!state.url) {
    return { error: "Preview not running" };
  }
  try {
    const res = await fetch(`${state.url}/api/permissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(permissions),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as { permissions: Record<string, boolean> };
    return { permissions: body.permissions };
  } catch (err) {
    return { error: String(err) };
  }
}
