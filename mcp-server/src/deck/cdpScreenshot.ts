/**
 * A picture from a Windows stand-in, taken over CDP.
 *
 * The capture shell scripts need gamescope or a Wayland compositor, which a
 * Windows machine running Big Picture does not have. Steam's CEF debugger is
 * already open on the machine's cdpPort though, and Chrome's
 * Page.captureScreenshot needs no compositor, no SSH and no script.
 *
 * Method 1 "cdp": Page.captureScreenshot on the "Steam Big Picture Mode" page.
 * Method 2 "window-grab": a PowerShell CopyFromScreen of that window's rect,
 * used only when method 1 failed. If both fail the error names both attempts.
 * The Quick Access page is NOT composited in: its presence is noted only.
 */
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { listTargets, rewriteWsHost, CdpTarget } from "./cdp.js";
import { MiniWebSocket } from "./ws.js";
import { openCdpTunnel } from "./cdpTunnel.js";

export const BIG_PICTURE_TITLE = "Steam Big Picture Mode";

export interface StandinShot {
  path: string;
  bytes: number;
  method: "cdp" | "window-grab";
  /** Did a QuickAccess_* page answer a capture too? Informational only; its pixels are not used. */
  quickAccessPagePresent: boolean;
}

export interface StandinShotOptions {
  outPath: string;
  /** CDP base URL. Omit to open the machine's tunnel (or its local port). */
  cdpUrl?: string;
  timeoutMs?: number;
  /** Seam for the PowerShell fallback; tests stub it. Must write a PNG to `outPath`. */
  grabWindow?: (outPath: string) => void;
}

/** Send one CDP command and return its result object. */
export async function cdpCommand(
  wsUrl: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const ws = await MiniWebSocket.connect(wsUrl, { timeoutMs });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs);
      ws.onClose((reason) => {
        clearTimeout(timer);
        reject(new Error(`connection closed before a reply: ${reason}`));
      });
      ws.onMessage((text) => {
        let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (msg.id !== 1) return;
        clearTimeout(timer);
        if (msg.error) reject(new Error(`CDP error: ${msg.error.message ?? "unknown"}`));
        else resolve(msg.result ?? {});
      });
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    ws.close();
  }
}

async function captureViaCdp(base: string, outPath: string, timeoutMs: number): Promise<{ qam: boolean }> {
  const targets: CdpTarget[] = await listTargets(base, timeoutMs);
  const titles = targets.map((t) => t.title ?? "(untitled)");
  const bp = targets.find((t) => t.title === BIG_PICTURE_TITLE && t.webSocketDebuggerUrl);
  if (!bp) throw new Error(`no "${BIG_PICTURE_TITLE}" page in the CDP list (saw: ${titles.join(", ") || "none"})`);
  const res = await cdpCommand(
    rewriteWsHost(bp.webSocketDebuggerUrl!, base),
    "Page.captureScreenshot",
    { format: "png" },
    timeoutMs,
  );
  const data = typeof res.data === "string" ? res.data : "";
  if (!data) throw new Error("Page.captureScreenshot returned no image data");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(data, "base64"));

  let qam = false;
  const q = targets.find((t) => (t.title ?? "").startsWith("QuickAccess_") && t.webSocketDebuggerUrl);
  if (q) {
    try {
      const r = await cdpCommand(
        rewriteWsHost(q.webSocketDebuggerUrl!, base),
        "Page.captureScreenshot",
        { format: "png" },
        Math.min(timeoutMs, 4000),
      );
      qam = typeof r.data === "string" && r.data.length > 0;
    } catch {
      qam = false;
    }
  }
  return { qam };
}

function defaultGrabWindow(scriptPath: string): (outPath: string) => void {
  return (outPath) => {
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Out", outPath], {
      stdio: "pipe",
      timeout: 20_000,
    });
  };
}

export async function captureStandinWindows(
  opts: StandinShotOptions,
  grabScriptPath?: () => string,
): Promise<StandinShot> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let cdpError: string;
  try {
    let base = opts.cdpUrl;
    let close: (() => void) | undefined;
    if (!base) {
      const t = await openCdpTunnel();
      base = t.base;
      close = t.close;
    }
    try {
      const { qam } = await captureViaCdp(base, opts.outPath, timeoutMs);
      return { path: opts.outPath, bytes: fs.statSync(opts.outPath).size, method: "cdp", quickAccessPagePresent: qam };
    } finally {
      close?.();
    }
  } catch (err) {
    cdpError = (err as Error).message;
  }

  let grabError: string;
  try {
    const grab = opts.grabWindow ?? defaultGrabWindow(grabScriptPath ? grabScriptPath() : "");
    grab(opts.outPath);
    if (!fs.existsSync(opts.outPath)) throw new Error("the grab script finished but wrote no file");
    return { path: opts.outPath, bytes: fs.statSync(opts.outPath).size, method: "window-grab", quickAccessPagePresent: false };
  } catch (err) {
    grabError = (err as Error).message;
  }
  throw new Error(
    `Screenshot failed on the Windows stand-in. Tried (1) CDP Page.captureScreenshot: ${cdpError}. ` +
      `Tried (2) PowerShell window grab: ${grabError}. ` +
      "Check that Big Picture is open and not minimised, and that Steam's CEF debugger is reachable.",
  );
}
